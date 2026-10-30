/**
 * The install pipeline (framework packaging §4): one path for every source, so
 * an app installed from OpenClaw, Hermes, CraftBot, Claude Code or a terminal
 * arrives in exactly the same state.
 *
 *   acquire → inspect → sanitize → revendor → customize    (in staging)
 *   → place → register → dependencies → gate → serve → open (in the app's home)
 *
 * Everything up to customize happens in a staging directory that is always
 * removed, so a refusal there leaves no trace. From place on, what has been
 * done is tracked and undone if a later step fails — the app is unregistered,
 * and its folder removed (or, for an in-place import, put back exactly as it
 * was). The one exception is the gate: an app that fails it stays installed so
 * it can be fixed, and the result says so.
 *
 * Nothing from the package runs before the dependencies step, and what runs
 * from then on is the TRUSTED toolkit's pipeline: revendor replaces the
 * package's system files and merges the toolkit's `pipeline` into its manifest.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openUrl } from "../commands/open.js";
import { serveApp } from "../commands/serve.js";
import { stopServed } from "../commands/stop.js";
import { validateApp, type ValidateOutcome } from "../commands/validate.js";
import { writeSystemHashes } from "./canon.js";
import { mintAgentToken } from "./credential.js";
import { appCommand } from "./delivery.js";
import { assertRealInside, copyTree } from "./fsx.js";
import { runAccessGate, runBudgetGate, type GateError, type GateUnchecked } from "./gate.js";
import { homePath, writeFileAtomic } from "./home.js";
import { inspectStaged, type InspectReport } from "./inspect.js";
import { readJsonFile } from "./json.js";
import { linkLocalPackages } from "./localPackages.js";
import { log } from "./log.js";
import { mergeManifest, type Manifestish } from "./manifest.js";
import { IDENTITY_TOKENS, PORT_TOKENS, slugify, substitutePlaceholders, systemFiles, type Substituted } from "./package.js";
import { exitCodeOf, PackageRefusedError } from "./packageErrors.js";
import { loadProject, UsageError } from "./project.js";
import { pickFreePort, readRegistry, register as registerEntry, reserveApp, unregister, type RegistryEntry } from "./registry.js";
import { ensureIgnoreRules, writeHarnessGuides } from "./scaffoldFiles.js";
import { runShell } from "./shell.js";
import { acquire, createStaging, parseFrom, removeStaging, type Provenance, type Request } from "./sources.js";
import { adapterVersionOf, recordProjectToolkit, vendorPaths, type ResolvedToolkit } from "./toolkit.js";

export const STEPS = [
  "acquire",
  "inspect",
  "sanitize",
  "revendor",
  "customize",
  "place",
  "register",
  "dependencies",
  "gate",
  "serve",
  "open",
] as const;
export type Step = (typeof STEPS)[number];

/** What is still owed once an install succeeds (§4): nothing for a marketplace app, walk-verify for anything else. */
export type Trust = "catalogued" | "untrusted";

export interface InstallOptions {
  request: Request;
  /** `--into`: the folder to install into (absent or empty) */
  into?: string;
  name?: string;
  port?: number;
  blueprint?: string;
  /** `--set KEY=VALUE` */
  set: Map<string, string>;
  /** false with `--no-start`: install the files only, and leave dependencies, the build and serve to `serve --install` */
  start: boolean;
  open: boolean;
  /** `--events`: one JSON object per line on stdout instead of one result */
  events: boolean;
}

/* ---------------------------------------------------------------- progress */

class StepFailed extends Error {
  constructor(
    readonly step: Step,
    readonly error: unknown,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "StepFailed";
  }
}

/** A refusal at inspect, carrying the report so the result can say what the tree is and where to take it. */
class NotInstallable extends PackageRefusedError {
  constructor(readonly report: InspectReport) {
    super(report.reason ?? "not installable");
    this.name = "NotInstallable";
  }
}

/**
 * Step reporting. With `--events`, stdout carries only JSON lines (§8): one
 * `step` line as each step starts and ends, and the `result` line last. Without
 * it, stdout carries the one result document. Progress for people always goes
 * to stderr.
 */
class Progress {
  constructor(private readonly events: boolean) {}

