/**
 * The runnable sidecar: an adopted app's directory in, its A2App surface out.
 *
 * Wired the way the react-node starter's `server.mjs` wires adapter-core — the
 * same launch contract, admin credential, network policy, account page, state
 * store and structured log — with one difference: it has no View and no model
 * of its own. The app behind it is started from `sidecar.json`, and the surface
 * goes up on the app's port only once that app answers.
 *
 * The launch contract (`agent-app serve` and `dev` set these; the defaults
 * cover a direct run):
 *   PORT                where the surface listens (default: manifest.port)
 *   A2APP_DATA_DIR      adapter-owned state, and the parent of the app's own
 *                       `{dataDir}` (default: <app>/data, the toolkit's
 *                       lifecycle dataDir — what backup/restore protect)
 *   A2APP_HOST,         where to listen and the address people and agents
 *   A2APP_PUBLIC_URL    use, under the same policy as every adapter
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { createA2AppServer, fingerprintPaths, networkPolicy, type NextHandler } from "@a2app/adapter-core";
import {
  expandTokens,
  loadAdoptedApp,
  mentionsToken,
  MANIFEST_FILE,
  OPERATIONS_FILE,
  SIDECAR_FILE,
  type UpstreamTokens,
} from "./config.js";
import { createReverseProxy } from "./proxy.js";
import { launchUpstream } from "./upstream.js";

/** The framework's account page: sign in, invites, people, connected agents. */
const ACCOUNT_PAGE = { path: "/_a2app/account", file: "a2app-account.html" };
const TOKEN_FILE = ".agent-token";
/** Adapter-owned state (idempotency keys, tasks, grants, accounts, audit). */
const STATE_FILE = "a2app-state.json";
/** The app's own `{dataDir}`, inside the framework's data directory. */
const UPSTREAM_DATA_DIR = "upstream";

export type SidecarLog = (level: "info" | "warn" | "error", evt: string, fields?: Record<string, unknown>) => void;

export interface SidecarOptions {
  /** the adopted app's directory: framework files, sidecar.json, the source */
  dir: string;
  /** the launch contract; default `process.env` */
  env?: NodeJS.ProcessEnv;
  /** default: one JSON line per event on stdout ({@link jsonLog}) */
  log?: SidecarLog;
}

/** How a sidecar ended: asked to stop, or its app went away under it. */
export type SidecarClosed =
  | { reason: "stopped" }
  | { reason: "upstream-exit"; code: number | null; signal: NodeJS.Signals | null };

export interface Sidecar {
  /** where the A2App surface listens */
  url: string;
  /** where the adopted app answers */
  upstreamUrl: string;
  upstreamPid: number;
  server: Server;
  /** settles once the sidecar is down, saying why */
  closed: Promise<SidecarClosed>;
  /** close the surface, then stop the app */
  stop(): Promise<void>;
  /** end the app synchronously — for a process that is exiting */
  killUpstreamNow(): void;
}

/** The declarations do not describe an app the sidecar can serve. */
export class SidecarConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`the adopted app's declarations cannot be served:\n  - ${problems.join("\n  - ")}`);
    this.name = "SidecarConfigError";
  }
}

/** One JSON line per event on stdout (the log `agent-app serve` captures): a
 *  single schema — ts, level, evt, then event fields. Never record contents or
 *  secrets. */
export const jsonLog: SidecarLog = (level, evt, fields = {}) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, evt, ...fields }) + "\n");
};

/** A port nothing is listening on right now, for an `auto` app. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

/** The app's own `.agent-token` is its admin credential (spec/v0_2/auth.md
 *  §2.3); minted here when a direct run finds none. */
function readOrMintToken(file: string): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = "a2app_" + randomBytes(24).toString("hex");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

/**
 * The app's environment: the sidecar's own, less the launch contract it
 * consumed — `PORT` names the sidecar's port, not the app's, and `A2APP_*` is
 * the framework's namespace, whose values (a credential among them) are not the
 * foreign app's to read — plus exactly what sidecar.json declares.
 */
function upstreamEnv(own: NodeJS.ProcessEnv, declared: Record<string, string>, tokens: UpstreamTokens): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(own)) {
    // Upper-cased because Windows environment names are case-insensitive.
    const name = key.toUpperCase();
    if (name !== "PORT" && !name.startsWith("A2APP_")) out[key] = value;
  }
  for (const [key, value] of Object.entries(declared)) out[key] = expandTokens(value, tokens);
  return out;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ a2app: true, ok: false, code: "not_found", message: "No such route." }));
}

/**
 * The pages the sidecar serves besides the protocol: exactly the listed URL
 * paths, each from one file. The adopted app keeps its own UI at its own
 * address; nothing else in the app directory is reachable from here.
 */
function pages(files: Record<string, string>): NextHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    const file = files[new URL(req.url ?? "/", "http://localhost").pathname];
    if (file === undefined || !existsSync(file)) {
      notFound(res);
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
      res.end(JSON.stringify({ a2app: true, ok: false, code: "method_not_allowed", message: "Pages are GET-only." }));
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Revalidate on every use: the page is a system file a toolkit-sync can
      // replace while this process runs.
      "cache-control": "no-cache",
      "content-length": String(body.byteLength),
    });
    res.end(method === "HEAD" ? undefined : body);
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      done();
    });
  });
}

