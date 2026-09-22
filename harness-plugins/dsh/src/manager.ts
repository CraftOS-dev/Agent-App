/**
 * The Agent Apps manager backend for dsh: web routes serving the manager page
 * and its JSON API, backed by dsh's session/agent runtime and the framework
 * CLIs. Registered from the host bundle once `webServer` is available.
 *
 * Two routes on dsh's own web server (so the page is same-origin — no CORS):
 *   - `/agent-app/home` serves the page and reads a session transcript.
 *   - `/agent-app/api`  is the JSON action API (apps/build/serve/stop/remove/send),
 *     guarded by a per-page token minted into each page load.
 *
 * Build and chat drive a per-app dsh session: `ctx.agents.create` starts the
 * agent on a chosen session id, `agent.followup` delivers each message, and
 * `session.deriveMessages()` reads the transcript back. Lifecycle actions shell
 * the framework CLIs (`serve` / `stop` / `remove`).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { runA2App, buildKickoffPrompt, listKnownApps, FRAMEWORK_BLUEPRINTS, type KnownApp } from "@a2app/integration-starter";
import { appManagerHtml } from "./ui.js";

/** Build/evolve and operate binaries. Override with AGENT_APP_CLI / A2APP_CLI. */
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";

/** Where new apps are created. The framework imposes no app home (the registry
 *  tracks absolute paths), so the directory convention is the host's. */
const APPS_DIR = join(process.env.A2APP_HOME ?? join(homedir(), ".a2app"), "apps");

const PAGE_ROUTE = "/agent-app/home";
const API_ROUTE = "/agent-app/api";
const BUILD_STAMP = process.env.A2APP_PLUGIN_BUILD ?? "dev";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Deterministic session id per app, stable for the app's whole life. */
const sessionIdFor = (path: string): string => `agent-app:${basename(path)}`;

const sessionPreamble = (name: string, path: string): string =>
  `You are working on the Agent App "${name}" at \`${path}\`. For a code or feature change ` +
  "load the **modify** skill; for using the app (data, tasks, reports) load the **operator** " +
  "skill. Work through the `agent-app` and `a2app` CLIs, respect the ownership boundary, and " +
  "never drive the app UI.";

/** Subset of dsh's session/agent runtime, typed locally — the SDK types resolve
 *  only inside dsh's own toolchain. */