  private emit(line: Record<string, unknown>): void {
    if (this.events) process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  start(step: Step): void {
    this.emit({ event: "step", step, status: "start" });
    log.step(step);
  }

  done(step: Step, detail: Record<string, unknown> = {}): void {
    this.emit({ event: "step", step, status: "done", ...detail });
  }

  failed(step: Step, detail: Record<string, unknown>): void {
    this.emit({ event: "step", step, status: "failed", ...detail });
  }

  /** A step that does not run on this install: said once, so a UI can show every step's outcome. */
  skipped(step: Step, reason: string): void {
    this.emit({ event: "step", step, status: "skipped", reason });
    log.info(`${step}: skipped — ${reason}`);
  }

  async run<T>(step: Step, fn: () => T | Promise<T>, detail?: (value: T) => Record<string, unknown>): Promise<T> {
    this.start(step);
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      this.failed(step, { error: err instanceof Error ? err.message : String(err) });
      throw new StepFailed(step, err);
    }
    this.done(step, detail?.(value) ?? {});
    return value;
  }

  result(result: Record<string, unknown>): void {
    if (this.events) this.emit({ event: "result", ...result });
    else log.raw(JSON.stringify(result, null, 2));
  }
}

/* ------------------------------------------------------------------- moves */

let counter = 0;
const suffix = (): string => `${process.pid}-${counter++}-${randomBytes(2).toString("hex")}`;

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Block this thread briefly without spinning the CPU. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename, retrying the sharing errors Windows raises while a scanner or indexer briefly holds a fresh file. */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code) || attempt >= 10 || existsSync(to)) throw err;
      pause(20 + attempt * 20);
    }
  }
}

/**
 * Move a folder to a path that does not exist: one rename where the filesystem
 * allows it; across filesystems, a copy to a sibling of the target and then a
 * rename, so the target never exists half-written.
 */
function moveDir(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameRetrying(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  const partial = `${dest}.partial-${suffix()}`;
  try {
    copyTree(src, partial);
    renameRetrying(partial, dest);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  rmSync(src, { recursive: true, force: true });
}

/** Where an installed app's folder is, and how to undo putting it there. */
type Placement =
  | { kind: "new"; dir: string; wasEmptyFolder: boolean }
  | { kind: "in-place"; dir: string; previous: string };

/** Move every entry of `from` into `to`, returning the names moved, in order. */
function moveEntries(from: string, to: string, moved: string[]): void {
  for (const name of readdirSync(from)) {
    renameRetrying(join(from, name), join(to, name));
    moved.push(name);
  }
}

/**
 * Fill a folder that must stay where it is (an in-place import, or an empty
 * `--into` a shell is sitting in, which Windows will not let be replaced). Its
 * current entries move aside into a sibling first, so the swap can be undone
 * exactly; a failure part-way puts every entry back before it is reported.
 */
function fillInPlace(staged: string, dir: string): string {
  const incoming = `${dir}.incoming-${suffix()}`;
  moveDir(staged, incoming);
  const previous = `${dir}.previous-${suffix()}`;
  mkdirSync(previous);
  const movedOut: string[] = [];
  const movedIn: string[] = [];
  try {
    moveEntries(dir, previous, movedOut);
    moveEntries(incoming, dir, movedIn);
  } catch (err) {
    for (const name of movedIn) rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 5 });
    for (const name of movedOut) renameRetrying(join(previous, name), join(dir, name));
    rmSync(previous, { recursive: true, force: true });
    rmSync(incoming, { recursive: true, force: true });
    throw err;
  }
  rmSync(incoming, { recursive: true, force: true });
  return previous;
}

/** §4 step 6: put the staged tree where the app will live. */
function place(staged: string, opts: InstallOptions, name: string): Placement {
  if (opts.request.kind === "in-place") {
    return { kind: "in-place", dir: opts.request.dir, previous: fillInPlace(staged, opts.request.dir) };
  }
  if (opts.into !== undefined) {
    const dir = resolve(opts.into);
    if (!existsSync(dir)) {
      moveDir(staged, dir);
      return { kind: "new", dir, wasEmptyFolder: false };
    }
    if (readdirSync(dir).length > 0) throw new UsageError(`--into ${dir} is not empty`);
    try {
      rmdirSync(dir);
    } catch {
      // In use (on Windows, a shell sitting in it): fill it rather than replace it.
      const previous = fillInPlace(staged, dir);
      rmSync(previous, { recursive: true, force: true });
      return { kind: "new", dir, wasEmptyFolder: true };
    }
    try {
      moveDir(staged, dir);
    } catch (err) {
      mkdirSync(dir, { recursive: true }); // the empty folder that was there
      throw err;
    }
    return { kind: "new", dir, wasEmptyFolder: true };
  }
  const parent = homePath("apps");
  const slug = slugify(name);
  for (let n = 1; ; n++) {
    const dir = join(parent, n === 1 ? slug : `${slug}-${n}`);
    if (existsSync(dir)) continue;
    try {
      moveDir(staged, dir);
      return { kind: "new", dir, wasEmptyFolder: false };
    } catch (err) {
      if (existsSync(dir)) continue; // claimed by a concurrent install in the gap: take the next name
      throw err;
    }
  }
}

