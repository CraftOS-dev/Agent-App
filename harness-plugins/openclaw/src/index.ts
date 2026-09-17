/**
 * Agent App Framework plugin for OpenClaw — the Agent Apps manager.
 *
 * Registers an `/agent-app` chat command, an `openclaw agent-app …` CLI
 * passthrough, and an "Agent Apps" Control-UI tab that is a full app manager:
 * every Agent App is a browser-style tab embedding the running app, with a
 * dedicated OpenClaw session per app in a side panel, lifecycle actions
 * (launch / pause / delete), and a build form whose "Build it" button starts
 * the agent's creator-skill run directly — no prompt copy-pasting.
 *
 * Two HTTP surfaces:
 *  - `/agent-app/home` (`auth: "gateway"`) serves the page. Only the
 *    authenticated Control UI can load it; each load embeds a fresh API token.
 *  - `/agent-app/api` (`auth: "plugin"`) is the JSON API the page calls. The
 *    plugin owns its auth (the page token) and CORS (the tab frame is an
 *    opaque origin, so every response carries `access-control-allow-origin: *`
 *    and OPTIONS preflights are answered here).
 *
 * Agent work runs through OpenClaw's plugin runtime: `runtime.subagent.run`
 * drives each app's dedicated session (the workboard pattern) and lifecycle
 * actions shell the framework CLI (`serve` / `stop` / `remove`). Built by
 * `pnpm --filter @a2app/integration-openclaw build` into the installable
 * `dist/`: `openclaw plugins install ./harness-plugins/openclaw/dist`.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runA2App, binFor, buildKickoffPrompt, listKnownApps, FRAMEWORK_BLUEPRINTS, type KnownApp } from "@a2app/integration-starter";
import { appManagerHtml } from "./ui.js";

/** The a2app binary (or JS entry) to shell. Override with A2APP_CLI. */
const CLI = process.env.A2APP_CLI ?? "a2app";
/** Build/evolve binary. The operate client rejects build verbs by design
 *  (framework spec 5.1), so `binFor` routes each verb to its owner. */
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";

/** Where this host puts NEW apps. The framework imposes no app home (the
 *  registry stores absolute paths, spec 5.6) — the directory convention is the
 *  caller's, and this host keeps apps under the framework home. */
const APPS_DIR = join(process.env.A2APP_HOME ?? join(homedir(), ".a2app"), "apps");

const PAGE_ROUTE = "/agent-app/home";
const API_ROUTE = "/agent-app/api";
/** Stamped by scripts/build.mjs into the staged bundle; identifies which build
 *  a running gateway actually loaded (shown in the page footer). */
const BUILD_STAMP = process.env.A2APP_PLUGIN_BUILD ?? "dev";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** How long to track a build run before declaring its outcome unknown. */
const BUILD_WAIT_MS = 2 * 60 * 60 * 1000;

/** Standing system-prompt guidance registered with the `/agent-app` command, so
 *  the agent routes a request through the framework skills instead of building
 *  or operating from general knowledge. */
const AGENT_GUIDANCE =
  "The /agent-app command is the front door to the Agent App Framework. An Agent App is a " +
  "self-contained full-stack web app operated through its A2App adapter (the `a2app` CLI) — " +
  "never by driving the UI. When a message asks to build, change, run, import, verify, or " +
  "connect to an app, load the matching framework skill and follow it end to end: creator " +
  "(build a NEW app), modify (change an EXISTING app), operator (use/read/run an app, no code " +
  "changes), importer (adopt existing software), walk-verify (independent verification), " +
  "connect (a published app you do not own). Do not build or operate an app from general " +
  "knowledge outside these skills. `agent-app list` locates every known Agent App.";

/** Each app's dedicated session, keyed by its directory name — stable from the
 *  moment a build starts through the app's whole life (workboard's derived-key
 *  pattern). */
const sessionKeyFor = (path: string): string => `subagent:agent-app:${basename(path)}`;