/**
 * Start the adopted app, wait until it answers, then serve its A2App surface.
 * Rejects — with nothing left running — on a declaration problem
 * ({@link SidecarConfigError}), an unsafe network setting, an app that cannot
 * be started or never answers, or a port that cannot be bound.
 */
export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const dir = resolve(options.dir);
  const env = options.env ?? process.env;
  const log = options.log ?? jsonLog;

  const loaded = loadAdoptedApp(dir);
  if (!loaded.ok) throw new SidecarConfigError(loaded.problems);
  const { manifest, sidecar, operations } = loaded.app;
  const declared = sidecar.upstream;

  // The CLI reaches a running app at manifest.port; bind the same port so the
  // two always agree. PORT overrides (`serve` passes manifest.port; `dev` a
  // hidden port).
  const port = Number(env["PORT"] ?? manifest.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`no port to serve on: set PORT, or "port" in ${MANIFEST_FILE}`);
  }
  // Refused here, before anything is started, when the combination would send
  // the agent token across a network in clear.
  const network = networkPolicy({ host: env["A2APP_HOST"], publicUrl: env["A2APP_PUBLIC_URL"] });
  const dataDir = env["A2APP_DATA_DIR"] ? resolve(env["A2APP_DATA_DIR"]) : join(dir, "data");
  const token = readOrMintToken(join(dir, TOKEN_FILE));

  // What this surface tells an agent comes from these files, and `schemaVersion`
  // does not cover all of it — an operation's description, a module's summary.
  // They are read once at boot, so the marker is fixed at boot too.
  const appVersion = `av_${fingerprintPaths([MANIFEST_FILE, OPERATIONS_FILE, SIDECAR_FILE].map((f) => join(dir, f))).slice(0, 16)}`;

  const upstreamPort = declared.port === "auto" ? await freePort() : declared.port;
  const tokens: UpstreamTokens = { port: String(upstreamPort), dataDir: join(dataDir, UPSTREAM_DATA_DIR) };
  if (mentionsToken(declared, "dataDir")) mkdirSync(tokens.dataDir, { recursive: true });
  const upstream = await launchUpstream({
    command: declared.command.map((arg) => expandTokens(arg, tokens)),
    cwd: resolve(dir, declared.cwd),
    env: upstreamEnv(env, declared.env, tokens),
    url: `http://127.0.0.1:${upstreamPort}`,
    health: declared.health,
    startTimeoutMs: declared.startTimeoutMs,
  });
  log("info", "upstream", { pid: upstream.pid, url: upstream.url });

  let server: Server;
  try {
    const a2app = createReverseProxy(
      {
        appId: manifest.id,
        appName: manifest.name,
        authMode: manifest.authMode,
        upstreamBaseUrl: upstream.url,
        operations,
        modules: manifest.modules,
        ...(declared.timeoutMs !== undefined ? { timeoutMs: declared.timeoutMs } : {}),
      },
      {
        // The app's own .agent-token is its admin credential (spec/v0_2/auth.md §2.3).
        credentials: [{ token, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
        appVersion,
        allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
        publicUrl: network.publicUrl,
        credentialHint: "Read the app's .agent-token file (mode 0600) in the project directory.",
        // Adapter-owned state lives inside the toolkit's declared lifecycle
        // dataDir. It MUST survive a restart: a restart is exactly when a
        // retried write arrives, and accounts and credentials live here too.
        storePath: join(dataDir, STATE_FILE),
      },
    );
    server = createA2AppServer(a2app, pages({ [ACCOUNT_PAGE.path]: join(dir, ACCOUNT_PAGE.file) }));
    // Loopback unless the owner deliberately exposed the app (A2APP_HOST): a
    // sidecar holding an owner-scoped credential must not be the thing that
    // puts the app on the network.
    await listen(server, port, network.host);
  } catch (e) {
    await upstream.stop();
    throw e;
  }

  // Observe (never handle) every request for the log: id, method, path, status,
  // duration. Paths only — query strings can carry user data.
  let nextRequestId = 0;
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const id = ++nextRequestId;
    const started = Date.now();
    res.on("finish", () => {
      log(res.statusCode >= 500 ? "error" : "info", "http", {
        id,
        method: req.method,
        path: (req.url ?? "/").split("?")[0],
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
  });

  const closeServer = (): Promise<void> =>
    new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });

  let settle!: (outcome: SidecarClosed) => void;
  const closed = new Promise<SidecarClosed>((done) => (settle = done));
  let stopping: Promise<void> | null = null;

  // An app that goes away takes its surface with it: a sidecar still answering
  // identity would read as a healthy app whose every operation fails.
  void upstream.exited.then((status) => {
    if (stopping !== null) return;
    log("error", "upstream-exit", { code: status.code, signal: status.signal });
    stopping = closeServer().then(() => settle({ reason: "upstream-exit", ...status }));
  });

  const url = `http://${network.host}:${port}`;
  log("info", "boot", {
    app: manifest.name,
    a2appId: manifest.id,
    url,
    upstream: upstream.url,
    ...(network.publicUrl ? { publicUrl: network.publicUrl } : {}),
  });

  return {
    url,
    upstreamUrl: upstream.url,
    upstreamPid: upstream.pid,
    server,
    closed,
    stop: () => {
      stopping ??= (async () => {
        await closeServer();
        await upstream.stop();
        settle({ reason: "stopped" });
      })();
      return stopping;
    },
    killUpstreamNow: () => upstream.killNow(),
  };
}
