/**
 * Agent App Framework plugin for OpenClaw — the Agent Apps manager.
 *
 * Registers an `/agent-app` chat command, an `openclaw agent-app …` CLI
 * passthrough, and an "Agent Apps" Control-UI tab that manages Agent Apps as
 * browser-style tabs: build, launch/pause/delete, an embedded view of each
 * running app, and a per-app OpenClaw session in a side panel.
 *
 * The tab is backed by two HTTP routes:
 *   - `/agent-app/home` (auth: gateway) serves the page and reads session
 *     transcripts; only the authenticated Control UI can reach it.
 *   - `/agent-app/api`  (auth: plugin)  is the JSON action API the page calls,
 *     authorized by a per-page token minted into each page load.
 *
 * Beside the build form, the tab has a Marketplace and an Import panel. Their
 * routes (`/catalogue`, `/inspect`, `/install`, `/upload`) are the shared
 * engine's `PackageApi` over the same CLI the tools use, and `/import/agent`
 * hands a source that is not a package to the agent (importer skill) in a new
 * app's session, the way `/build` starts a build.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  runA2App,
  binFor,
  buildKickoffPrompt,
  listKnownApps,
  registerHarnessProfile,
  FRAMEWORK_BLUEPRINTS,
  INSTALL_STEPS,
  PackageApi,
  PROMPT_PLACEHOLDER,
  type ApiReply,
  type FormActionResult,
  type KnownApp,
} from "@a2app/integration-starter";
import { appManagerHtml } from "./ui.js";

/** Operate client (a2app) and build/evolve client (agent-app). `binFor` routes
 *  each verb to its owner; a2app rejects build verbs by design. */
const CLI = process.env.A2APP_CLI ?? "a2app";
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";

/** Where new apps are created. The framework imposes no app home (the registry
 *  tracks absolute paths), so the directory convention is the host's. */
const APPS_DIR = join(process.env.A2APP_HOME ?? join(homedir(), ".a2app"), "apps");

const PAGE_ROUTE = "/agent-app/home";
const API_ROUTE = "/agent-app/api";
/** Bundle build time, stamped by scripts/build.mjs; shown in the page footer. */
const BUILD_STAMP = process.env.A2APP_PLUGIN_BUILD ?? "dev";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const BUILD_WAIT_MS = 2 * 60 * 60 * 1000;

/** System-prompt guidance registered with `/agent-app`, so the agent routes a
 *  request through the framework skills rather than general knowledge. */
const AGENT_GUIDANCE =
  "The /agent-app command is the front door to the Agent App Framework. An Agent App is a " +
  "self-contained full-stack web app operated through its A2App adapter (the `a2app` CLI) — " +
  "never by driving the UI. When a message asks to build, change, run, import, verify, or " +
  "connect to an app, load the matching framework skill and follow it end to end: creator " +
  "(build a NEW app), modify (change an EXISTING app), operator (use/read/run an app, no code " +
  "changes), importer (install from the marketplace, import a zip/folder/git source, adopt or " +
  "convert existing software, export an app to share), walk-verify (independent verification), " +
  "connect (a published app you do not own). Do not build or operate an app from general " +
  "knowledge outside these skills. `agent-app list` locates every known Agent App.";

/** Deterministic session key per app, stable for the app's whole life. */
const sessionKeyFor = (path: string): string => `subagent:agent-app:${basename(path)}`;

/** Context prepended to the first message of an app's session; later messages
 *  are the user's text alone. */
const sessionPreamble = (name: string, path: string): string =>
  `You are working on the Agent App "${name}" at \`${path}\`. For a code or feature change ` +
  "load the **modify** skill; for using the app (data, tasks, reports) load the **operator** " +
  "skill. Work through the `agent-app` and `a2app` CLIs, respect the ownership boundary, and " +
  "never drive the app UI.";

/** Subset of OpenClaw's plugin runtime, typed locally — the SDK types resolve
 *  only inside OpenClaw's own toolchain. */
interface SubagentRuntime {
  run(p: { sessionKey: string; message: string; deliver: boolean; lane: string; cwd: string }): Promise<{ runId: string }>;
  waitForRun(p: { runId: string; timeoutMs: number }): Promise<unknown>;
  getSessionMessages(p: { sessionKey: string; limit: number }): Promise<{ messages: unknown[] }>;
  deleteSession(p: { sessionKey: string; deleteTranscript: boolean }): Promise<void>;
}