interface DshAgent {
  followup(message: unknown): void;
  steer(message: unknown): void;
}
interface DshAgentHandle {
  agent: DshAgent;
  dispose(): void;
}
interface DshAgents {
  get(sessionId: string): DshAgent | undefined;
  create(opts: { sessionId: string; meta?: { cwd?: string } }): Promise<DshAgentHandle>;
}
interface DshSession {
  deriveMessages(): unknown[];
}
interface DshSessions {
  get(sessionId: string): DshSession | undefined;
}
/** The slice of the Cordis host context this backend uses. */
export interface ManagerHost {
  get<T = unknown>(name: string): T | undefined;
  webServer: { register(route: { kind: "exact" | "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void };
}

interface BuildEntry {
  name: string;
  dir: string;
  ended: boolean;
}
interface AppRow extends KnownApp {
  building: boolean;
  buildEnded: boolean;
}

/** Register the manager routes on dsh's web server. Returns a disposer. */
export function registerManager(ctx: ManagerHost): () => void {
  const tokens = new Map<string, number>();
  const builds = new Map<string, BuildEntry>();
  const handles = new Map<string, DshAgentHandle>();

  const mintToken = (): string => {
    const now = Date.now();
    for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
    const t = randomBytes(24).toString("hex");
    tokens.set(t, now + TOKEN_TTL_MS);
    return t;
  };
  const tokenValid = (t: unknown): boolean => typeof t === "string" && (tokens.get(t) ?? 0) > Date.now();

  const userMessage = (text: string): unknown => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });

  /** Deliver a message into an app's session, starting the agent if needed. */
  async function deliver(sessionId: string, cwd: string, text: string): Promise<void> {
    const agents = ctx.get<DshAgents>("agents");
    if (!agents) throw new Error("dsh agents runtime unavailable");
    const existing = agents.get(sessionId);
    if (existing) { existing.followup(userMessage(text)); return; }
    const handle = await agents.create({ sessionId, meta: { cwd } });
    handles.set(sessionId, handle);
    handle.agent.followup(userMessage(text));
  }

  function transcript(sessionId: string): { role: string; text: string; tools: string[] }[] {
    const session = ctx.get<DshSessions>("sessions")?.get(sessionId);
    if (!session) return [];
    return session.deriveMessages().map(viewMessage).filter((m) => m.text !== "" || m.tools.length > 0);
  }

  async function rows(): Promise<AppRow[]> {
    const apps = await listKnownApps(FRAMEWORK_CLI);
    for (const a of apps) if (a.status === "running") builds.delete(a.path);
    const out: AppRow[] = apps.map((a) => {
      const b = builds.get(a.path);
      return { ...a, building: b != null && !b.ended, buildEnded: b?.ended === true };
    });
    for (const b of builds.values()) {
      if (apps.some((a) => a.path === b.dir)) continue;
      out.push({ id: basename(b.dir), name: b.name, path: b.dir, url: null, building: !b.ended, buildEnded: b.ended, status: "stopped" });
    }
    return out;
  }

  async function registeredApp(path: string): Promise<KnownApp | null> {
    const apps = await listKnownApps(FRAMEWORK_CLI);
    return apps.find((a) => a.path === path) ?? null;
  }

  async function startBuild(body: Record<string, unknown>): Promise<{ status: number; out: Record<string, unknown> }> {
    const name = String(body.name ?? "").trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) return { status: 400, out: { ok: false, message: "Give the app a name." } };
    const dir = join(APPS_DIR, slug);
    if (builds.has(dir)) return { status: 400, out: { ok: false, message: `"${name}" is already being built.` } };
    if (existsSync(dir)) return { status: 400, out: { ok: false, message: `An app directory named "${slug}" already exists.` } };
    const kick = buildKickoffPrompt({ action: "build", name, requirement: body.requirement, blueprint: body.blueprint, port: body.port });
    if (kick.kind === "error") return { status: 400, out: { ok: false, message: kick.message } };
    mkdirSync(APPS_DIR, { recursive: true });
    const prompt = `${kick.prompt}\n\nCreate the app at \`${dir}\` — pass that directory to every agent-app command.`;
    await deliver(sessionIdFor(dir), APPS_DIR, prompt);
    builds.set(dir, { name, dir, ended: false });
    return { status: 200, out: { ok: true, path: dir } };
  }

  async function lifecycle(sub: string, path: string): Promise<{ status: number; out: Record<string, unknown> }> {
    const app = await registeredApp(path);
    if (sub !== "/app/remove") {
      if (!app) return { status: 404, out: { ok: false, message: "unknown app" } };
      const r = await runA2App(FRAMEWORK_CLI, [path, sub === "/app/serve" ? "serve" : "stop"]);
      return { status: r.ok ? 200 : 500, out: { ok: r.ok, message: r.ok ? "" : (r.stderr || r.stdout).trim() } };
    }
    if (!app && !builds.has(path)) return { status: 404, out: { ok: false, message: "unknown app" } };
    if (app) {
      await runA2App(FRAMEWORK_CLI, [path, "stop"]);
      const r = await runA2App(FRAMEWORK_CLI, [path, "remove", "--yes"]);
      if (!r.ok) return { status: 500, out: { ok: false, message: (r.stderr || r.stdout).trim() } };
    }
    builds.delete(path);
    handles.get(sessionIdFor(path))?.dispose();
    handles.delete(sessionIdFor(path));
    return { status: 200, out: { ok: true } };
  }

