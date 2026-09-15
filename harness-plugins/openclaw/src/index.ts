/**
 * Agent App Framework plugin for OpenClaw.
 *
 * A real OpenClaw plugin: it registers agent tools that build and operate Agent
 * Apps through the framework CLIs, an `agent-app` CLI passthrough, and a Control UI
 * tab for a launched app. Every tool shells the real CLI via the shared engine
 * (`@a2app/integration-starter`), so nothing here is simulated.
 *
 * This package is built by the OpenClaw plugin toolchain, which provides
 * `openclaw` and `typebox` as peer dependencies; it is not part of the framework
 * monorepo's own `tsc` build. Drop it in an OpenClaw plugins directory with the
 * accompanying `openclaw.plugin.json`.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, textResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { runA2App, binFor, agentAppFormHtml, handleFormAction, listKnownApps } from "@a2app/integration-starter";

/** The a2app binary (or JS entry) to shell. Override with A2APP_CLI. */
const CLI = process.env.A2APP_CLI ?? "a2app";
/** Build/evolve binary. The operate client rejects build verbs by design
 *  (framework spec 5.1), so `binFor` routes each verb to its owner. */
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";

type Args = Record<string, unknown>;
const s = (v: unknown) => String(v);

export default definePluginEntry({
  id: "a2app",
  name: "Agent App Framework",
  description: "Build and operate full Agent Apps over the A2App protocol via the agent-app and a2app CLIs.",
  register(api) {
    const DIR = Type.String({ description: "Agent App project directory" });
    const ENTITY = Type.String({ description: "entity / collection name" });

    // Register one tool: run the CLI and return its output (a guard rejection is
    // useful data, so a non-zero exit still returns the message to the agent).
    const tool = (
      name: string,
      description: string,
      schema: unknown,
      toArgv: (p: Args) => string[],
    ): void => {
      api.registerTool(() => ({
        name,
        description,
        parameters: schema,
        async execute(_toolCallId: string, params: unknown) {
          const argv = toArgv((params ?? {}) as Args);
          const r = await runA2App(binFor(argv, CLI, FRAMEWORK_CLI), argv);
          return r.json != null ? jsonResult(r.json) : textResult(r.stdout || r.stderr || `exit ${r.code}`);
        },
      }));
    };

    // Describe is navigational: one tool taking a PATH, not a tool per operation.
    tool("agent_app_describe",
      'Describe ONE place in an Agent App. `path` is empty for the root (its modules), "sales" for a module, ' +
        '"sales/invoices" for an entity, "sales/invoices/INV-1" for a record and the operations its state allows. ' +
        "Every response names the legal next moves. No call returns the whole model.",
      Type.Object({ dir: DIR, path: Type.Optional(Type.String()) }),
      (p) => [s(p.dir), ...(p.path == null ? [] : s(p.path).split("/").filter((seg) => seg !== ""))]);

    tool("agent_app_list", "List records of an entity (optional filter/sort/limit).",
      Type.Object({ dir: DIR, entity: ENTITY, filter: Type.Optional(Type.String()), sort: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
      (p) => {
        const a = [s(p.dir), "data", s(p.entity), "list"];
        if (p.filter != null) a.push("--filter", s(p.filter));
        if (p.sort != null) a.push("--sort", s(p.sort));
        if (p.limit != null) a.push("--limit", s(p.limit));
        return a;
      });

    tool("agent_app_get", "Fetch one record by id.",
      Type.Object({ dir: DIR, entity: ENTITY, id: Type.String() }),
      (p) => [s(p.dir), "data", s(p.entity), "get", s(p.id)]);

    tool("agent_app_create", "Create a record; the app's guard validates it and rejections are returned verbatim.",
      Type.Object({ dir: DIR, entity: ENTITY, fields: Type.Record(Type.String(), Type.Unknown()) }),
      (p) => [s(p.dir), "data", s(p.entity), "create", "--json", JSON.stringify(p.fields ?? {})]);

    tool("agent_app_update", "Update a record by id.",
      Type.Object({ dir: DIR, entity: ENTITY, id: Type.String(), fields: Type.Record(Type.String(), Type.Unknown()) }),
      (p) => [s(p.dir), "data", s(p.entity), "update", s(p.id), "--json", JSON.stringify(p.fields ?? {})]);

    tool("agent_app_delete", "Delete a record by id.",
      Type.Object({ dir: DIR, entity: ENTITY, id: Type.String() }),
      (p) => [s(p.dir), "data", s(p.entity), "delete", s(p.id)]);

    // No `agent_app_operations`: no global operation list exists. An operation is
    // found on the screen it belongs to and invoked at the path identifying it.
    tool("agent_app_find", "Search entity, operation and module names across the app; returns their locations.",
      Type.Object({ dir: DIR, term: Type.String() }),
      (p) => [s(p.dir), "--find", s(p.term)]);

    tool("agent_app_run_operation", "Invoke a declared operation at the path that identifies it. A destructive op returns approval_required with a key; pass `approve` to execute.",
      Type.Object({ dir: DIR, path: Type.String(), operation: Type.String(), fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())), approve: Type.Optional(Type.String()) }),
      (p) => {
        const a = [s(p.dir), ...s(p.path).split("/").filter((seg) => seg !== ""), s(p.operation)];
        for (const [k, v] of Object.entries((p.fields as Args) ?? {})) a.push(`--${k}`, s(v));
        if (p.approve != null) a.push("--approve", s(p.approve));
        return a;
      });

    tool("agent_app_poll_tasks", "Poll the app→agent task queue (default status: submitted).",
      Type.Object({ dir: DIR, status: Type.Optional(Type.String()) }),
      (p) => (p.status != null ? [s(p.dir), "tasks", "--status", s(p.status)] : [s(p.dir), "tasks"]));

    tool("agent_app_build", "Scaffold a new Agent App from a blueprint.",
      Type.Object({ dir: DIR, blueprint: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }),
      (p) => {
        const a = [s(p.dir), "scaffold"];
        if (p.blueprint != null) a.push("--blueprint", s(p.blueprint));
        if (p.name != null) a.push("--name", s(p.name));
        return a;
      });

    tool("agent_app_validate", "Run the validation + security gate.",
      Type.Object({ dir: DIR, noBuild: Type.Optional(Type.Boolean()) }),
      (p) => (p.noBuild ? [s(p.dir), "validate", "--no-build"] : [s(p.dir), "validate"]));

    // A CLI passthrough: `openclaw agent-app <args...>`.
    api.registerCli((program: { command: (name: string) => { description: (d: string) => { action: (fn: (argv: string[]) => Promise<void>) => unknown } } }) => {
      program
        .command("agent-app")
        .description("Run the framework CLIs (build/evolve/operate an Agent App)")
        .action(async (argv: string[]) => {
          const r = await runA2App(binFor(argv, CLI, FRAMEWORK_CLI), argv);
          process.stdout.write(r.stdout);
          if (r.stderr) process.stderr.write(r.stderr);
        });
    });

    // The entry-point FORM — the framework's front door in the Control UI. An HTTP
    // route serves the form (GET) and turns a submission into a kickoff prompt
    // (POST); a Control UI tab points at that route, rendered in a sandboxed frame
    // (this is the standard "tab → plugin HTTP route" path, so it needs no Custom
    // plugin UI lab flag). GET/POST share ONE path so the form can POST to its own
    // URL — no base-path guessing inside the frame.
    api.registerHttpRoute({
      path: ENTRY_ROUTE,
      auth: "gateway",
      match: "prefix",
      async handler(req: HttpReq, res: HttpRes) {
        try {
          if ((req.method ?? "GET").toUpperCase() === "GET") {
            const apps = await listKnownApps(FRAMEWORK_CLI);
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(agentAppFormHtml({ apps }));
            return;
          }
          const body = await readJsonBody(req);
          const result = await handleFormAction(body, { frameworkBin: FRAMEWORK_CLI });
          // A kickoff routes the agent to the owning skill with the user's context.
          // The form also echoes the prompt, so this hand-off is an enhancement, not
          // the only path: if it no-ops the operator still has the prompt to send.
          if (result.kind === "kickoff") startAgentTurn(api, result.prompt);
          res.statusCode = result.kind === "error" ? 400 : 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ kind: "error", message: String((e as Error)?.message ?? e) }));
        }
      },
    });

    // Advertise the entry tab so it appears whenever the plugin is enabled.
    api.session?.controls?.registerControlUiDescriptor?.({
      surface: "tab",
      id: "agent-app-home",
      label: "Agent Apps",
      description: "Build, evolve, or operate an Agent App.",
      icon: "layout",
      path: ENTRY_ROUTE,
    });
  },
});