/** An in-flight, or finished-but-not-yet-registered, build started from the form. */
interface BuildEntry {
  name: string;
  dir: string;
  ended: boolean;
}

/** One row of the manager UI: a registered app, or a build not yet registered. */
interface AppRow extends KnownApp {
  building: boolean;
  buildEnded: boolean;
}

export default definePluginEntry({
  id: "a2app",
  name: "Agent App Framework",
  description: "Build and operate full Agent Apps over the A2App protocol via the agent-app and a2app CLIs.",
  register(api) {
    const subagent = (api as unknown as { runtime: { subagent: SubagentRuntime } }).runtime.subagent;

    // How `agent-app <dir> bridge` starts OpenClaw when an app queues work.
    // `agent exec` runs one embedded turn in the app's directory, exits 0/1/2
    // (ok/error/timeout), and runs shell tools without approval because a
    // one-shot has no one to ask. It uses isolated temporary state, so it runs
    // alongside the gateway this plugin lives in rather than contending for it.
    // The framework has no built-in OpenClaw profile, so without this entry the
    // bridge cannot see OpenClaw at all. Written once; an entry already in the
    // file (the user's own) is kept.
    const registration = registerHarnessProfile({
      id: "openclaw",
      name: "OpenClaw",
      routes: [{ mode: "headless", command: "openclaw", args: ["agent", "exec", PROMPT_PLACEHOLDER] }],
    });
    if (registration.status === "registered") api.logger.info(`agent-app: ${registration.detail}`);
    if (registration.status === "refused") api.logger.warn(`agent-app: ${registration.detail}`);
    const tokens = new Map<string, number>();
    const builds = new Map<string, BuildEntry>();
    const packages = new PackageApi(FRAMEWORK_CLI);

    // subagent.run needs operator.write, which OpenClaw grants only to calls made
    // outside a request scope (a request client carries no operator scopes). Runs
    // are queued and drained from the host-invoked gateway_start context, which
    // every queued job then inherits.
    const jobs: Array<() => void> = [];
    let drainStarted = false;
    (api as unknown as { on(hook: string, fn: () => void): void }).on("gateway_start", () => {
      if (drainStarted) return;
      drainStarted = true;
      setInterval(() => { const job = jobs.shift(); if (job) job(); }, 250);
    });
    const detached = <T,>(fn: () => Promise<T>): Promise<T> => {
      if (!drainStarted) return Promise.reject(new Error("plugin agent runner not started — restart the OpenClaw gateway"));
      return new Promise((resolve, reject) => { jobs.push(() => fn().then(resolve, reject)); });
    };

    /** Sessions this process has already seeded with the context preamble, so a
     *  send never has to read the transcript to decide whether to prepend it. */
    const seeded = new Set<string>();

    const mintToken = (): string => {
      const now = Date.now();
      for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
      const t = randomBytes(24).toString("hex");
      tokens.set(t, now + TOKEN_TTL_MS);
      return t;
    };
    const tokenValid = (t: unknown): boolean => typeof t === "string" && (tokens.get(t) ?? 0) > Date.now();

    api.registerCommand({
      name: "agent-app",
      description: "Build, evolve, or operate an Agent App — routes the request to the right framework skill.",
      acceptsArgs: true,
      agentPromptGuidance: [AGENT_GUIDANCE],
      handler(ctx: { args?: string }) {
        if (!(ctx.args ?? "").trim()) {
          return {
            text:
              "Usage: /agent-app <what you want>\n" +
              'e.g. "/agent-app build a CRM", "/agent-app add a report to my expense app", "/agent-app operate atlas-erp"',
          };
        }
        return { continueAgent: true };
      },
    });

    // Passthrough: forward every token, flags included, to the framework CLIs in
    // its original order (Commander's own parsing and help are disabled).
    api.registerCli(
      ({ program }) => {
        program
          .command("agent-app")
          .description("Run the framework CLIs (build/evolve/operate an Agent App)")
          .helpOption(false)
          .allowUnknownOption()
          .allowExcessArguments()
          .passThroughOptions()
          .action(async (_opts: unknown, command: { args: string[] }) => {
            const args = command.args;
            const r = await runA2App(binFor(args, CLI, FRAMEWORK_CLI), args);
            process.stdout.write(r.stdout);
            if (r.stderr) process.stderr.write(r.stderr);
            if (r.code !== 0) process.exitCode = r.code;
          });
      },
      { descriptors: [{ name: "agent-app", description: "Run the framework CLIs (build/evolve/operate an Agent App)", hasSubcommands: true }] },
    );

    // The manager page and session transcript are both GETs under the Control-UI
    // cookie grant, whose operator.read scope is what getSessionMessages needs.
    api.registerHttpRoute({
      path: PAGE_ROUTE,
      auth: "gateway",
      match: "prefix",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if ((req.method ?? "GET").toUpperCase() !== "GET") {
          res.statusCode = 405;
          res.setHeader("allow", "GET");
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("The manager page is GET-only; actions go through its API.");
          return;
        }
        const url = new URL(req.url ?? "/", "http://plugin.local");
        const sub = url.pathname.slice(PAGE_ROUTE.length);
        if (sub === "/session") {
          // Echo the frame's origin ("null" when opaque) so the response reads.
          res.setHeader("access-control-allow-origin", String(req.headers.origin ?? "null"));
          res.setHeader("access-control-allow-credentials", "true");
          res.setHeader("vary", "origin");
          res.setHeader("content-type", "application/json");
          try {
            const path = url.searchParams.get("app") ?? "";
            const got = await subagent.getSessionMessages({ sessionKey: sessionKeyFor(path), limit: 200 });
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, messages: got.messages.map(viewMessage).filter((m) => m.text !== "" || m.tools.length > 0) }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, message: String((e as Error)?.message ?? e) }));
          }
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(appManagerHtml({ apiBase: API_ROUTE, homeBase: PAGE_ROUTE, token: mintToken(), blueprints: FRAMEWORK_BLUEPRINTS, steps: INSTALL_STEPS, build: BUILD_STAMP }));
      },
    });

    /** Manager rows: registered apps merged with builds not yet in the registry.
     *  A build entry retires once its app is seen running. */
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

    /**
     * Start an agent run that creates a new app under APPS_DIR, in that app's
     * session: a build from the form, or a source the importer skill converts
     * or adopts. The run shows as a building tab until its app is up.
     */
    async function startAgentRun(name: string, kick: FormActionResult): Promise<{ status: number; out: Record<string, unknown> }> {
      const label = name.trim();
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) return { status: 400, out: { ok: false, message: "Give the app a name." } };
      const dir = join(APPS_DIR, slug);
      if (builds.has(dir)) return { status: 400, out: { ok: false, message: `"${label}" is already being built.` } };
      if (existsSync(dir)) return { status: 400, out: { ok: false, message: `An app directory named "${slug}" already exists.` } };
      if (kick.kind === "error") return { status: 400, out: { ok: false, message: kick.message } };
      mkdirSync(APPS_DIR, { recursive: true });
      const prompt = `${kick.prompt}\n\nCreate the app at \`${dir}\` — pass that directory to every agent-app command.`;
      const run = await detached(() => subagent.run({ sessionKey: sessionKeyFor(dir), message: prompt, deliver: false, lane: `agent-app:${slug}`, cwd: APPS_DIR }));
      seeded.add(sessionKeyFor(dir));
      const entry: BuildEntry = { name: label, dir, ended: false };
      builds.set(dir, entry);
      void detached(() => subagent.waitForRun({ runId: run.runId, timeoutMs: BUILD_WAIT_MS })).then(
        () => { entry.ended = true; },
        () => { entry.ended = true; },
      );
      return { status: 200, out: { ok: true, path: dir } };
    }

    function startBuild(body: Record<string, unknown>): Promise<{ status: number; out: Record<string, unknown> }> {
      const kick = buildKickoffPrompt({ action: "build", name: body.name, requirement: body.requirement, blueprint: body.blueprint, port: body.port });
      return startAgentRun(String(body.name ?? ""), kick);
    }

    /** A source that is not a package, handed to the importer skill: `import` converts it, `adopt` runs it as it is. */
    function startImport(body: Record<string, unknown>): Promise<{ status: number; out: Record<string, unknown> }> {
      const action = body.action === "adopt" ? "adopt" : "import";
      const kick = buildKickoffPrompt({ action, id: body.id, from: body.from, source: body.source, requirement: body.requirement });
      return startAgentRun(String(body.name ?? ""), kick);
    }

    /** Flatten a transcript message to role, concatenated text, and tool names,
     *  so the page can render prose and tool activity separately. */
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

    api.registerHttpRoute({
      path: API_ROUTE,
      auth: "plugin",
      match: "prefix",
      async handler(req: IncomingMessage, res: ServerResponse) {
        // The page is an opaque-origin frame: responses must be CORS-readable and
        // the JSON POST preflight is answered here.
        res.setHeader("access-control-allow-origin", "*");
        const send = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        const method = (req.method ?? "GET").toUpperCase();
        if (method === "OPTIONS") {
          res.statusCode = 204;
          res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
          res.setHeader("access-control-allow-headers", "content-type, x-a2app-token");
          res.end();
          return;
        }
        const url = new URL(req.url ?? "/", "http://plugin.local");
        const sub = url.pathname.slice(API_ROUTE.length);
        try {
          if (!tokenValid(req.headers["x-a2app-token"])) { send(401, { ok: false, message: "invalid or expired page token — reopen the Agent Apps tab" }); return; }
          const reply = (r: ApiReply): void => send(r.status, r.body);

          if (method === "GET" && sub === "/apps") { send(200, { ok: true, rows: await rows() }); return; }
          if (method === "GET" && sub === "/catalogue") { reply(await packages.catalogue({ search: url.searchParams.get("search"), source: url.searchParams.get("source") })); return; }
          if (method === "GET" && sub === "/install") { reply(packages.job(url.searchParams.get("job"))); return; }

          if (method !== "POST") { send(405, { ok: false, message: "method not allowed" }); return; }
          if (sub === "/upload") {
            // The zip itself, not JSON: streamed to a private file, bounded as it arrives.
            const declared = Number(req.headers["content-length"]);
            const r = await packages.upload(req, Number.isFinite(declared) ? declared : undefined);
            if (r.status === 413) res.setHeader("connection", "close"); // the rest of the body is never read
            reply(r);
            return;
          }
          const body = await readBody(req);

          if (sub === "/build") { const r = await startBuild(body); send(r.status, r.out); return; }
          if (sub === "/inspect") { reply(await packages.inspect(body)); return; }
          if (sub === "/install") { reply(packages.install(body)); return; }
          if (sub === "/import/agent") { const r = await startImport(body); send(r.status, r.out); return; }

          if (sub === "/session/send") {
            const path = String(body.path ?? "");
            const text = String(body.text ?? "").trim();
            if (!text) { send(400, { ok: false, message: "empty message" }); return; }
            const sessionKey = sessionKeyFor(path);
            const message = seeded.has(sessionKey) ? text : `${sessionPreamble(String(body.name ?? basename(path)), path)}\n\n${text}`;
            // cwd must exist; before a build's scaffold step the app dir may not.
            await detached(() => subagent.run({ sessionKey, message, deliver: false, lane: `agent-app:${basename(path)}`, cwd: existsSync(path) ? path : APPS_DIR }));
            seeded.add(sessionKey);
            send(200, { ok: true });
            return;
          }

          if (sub === "/app/serve" || sub === "/app/stop" || sub === "/app/remove") {
            const path = String(body.path ?? "");
            const app = await registeredApp(path);
            if (sub !== "/app/remove") {
              if (!app) { send(404, { ok: false, message: "unknown app" }); return; }
              const r = await runA2App(FRAMEWORK_CLI, [path, sub === "/app/serve" ? "serve" : "stop"]);
              send(r.ok ? 200 : 500, { ok: r.ok, message: r.ok ? "" : (r.stderr || r.stdout).trim() });
              return;
            }
            if (!app && !builds.has(path)) { send(404, { ok: false, message: "unknown app" }); return; }
            if (app) {
              await runA2App(FRAMEWORK_CLI, [path, "stop"]);
              const r = await runA2App(FRAMEWORK_CLI, [path, "remove", "--yes"]);
              if (!r.ok) { send(500, { ok: false, message: (r.stderr || r.stdout).trim() }); return; }
            }
            builds.delete(path);
            seeded.delete(sessionKeyFor(path));
            try { await detached(() => subagent.deleteSession({ sessionKey: sessionKeyFor(path), deleteTranscript: true })); } catch { /* no session to delete */ }
            send(200, { ok: true });
            return;
          }

          send(404, { ok: false, message: "unknown endpoint" });
        } catch (e) {
          send(500, { ok: false, message: String((e as Error)?.message ?? e) });
        }
      },
    });

    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "agent-app-home",
      label: "Agent Apps",
      description: "Build, evolve, and operate Agent Apps.",
      icon: "layout",
      path: PAGE_ROUTE,
    });
  },
});