/** First message of an app's session carries the working context; every later
 *  send is just the user's text — the session itself holds the history. */
const sessionPreamble = (name: string, path: string): string =>
  `You are working on the Agent App "${name}" at \`${path}\`. For a code or feature change ` +
  "load the **modify** skill; for using the app (data, tasks, reports) load the **operator** " +
  "skill. Work through the `agent-app` and `a2app` CLIs, respect the ownership boundary, and " +
  "never drive the app UI.";

/** Mirrors the verified shapes in OpenClaw's plugin runtime
 *  (src/plugins/runtime/types.ts); local because the SDK types resolve only in
 *  OpenClaw's own toolchain. */
interface SubagentRuntime {
  run(p: { sessionKey: string; message: string; deliver: boolean; lane: string; cwd: string }): Promise<{ runId: string }>;
  waitForRun(p: { runId: string; timeoutMs: number }): Promise<unknown>;
  getSessionMessages(p: { sessionKey: string; limit: number }): Promise<{ messages: unknown[] }>;
  deleteSession(p: { sessionKey: string; deleteTranscript: boolean }): Promise<void>;
}

/** An in-flight (or finished-but-unconfirmed) build started from the form. */
interface BuildEntry {
  name: string;
  dir: string;
  ended: boolean;
}

/** One row of the manager UI: a registered app, or a build not yet registered. */
interface AppRow extends KnownApp {
  sessionKey: string;
  building: boolean;
  buildEnded: boolean;
}

