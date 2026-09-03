/**
 * The app registry (framework section 5.6): a user-level index of known Agent
 * Apps, so an agent can answer "which apps exist, which are running, on what
 * port?" without being handed every directory.
 *
 * Design rules this file enforces:
 *  - It is an INDEX, not a source of truth. Each app's `manifest.json` is
 *    authoritative for identity; a disagreeing entry is stale and gets corrected
 *    from the manifest, never the reverse. Losing the registry loses convenience,
 *    never an app.
 *  - STATUS IS DERIVED, never stored — and derived by asking the app WHO IT IS,
 *    not merely whether the port answers. Any process can hold a port; only the
 *    app can return its own id.
 *  - An unreadable registry is PRESERVED, never silently discarded: a corrupt
 *    file is set aside and reported, because overwriting it destroys the user's
 *    whole index without warning.
 *  - Every read-modify-write runs under a cross-process lock. Each `agent-app` run is
 *    its own process, so concurrent commands would otherwise lose entries and
 *    hand two apps the same port.
 *  - Identity and location only. Host concerns (theme, icon, sessions, tunnels)
 *    stay with the host, or the registry stops being harness-agnostic.
 */
import { createConnection } from "node:net";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homePath, REGISTRY_FILE, writeFileAtomic } from "./home.js";
import { withHomeLock } from "./lock.js";
import { log } from "./log.js";

export const REGISTRY_VERSION = 1;

export interface RegistryEntry {
  id: string;
  name: string;
  /** absolute path to the app directory */
  path: string;
  port?: number;
  /** toolkit id it was scaffolded from, when any */
  blueprint?: string;
  createdAt?: string;
}

export interface Registry {
  version: number;
  apps: RegistryEntry[];
}

/**
 * Derived at read time — never persisted.
 *  running     — the app answered on its port AND identified as itself
 *  stopped     — nothing is listening
 *  unreachable — something holds the port but it is not this app
 *  missing     — the directory no longer holds an Agent App
 */
export type AppStatus = "running" | "stopped" | "unreachable" | "missing";

export interface AppView extends RegistryEntry {
  status: AppStatus;
  url: string | null;
  /** pid recorded by `serve`, when the app is running */
  pid: number | null;
}

export function registryPath(): string {
  return homePath(REGISTRY_FILE);
}

/**
 * Read the registry. A corrupt file is moved aside (never deleted, never
 * silently emptied) and reported, so a mangled byte cannot cost the user their
 * whole index.
 */
export function readRegistry(): Registry {
  const file = registryPath();
  if (!existsSync(file)) return { version: REGISTRY_VERSION, apps: [] };
  // Retry transient sharing errors: on Windows a concurrent writer's rename
  // briefly makes the file unopenable. That is not corruption, and must never be
  // treated as such — misreading it would set the user's index aside for nothing.
  let raw = "";
  let readError: unknown = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      raw = readFileSync(file, "utf8");
      readError = null;
      break;
    } catch (err) {
      readError = err;
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return { version: REGISTRY_VERSION, apps: [] };
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + attempt * 10);
    }
  }
  if (readError !== null) {
    throw new Error(`cannot read the app registry at ${file}: ${(readError as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Registry>;
    if (!Array.isArray(parsed.apps)) throw new Error("missing an `apps` array");
    return { version: REGISTRY_VERSION, apps: parsed.apps.filter(isEntry) };
  } catch (err) {
    const kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    // Retry the set-aside on Windows sharing errors, the same way the read path
    // does: a transient EPERM/EBUSY must not cost the user their corrupt file,
    // which is the only copy of their index and may be hand-recoverable.
    let setAside = false;
    let renameErr: unknown = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        renameSync(file, kept);
        setAside = true;
        break;
      } catch (e) {
        renameErr = e;
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + attempt * 10);
      }
    }
    if (setAside) {
      log.error(
        `the app registry was unreadable (${(err as Error).message}) — kept it at ${kept} and started a new one. ` +
          `Apps are unaffected: re-register one with \`agent-app <dir> serve\`.`,
      );
    } else {
      // Could NOT set it aside — do NOT overwrite the corrupt file. Surface the
      // fault so the user's only index copy is preserved for manual recovery.
      throw new Error(
        `the app registry at ${file} is unreadable (${(err as Error).message}) and could not be set aside ` +
          `(${(renameErr as Error)?.message ?? "unknown"}). Left it untouched — move or repair it, then retry.`,
      );
    }
    return { version: REGISTRY_VERSION, apps: [] };
  }
}