  // ── The manager page + transcript read (same-origin GET) ──
  const disposePage = ctx.webServer.register({
    kind: "prefix",
    path: PAGE_ROUTE,
    async handler(req, res) {
      if ((req.method ?? "GET").toUpperCase() !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET");
        res.end("The manager page is GET-only; actions go through its API.");
        return;
      }
      const url = new URL(req.url ?? "/", "http://plugin.local");
      if (url.pathname.slice(PAGE_ROUTE.length) === "/session") {
        res.setHeader("content-type", "application/json");
        try {
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, messages: transcript(sessionIdFor(url.searchParams.get("app") ?? "")) }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, message: String((e as Error)?.message ?? e) }));
        }
        return;
      }
      const dark = !/[?&]light=1(&|$)/.test(req.url ?? "");
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(appManagerHtml({ apiBase: API_ROUTE, homeBase: PAGE_ROUTE, token: mintToken(), blueprints: FRAMEWORK_BLUEPRINTS, dark, build: BUILD_STAMP }));
    },
  });

  // ── The JSON action API (token-guarded) ──
  const disposeApi = ctx.webServer.register({
    kind: "prefix",
    path: API_ROUTE,
    async handler(req, res) {
      const send = (status: number, body: unknown): void => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://plugin.local");
      const sub = url.pathname.slice(API_ROUTE.length);
      try {
        if (!tokenValid(req.headers["x-a2app-token"])) { send(401, { ok: false, message: "invalid or expired page token — reopen the Agent Apps tab" }); return; }
        if (method === "GET" && sub === "/apps") { send(200, { ok: true, rows: await rows() }); return; }
        if (method !== "POST") { send(405, { ok: false, message: "method not allowed" }); return; }
        const body = await readBody(req);

        if (sub === "/build") { const r = await startBuild(body); send(r.status, r.out); return; }
        if (sub === "/session/send") {
          const path = String(body.path ?? "");
          const text = String(body.text ?? "").trim();
          if (!text) { send(400, { ok: false, message: "empty message" }); return; }
          const seeded = transcript(sessionIdFor(path)).length > 0;
          const message = seeded ? text : `${sessionPreamble(String(body.name ?? basename(path)), path)}\n\n${text}`;
          await deliver(sessionIdFor(path), existsSync(path) ? path : APPS_DIR, message);
          send(200, { ok: true });
          return;
        }
        if (sub === "/app/serve" || sub === "/app/stop" || sub === "/app/remove") {
          const r = await lifecycle(sub, String(body.path ?? ""));
          send(r.status, r.out);
          return;
        }
        send(404, { ok: false, message: "unknown endpoint" });
      } catch (e) {
        send(500, { ok: false, message: String((e as Error)?.message ?? e) });
      }
    },
  });

  return () => {
    disposePage();
    disposeApi();
    for (const h of handles.values()) h.dispose();
    handles.clear();
  };
}

/** Flatten a dsh transcript message to role, concatenated text, and tool names. */
function viewMessage(m: unknown): { role: string; text: string; tools: string[] } {
  const r = m as Record<string, unknown>;
  const role = typeof r.role === "string" ? r.role : "";
  const c = r.content;
  const texts: string[] = [];
  const tools: string[] = [];
  if (typeof c === "string") texts.push(c);
  else if (Array.isArray(c)) {
    for (const p of c) {
      const q = p as Record<string, unknown>;
      if (typeof q.text === "string") texts.push(q.text);
      const name = typeof q.name === "string" ? q.name : typeof q.toolName === "string" ? q.toolName : "";
      if (name) tools.push(name);
    }
  }
  if (typeof r.toolName === "string") tools.push(r.toolName);
  return { role, text: texts.join(""), tools };
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) { reject(new Error("request body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data) as Record<string, unknown>); }
      catch { reject(new Error("request body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}