/** The plugin HTTP route that serves the entry form; also the Control UI tab path. */
const ENTRY_ROUTE = "/agent-app/home";

/** Minimal shape of the request/response the OpenClaw HTTP route handler receives
 *  (Node-style). Kept local and loose so the binding does not depend on SDK types
 *  the framework monorepo cannot resolve. */
interface HttpReq {
  method?: string;
  body?: unknown;
  on?(event: string, cb: (chunk?: unknown) => void): void;
}
interface HttpRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** Read a JSON body whether the host pre-parsed it (req.body) or handed us a raw
 *  Node stream. Returns {} on anything unparseable — the action handler then
 *  reports a clean validation error rather than throwing. */
async function readJsonBody(req: HttpReq): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  if (typeof req.on !== "function") return {};
  const raw = await new Promise<string>((resolve) => {
    let data = "";
    req.on!("data", (c) => (data += String(c)));
    req.on!("end", () => resolve(data));
    req.on!("error", () => resolve(""));
  });
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

/**
 * Hand the kickoff prompt to the agent session. OpenClaw's session-send API name
 * has shifted across versions, so this probes the known shapes and no-ops if none
 * is present — the form always echoes the prompt as the guaranteed fallback.
 * VERIFY against the target OpenClaw SDK and collapse to the one real call.
 */
function startAgentTurn(api: unknown, prompt: string): void {
  const s = (api as { session?: Record<string, unknown>; logger?: { warn?: (m: string) => void } }).session;
  const send =
    (s?.enqueueMessage as ((a: unknown) => unknown) | undefined) ??
    (s?.sendMessage as ((a: unknown) => unknown) | undefined) ??
    ((s?.turns as { start?: (a: unknown) => unknown } | undefined)?.start);
  try {
    if (send) send({ text: prompt, timeoutSeconds: 0 });
    else (api as { logger?: { warn?: (m: string) => void } }).logger?.warn?.("Agent App: no session-send API found; the form's copyable prompt is the hand-off.");
  } catch (e) {
    (api as { logger?: { warn?: (m: string) => void } }).logger?.warn?.("Agent App: agent hand-off failed: " + String(e));
  }
}

/**
 * Contribute a Control UI tab for a launched app. Call once the app is healthy.
 * OpenClaw renders the tab in a sandboxed frame; `path` is the app's own URL.
 */
export function showAgentApp(
  api: { session: { controls: { registerControlUiDescriptor: (d: Record<string, unknown>) => void } } },
  app: { id: string; name: string; url: string },
): void {
  api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: `agent-app-${app.id}`,
    label: app.name,
    icon: "layout",
    path: app.url,
  });
}