function isEntry(v: unknown): v is RegistryEntry {
  const e = v as RegistryEntry | null;
  return !!e && typeof e.id === "string" && typeof e.name === "string" && typeof e.path === "string";
}

function writeRegistry(reg: Registry): void {
  const sorted = [...reg.apps].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  writeFileAtomic(registryPath(), JSON.stringify({ version: REGISTRY_VERSION, apps: sorted }, null, 2) + "\n");
}

/** Read-modify-write the registry under the cross-process lock. */
async function mutate<T>(fn: (reg: Registry) => T): Promise<T> {
  return withHomeLock(() => {
    const reg = readRegistry();
    const result = fn(reg);
    writeRegistry(reg);
    return result;
  });
}

/**
 * Register an app, or update it in place. Keyed by absolute path: the same
 * directory is one app however many times it is registered, so re-running
 * `scaffold`/`serve` never duplicates an entry.
 */
export async function register(entry: RegistryEntry): Promise<void> {
  const path = resolve(entry.path);
  await mutate((reg) => {
    const at = reg.apps.findIndex((a) => resolve(a.path) === path);
    const merged: RegistryEntry = { ...(at >= 0 ? reg.apps[at] : {}), ...entry, path };
    if (at >= 0) reg.apps[at] = merged;
    else reg.apps.push(merged);
  });
}

/** Forget an app (the app directory itself is never touched). */
export async function unregister(pathOrId: string): Promise<boolean> {
  const target = resolve(pathOrId);
  return mutate((reg) => {
    const before = reg.apps.length;
    reg.apps = reg.apps.filter((a) => resolve(a.path) !== target && a.id !== pathOrId);
    return reg.apps.length !== before;
  });
}

/** Raised when a name matches more than one app: never guess which. */
export class AmbiguousAppError extends Error {
  constructor(
    readonly query: string,
    readonly matches: RegistryEntry[],
  ) {
    super(
      `"${query}" matches ${matches.length} registered apps — pass an id or a path instead: ` +
        matches.map((m) => `${m.id} (${m.path})`).join(", "),
    );
    this.name = "AmbiguousAppError";
  }
}

/**
 * Look up a registered app by id, then by exact name, then by path.
 * A multi-match name throws rather than picking one.
 */
export function find(idOrNameOrPath: string): RegistryEntry | null {
  const reg = readRegistry();
  const byId = reg.apps.find((a) => a.id === idOrNameOrPath);
  if (byId) return byId;
  const byName = reg.apps.filter((a) => a.name === idOrNameOrPath);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new AmbiguousAppError(idOrNameOrPath, byName);
  const target = resolve(idOrNameOrPath);
  return reg.apps.find((a) => resolve(a.path) === target) ?? null;
}

/* ------------------------------------------------------------ liveness */