export default definePluginEntry({
  id: "a2app",
  name: "Agent App Framework",
  description: "Build and operate full Agent Apps over the A2App protocol via the agent-app and a2app CLIs.",
  register(api) {
    const subagent = (api as unknown as { runtime: { subagent: SubagentRuntime } }).runtime.subagent;
    const tokens = new Map<string, number>();
    const builds = new Map<string, BuildEntry>();

    // Plugin-runtime calls made inside an HTTP request inherit that request's
    // scope client — which for an `auth:"plugin"` route carries NO operator
    // scopes, so `subagent.run` is refused with "missing scope: operator.write".
    // OpenClaw grants agent runs system (write) authority only in contexts with
    // no request client, and the only contexts guaranteed clean are the ones
    // the HOST invokes (its own background extensions run from cron/lifecycle
    // callbacks). So write calls queue here, and the drain timer is created
    // inside the `gateway_start` hook — a host-invoked startup context whose
    // AsyncLocalStorage every job then inherits.
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

    /** Sessions this gateway process has already seeded with the app context
     *  preamble (the build kickoff seeds it too). After a gateway restart the
     *  first chat message re-carries the preamble — harmless repetition that
     *  keeps the send path free of any transcript read. */
    const seeded = new Set<string>();

    const mintToken = (): string => {
      const now = Date.now();
      for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
      const t = randomBytes(24).toString("hex");
      tokens.set(t, now + TOKEN_TTL_MS);
      return t;
    };
    const tokenValid = (t: unknown): boolean => typeof t === "string" && (tokens.get(t) ?? 0) > Date.now();

    // The chat command — hands the request to the agent (`continueAgent: true`),
    // where AGENT_GUIDANCE routes it to the owning framework skill.
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

    // A CLI passthrough: `openclaw agent-app …`. Commander's own option parsing
    // and help are off (the gateway restart-handoff passthrough shape) and the
    // action reads `command.args`: with passThroughOptions, everything after
    // the first operand — flags like `--json` included — stays an operand in
    // its original order.
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

    // ── The manager page + transcript read (gateway-authenticated) ──
    // Both are GETs riding the Control-UI cookie grant: the page load, and the
    // session transcript — the grant's `operator.read` is exactly the scope
    // `getSessionMessages` needs, so the read runs inside the request scope.
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
          // The page frame fetches with credentials; echo its origin ("null"
          // when the frame is opaque) so the response is readable there.
          res.setHeader("access-control-allow-origin", String(req.headers.origin ?? "null"));
          res.setHeader("access-control-allow-credentials", "true");
          res.setHeader("vary", "origin");
          res.setHeader("content-type", "application/json");
          try {
            const path = url.searchParams.get("app") ?? "";
            const got = await subagent.getSessionMessages({ sessionKey: sessionKeyFor(path), limit: 200 });
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, messages: got.messages.map(viewMessage).filter((m) => m.text !== "") }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, message: String((e as Error)?.message ?? e) }));
          }
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(appManagerHtml({ apiBase: API_ROUTE, homeBase: PAGE_ROUTE, token: mintToken(), blueprints: FRAMEWORK_BLUEPRINTS, build: BUILD_STAMP }));
      },
    });

    // ── The JSON API (plugin-authenticated: the page token is the credential) ──

    /** The manager rows: registered apps merged with builds the registry does
     *  not know yet. A build entry retires the moment its app is seen running. */
    async function rows(): Promise<AppRow[]> {
      const apps = await listKnownApps(FRAMEWORK_CLI);
      for (const a of apps) if (a.status === "running") builds.delete(a.path);
      const out: AppRow[] = apps.map((a) => {
        const b = builds.get(a.path);
        return { ...a, sessionKey: sessionKeyFor(a.path), building: b != null && !b.ended, buildEnded: b?.ended === true };
      });
      for (const b of builds.values()) {
        if (apps.some((a) => a.path === b.dir)) continue;
        out.push({
          id: basename(b.dir), name: b.name, path: b.dir, url: null,
          sessionKey: sessionKeyFor(b.dir), building: !b.ended, buildEnded: b.ended, status: "stopped",
        });
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
      const run = await detached(() => subagent.run({ sessionKey: sessionKeyFor(dir), message: prompt, deliver: false, lane: `agent-app:${slug}`, cwd: APPS_DIR }));
      seeded.add(sessionKeyFor(dir));
      const entry: BuildEntry = { name, dir, ended: false };
      builds.set(dir, entry);
      // Track the run to its end (or to the tracking horizon); the UI then shows
      // "build session ended" until the app is actually seen running.
      void detached(() => subagent.waitForRun({ runId: run.runId, timeoutMs: BUILD_WAIT_MS })).then(
        () => { entry.ended = true; },
        () => { entry.ended = true; },
      );
      return { status: 200, out: { ok: true, path: dir } };
    }

    /** Render-ready view of a session message: role + concatenated text parts. */
    function viewMessage(m: unknown): { role: string; text: string } {
      const r = m as Record<string, unknown>;
      const role = typeof r.role === "string" ? r.role : "";
      const c = r.content;
      const text = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((p) => { const q = p as Record<string, unknown>; return typeof q.text === "string" ? q.text : ""; }).join("")
          : "";
      return { role, text };
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
        // The page is an opaque-origin frame, so every response must be CORS-
        // readable and the JSON POST preflight is answered here.
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

          if (method === "GET" && sub === "/apps") { send(200, { ok: true, rows: await rows() }); return; }

          if (method !== "POST") { send(405, { ok: false, message: "method not allowed" }); return; }
          const body = await readBody(req);

          if (sub === "/build") { const r = await startBuild(body); send(r.status, r.out); return; }

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
            // Session cleanup is best-effort: the app is already gone, and a
            // session that never ran has nothing to delete.
            try { await detached(() => subagent.deleteSession({ sessionKey: sessionKeyFor(path), deleteTranscript: true })); } catch { /* no session existed */ }
            send(200, { ok: true });
            return;
          }

          send(404, { ok: false, message: "unknown endpoint" });
        } catch (e) {
          send(500, { ok: false, message: String((e as Error)?.message ?? e) });
        }
      },
    });

    // The Control-UI tab pointing at the manager page.
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