/** Undo a placement: remove what was placed, and put back what was there. */
function unplace(p: Placement): void {
  const empty = (dir: string): void => {
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  if (p.kind === "new") {
    // An `--into` folder that existed (empty) stays, emptied: it may be a shell's working directory.
    if (p.wasEmptyFolder) empty(p.dir);
    else rmSync(p.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  }
  empty(p.dir);
  moveEntries(p.previous, p.dir, []);
  rmSync(p.previous, { recursive: true, force: true });
}

/** Keep a placement: drop what an in-place import set aside. */
function keep(p: Placement): void {
  if (p.kind === "in-place") rmSync(p.previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/* ------------------------------------------------------------------- steps */

/** §4 step 3: remove what a package never carries. */
function sanitize(root: string, strips: string[]): string[] {
  for (const rel of strips) {
    rmSync(assertRealInside(root, join(...rel.replace(/\/$/, "").split("/")), "stripped path"), { recursive: true, force: true });
  }
  return strips;
}

/**
 * §4 step 4: replace the system files from the locally installed toolkit and
 * re-record the canon. The package's own copies of every system path go first,
 * so an extra file inside a system folder — or a system file the template does
 * not have — can never survive into the canon as "trusted".
 */
function revendor(root: string, tk: ResolvedToolkit | null, id: string | null): { tk: ResolvedToolkit; files: number } {
  if (tk === null) {
    throw new PackageRefusedError(
      id === null
        ? "the package names no toolkit (.a2app/toolkit.json) — pass --blueprint <id> to re-vendor it from one installed here"
        : `toolkit "${id}" is not installed here — install it, or pass --blueprint <id> to choose one that is`,
    );
  }
  const manifestPath = join(root, "manifest.json");
  const packaged = readJsonFile(manifestPath) as Manifestish;
  for (const rel of tk.manifest.systemPaths) rmSync(assertRealInside(root, rel, "system path"), { recursive: true, force: true });
  const written = vendorPaths(tk, root, tk.manifest.systemPaths);
  const template = existsSync(manifestPath) ? (readJsonFile(manifestPath) as Manifestish) : {};
  // Identity and modules stay the package's; `pipeline` — the shell commands
  // this CLI runs — comes from the trusted toolkit.
  writeFileAtomic(manifestPath, JSON.stringify(mergeManifest(template, packaged, adapterVersionOf(tk)), null, 2) + "\n");
  recordProjectToolkit(root, tk);
  writeSystemHashes(root, tk.manifest.systemPaths);
  return { tk, files: written.length };
}

interface Identity {
  id: string;
  name: string;
  description: string;
  port: number;
  createdAt: string;
}

/** The values placeholders take (§1): the new identity, the catalogue's defaults, and `--set`. */
function placeholderValues(identity: Identity, set: Map<string, string>, entryFields: { key: string; default?: string }[] | null): Map<string, string> {
  const values = new Map<string, string>([
    ["PROJECT_ID", identity.id],
    ["PROJECT_NAME", identity.name],
    ["PROJECT_DESCRIPTION", identity.description],
    ["PORT", String(identity.port)],
    ["BACKEND_PORT", String(identity.port)],
    ["CREATED_AT", identity.createdAt],
  ]);
  for (const field of entryFields ?? []) if (field.default !== undefined) values.set(field.key, field.default);
  for (const [key, value] of set) {
    if (entryFields !== null && !entryFields.some((f) => f.key === key)) {
      const keys = entryFields.map((f) => f.key);
      throw new UsageError(`--set ${key}: this app has no such customizable key (${keys.length > 0 ? `it has ${keys.join(", ")}` : "it has none"})`);
    }
    values.set(key, value);
  }
  return values;
}

/** §4 step 7: identity, port, credential, guides, provenance — then the canon over the final manifest. */
async function register(
  dir: string,
  tk: ResolvedToolkit,
  identity: Identity,
  provenance: Provenance,
  portWritten: boolean,
): Promise<{ id: string; port: number }> {
  const port = await reserveApp({ id: identity.id, name: identity.name, path: dir, blueprint: tk.manifest.id, createdAt: identity.createdAt }, identity.port);
  if (port !== identity.port && portWritten) {
    throw new Error(`port ${identity.port}, already written into the app's files, was taken by another app during the install — run the install again`);
  }
  const manifestPath = join(dir, "manifest.json");
  const manifest = readJsonFile(manifestPath) as Manifestish;
  manifest.id = identity.id;
  manifest.name = identity.name;
  manifest.port = port;
  manifest.source = { ...provenance, installedAt: new Date().toISOString() };
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  mintAgentToken(dir);
  ensureIgnoreRules(dir, tk.manifest.lifecycle?.dataDir);
  writeHarnessGuides(dir, identity.name);
  for (const dep of linkLocalPackages(dir, tk.source, { relink: true })) {
    log.step(`linked ${dep.name} ${dep.from} -> ${dep.to} (the source in the toolkit's repo)`);
  }
  writeSystemHashes(dir, tk.manifest.systemPaths);
  return { id: identity.id, port };
}

/* ---------------------------------------------------------------- pipeline */

/** Run the whole pipeline and print its result. Returns the exit code. */
export async function install(opts: InstallOptions): Promise<number> {
  const progress = new Progress(opts.events);
  const trust: Trust = opts.request.kind === "catalogue" ? "catalogued" : "untrusted";
  const staging = createStaging();
  let placement: Placement | null = null;
  // The registry row this install wrote, and the row it replaced (an in-place
  // import of an app already registered there), so a rollback restores it.
  let registered: { dir: string; previous: RegistryEntry | null } | null = null;
  // No toolkit is ever taken from the package, wherever it sits.
  const untrusted = [staging];
  if (opts.request.kind === "in-place") untrusted.push(opts.request.dir);
  if (opts.request.kind === "from" && opts.request.source.kind === "folder") untrusted.push(opts.request.source.dir);

  try {
    const acquired = await progress.run("acquire", () => acquire(opts.request, staging), (a) => ({ source: a.provenance }));
    const root = acquired.root;

    const inspection = await progress.run(
      "inspect",
      () => {
        const result = inspectStaged(acquired, { ...(opts.blueprint !== undefined ? { blueprint: opts.blueprint } : {}), untrusted });
        if (result.classified.kind !== "agent-app") throw new NotInstallable(result.report);
        return result;
      },
      (r) => ({ kind: r.report.kind, installable: r.report.installable }),
    );
    for (const warning of inspection.report.warnings) log.warn(warning);

    await progress.run("sanitize", () => sanitize(root, inspection.strips), (removed) => ({ removed }));
    const { tk: toolkit } = await progress.run(
      "revendor",
      () => revendor(root, inspection.toolkit, inspection.toolkitId),
      (r) => ({ toolkit: r.tk.manifest.id, files: r.files }),
    );

    const manifest = readJsonFile(join(root, "manifest.json")) as Manifestish;
    const name = opts.name ?? acquired.entry?.name ?? (typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : "Installed App");
    const description =
      acquired.entry?.description ?? (typeof manifest["description"] === "string" ? (manifest["description"] as string) : "");
    const identity: Identity = {
      id: randomBytes(6).toString("hex"),
      name,
      description,
      port: await pickFreePort(opts.port),
      createdAt: new Date().toISOString(),
    };
    if (opts.port !== undefined && identity.port !== opts.port) log.warn(`port ${opts.port} is already taken — assigned ${identity.port} instead`);

    const customized: Substituted = await progress.run(
      "customize",
      () =>
        substitutePlaceholders(
          root,
          placeholderValues(identity, opts.set, acquired.entry !== null ? (acquired.entry.customizable ?? []) : null),
          systemFiles(root, toolkit),
        ),
      (c) => ({ files: c.files, replaced: [...c.keys].sort() }),
    );

    placement = await progress.run("place", () => place(root, opts, identity.name), (p) => ({ dir: p.dir }));
    const dir = placement.dir;

    const portWritten = [...customized.keys].some((k) => PORT_TOKENS.has(k));
    const { id, port } = await progress.run(
      "register",
      () => {
        registered = { dir, previous: readRegistry().apps.find((a) => resolve(a.path) === resolve(dir)) ?? null };
        return register(dir, toolkit, identity, acquired.provenance, portWritten);
      },
      (r) => ({ id: r.id, port: r.port }),
    );

    const project = loadProject(dir);
    if (opts.start) {
      await progress.run("dependencies", () => {
        const command = project.manifest.pipeline?.install ?? "";
        if (command !== "") runShell(command, dir);
        return command;
      }, (command) => ({ command }));
    } else {
      progress.skipped("dependencies", "--no-start: `serve --install` installs them");
    }

    // The gate runs the toolkit's build only when the dependencies it needs are
    // installed; with --no-start it checks everything that needs no build.
    progress.start("gate");
    let gate: ValidateOutcome;
    try {
      // With the app about to start, its running-app checks run once it is up
      // (after serve); without that, the gate reports them unchecked.
      gate = await validateApp(project, opts.start ? { skipInstall: true, skipRunningChecks: true } : { skipBuild: true });
    } catch (err) {
      progress.failed("gate", { error: (err as Error).message });
      throw new StepFailed("gate", err);
    }
    let gateResult: { ok: boolean; failures?: GateError[]; unchecked?: GateUnchecked[] } = {
      ok: gate.ok,
      ...(gate.ok ? {} : { failures: gate.failures }),
      ...(gate.unchecked.length > 0 ? { unchecked: gate.unchecked } : {}),
    };
    const next: string[] = [];
    const base = { id, name: identity.name, dir, port };

    if (!gate.ok) {
      // The one step whose failure keeps the app (§4): it is installed, and can be fixed.
      progress.failed("gate", { failures: gate.failures.length });
      progress.skipped("serve", "the gate failed");
      progress.skipped("open", "the gate failed");
      keep(placement);
      next.push(`fix what the gate reports, then run ${appCommand(dir, "validate")}`);
      if (trust === "untrusted") next.push(walkVerifyStep());
      progress.result({ ok: false, ...base, trust, source: readJsonFile<Manifestish>(join(dir, "manifest.json")).source, gate: gateResult, served: false, next });
      log.error(`installed "${identity.name}" at ${dir}, but it does not pass its gate — it stays registered so it can be fixed`);
      return 1;
    }
    progress.done("gate", { ok: true });

    let url: string | undefined;
    if (opts.start) {
      const served = await progress.run(
        "serve",
        async () => {
          const outcome = await serveApp(dir, { build: false });
          if (outcome.code !== 0 || outcome.result === null) throw new Error(outcome.error ?? "the app did not start");
          return outcome.result;
        },
        (r) => ({ url: r["url"] }),
      );
      url = String(served["url"]);

      // The gate's running-app checks (the describe budget, and who a
      // multi-user app answers) need the app up, so they run now that it
      // serves: an app that answers strangers must not stay up because it was
      // installed.
      {
        const running = loadProject(dir);
        const checks = [await runBudgetGate(running), await runAccessGate(running)];
        const failures = checks.flatMap((c) => c.errors);
        const unchecked = checks.flatMap((c) => c.unchecked);
        gateResult = { ok: failures.length === 0, ...(failures.length > 0 ? { failures } : {}), ...(unchecked.length > 0 ? { unchecked } : {}) };
        if (failures.length > 0) {
          await stopServed(running);
          keep(placement);
          next.push(`fix what the gate reports, then run ${appCommand(dir, "validate")} and ${appCommand(dir, "serve")}`);
          if (trust === "untrusted") next.push(walkVerifyStep());
          progress.skipped("open", "the running app failed its gate, so it was stopped");
          progress.result({ ok: false, ...base, trust, source: readJsonFile<Manifestish>(join(dir, "manifest.json")).source, gate: gateResult, served: false, next });
          log.error(`installed "${identity.name}" at ${dir}, but the running app fails its gate — it was stopped, and stays registered so it can be fixed`);
          return 1;
        }
      }
    } else {
      progress.skipped("serve", "--no-start");
      next.push(`${appCommand(dir, "serve --install")}   (installs its dependencies, builds and launches it)`);
    }

    let opened: Record<string, unknown> = {};
    if (opts.open && url !== undefined) {
      const target = url;
      const outcome = await progress.run("open", () => openUrl(target, false), (o) => ({ opened: o.opened, via: o.via }));
      if (!outcome.opened) log.warn(`could not open a browser (${outcome.reason ?? "unknown"}) — open this yourself: ${target}`);
      opened = { opened: outcome.opened, via: outcome.via };
    } else {
      progress.skipped("open", opts.open ? "the app is not running (--no-start)" : "pass --open to show it to someone");
    }

    keep(placement);
    if (trust === "untrusted") next.push(walkVerifyStep());
    const source = readJsonFile<Manifestish>(join(dir, "manifest.json")).source;
    progress.result({ ok: true, ...base, ...(url !== undefined ? { url } : {}), trust, source, gate: gateResult, served: url !== undefined, ...opened, next });
    log.ok(`installed "${identity.name}" (id ${id}) at ${dir}${url !== undefined ? `, serving on ${url}` : ""}`);
    return 0;
  } catch (err) {
    const step = err instanceof StepFailed ? err.step : null;
    const cause = err instanceof StepFailed ? err.error : err;
    const row = registered as { dir: string; previous: RegistryEntry | null } | null;
    if (row !== null) {
      try {
        await unregister(row.dir);
        if (row.previous !== null) await registerEntry(row.previous);
      } catch (e) {
        log.warn(`could not restore the registry entry for ${row.dir}: ${(e as Error).message}`);
      }
    }
    if (placement !== null) {
      try {
        unplace(placement);
      } catch (e) {
        log.error(`could not undo placing the app at ${placement.dir}: ${(e as Error).message}`);
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    const refusal =
      cause instanceof NotInstallable
        ? { kind: cause.report.kind, reason: cause.report.reason, routes: cause.report.routes }
        : {};
    progress.result({ ok: false, step, error: message, ...refusal });
    log.error(step !== null ? `${step}: ${message}` : message);
    if (step !== null && step !== "acquire" && step !== "inspect") log.info("nothing was installed: the install was rolled back");
    return exitCodeOf(cause);
  } finally {
    removeStaging(staging);
  }
}

function walkVerifyStep(): string {
  return "walk-verify: a verifier agent (not the one that installed it) runs the walk-verify skill against the app before it is used for real work";
}

/* ------------------------------------------------------- shared arguments */

/** `<catalogue id>` or `--from <source>` — exactly one (install and inspect). */
export function requestOf(positionals: string[], from: string | undefined, marketplace: string | undefined): Request {
  if (positionals.length > 1) throw new UsageError(`One app at a time: got ${positionals.join(", ")}`);
  const id = positionals[0];
  if (id !== undefined && from !== undefined) throw new UsageError("Name a catalogue id or --from <source>, not both");
  if (from !== undefined) {
    if (marketplace !== undefined) throw new UsageError("--source names a marketplace; it applies to a catalogue id, not to --from");
    return { kind: "from", source: parseFrom(from) };
  }
  if (id === undefined) throw new UsageError("Name what to install: a catalogue id (see `agent-app catalogue`), or --from <zip | folder | github:… | git+…>");
  return { kind: "catalogue", id, ...(marketplace !== undefined ? { marketplace } : {}) };
}

/** `--port`, validated up front: a mistyped port is a usage error, never a value written into an app. */
export function portOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--port must be an integer between 1 and 65535 (got "${value}")`);
  return n;
}

/** `--set KEY=VALUE`, repeatable. The identity tokens are the install's to set, never the caller's. */
export function setsOf(values: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of values) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (eq < 0 || !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new UsageError(`--set takes KEY=VALUE with an UPPER_SNAKE_CASE key (got "${pair}")`);
    if ((IDENTITY_TOKENS as readonly string[]).includes(key)) throw new UsageError(`--set ${key}: the install sets ${key} itself`);
    out.set(key, pair.slice(eq + 1));
  }
  return out;
}

/** The flags install and import share. */
export const INSTALL_FLAGS = {
  values: ["name", "port", "blueprint"],
  lists: ["set"],
  booleans: ["no-start", "open", "events"],
};