/** Is something accepting connections on this local port? */
export function portInUse(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (inUse: boolean): void => {
      socket.destroy();
      res(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Ask whoever holds the port to identify itself. Returns the A2App app id, or
 * null when the responder is not an Agent App. This is what separates "my app is
 * running" from "some other process took the port".
 */
async function identify(port: number, timeoutMs = 1500): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/_a2app`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { a2app?: boolean; app?: { id?: string } };
    if (body?.a2app !== true) return null;
    return typeof body.app?.id === "string" ? body.app.id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The `serve` record for an app, when one was written. */
function serveRecord(appDir: string): { pid: number; port: number; url: string } | null {
  const file = join(appDir, ".a2app", "serve.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { pid: number; port: number; url: string };
  } catch {
    return null;
  }
}

/** The app's own manifest, when readable — authoritative over the entry. */
function manifestOf(appDir: string): { id?: string; name?: string; port?: number } | null {
  const file = join(appDir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { id?: string; name?: string; port?: number };
  } catch {
    return null;
  }
}

/**
 * Resolve one entry to a live view: identity refreshed from the app's own
 * manifest, status established by asking the port who it is.
 */
export async function view(entry: RegistryEntry): Promise<AppView> {
  const dir = resolve(entry.path);
  if (!existsSync(join(dir, "manifest.json"))) {
    return { ...entry, status: "missing", url: null, pid: null };
  }
  const manifest = manifestOf(dir);
  const port = manifest?.port ?? entry.port;
  const fresh: RegistryEntry = {
    ...entry,
    id: manifest?.id ?? entry.id,
    name: manifest?.name ?? entry.name,
    ...(port !== undefined ? { port } : {}),
  };
  if (port === undefined || !(await portInUse(port))) {
    return { ...fresh, status: "stopped", url: null, pid: null };
  }
  // Something holds the port — is it this app, or a stranger?
  const servingId = await identify(port);
  if (servingId === null || servingId !== fresh.id) {
    return { ...fresh, status: "unreachable", url: null, pid: null };
  }
  return {
    ...fresh,
    status: "running",
    url: `http://127.0.0.1:${port}`,
    pid: serveRecord(dir)?.pid ?? null,
  };
}

/** Every known app, resolved. Probes run concurrently. */
export async function list(): Promise<AppView[]> {
  return Promise.all(readRegistry().apps.map(view));
}

/** Drop entries whose directory no longer holds an Agent App. Returns them. */
export async function prune(): Promise<RegistryEntry[]> {
  return mutate((reg) => {
    const here = (a: RegistryEntry): boolean => existsSync(join(resolve(a.path), "manifest.json"));
    const gone = reg.apps.filter((a) => !here(a));
    reg.apps = reg.apps.filter(here);
    return gone;
  });
}

/* --------------------------------------------------------- port assignment */

const PORT_FLOOR = 8090;
const PORT_CEILING = 8999;

function validPort(p: number | undefined): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * Probe for a port that no registered app claims and nothing is listening on.
 * This performs network I/O (a TCP connect per candidate) and so runs OUTSIDE
 * the home lock: holding the lock across hundreds of 300ms probes would serialize
 * every registry mutation on the machine and make live locks look stale. The
 * caller re-checks the winning port under the lock before claiming it.
 */
async function probeFreePort(reg: Registry, ownPath: string, preferred?: number): Promise<number> {
  const claimed = new Set(
    reg.apps
      .filter((a) => resolve(a.path) !== ownPath)
      .map((a) => a.port)
      .filter((p): p is number => validPort(p)),
  );
  const candidates: number[] = [];
  if (validPort(preferred)) candidates.push(preferred);
  for (let p = PORT_FLOOR; p <= PORT_CEILING; p++) candidates.push(p);
  for (const port of candidates) {
    if (claimed.has(port)) continue;
    if (await portInUse(port)) continue;
    return port;
  }
  throw new Error(`no free port available in ${PORT_FLOOR}-${PORT_CEILING}`);
}

/**
 * Pick a free port and claim it by writing the entry. The pick (network probing)
 * happens outside the lock; the claim (an in-memory registry check + write)
 * happens inside it. If another process claimed the probed port in the gap, the
 * locked check catches it and we re-probe — so choosing and claiming are still
 * effectively atomic (no two apps get the same port) without holding the lock
 * across network I/O.
 */
export async function reserveApp(entry: RegistryEntry, preferred?: number): Promise<number> {
  const path = resolve(entry.path);
  for (let round = 0; round < 64; round++) {
    const port = await probeFreePort(readRegistry(), path, preferred);
    const claimed = await withHomeLock(() => {
      const reg = readRegistry();
      const takenByOther = reg.apps.some((a) => resolve(a.path) !== path && a.port === port);
      if (takenByOther) return false; // lost the race between probe and lock — re-probe
      const at = reg.apps.findIndex((a) => resolve(a.path) === path);
      const merged: RegistryEntry = { ...(at >= 0 ? reg.apps[at] : {}), ...entry, path, port };
      if (at >= 0) reg.apps[at] = merged;
      else reg.apps.push(merged);
      writeRegistry(reg);
      return true;
    });
    if (claimed) return port;
  }
  throw new Error("could not reserve a free port after repeated contention — retry `agent-app scaffold`");
}
