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
import { runA2App, FRAMEWORK_VERBS } from "@a2app/integration-starter";

/** The a2app binary (or JS entry) to shell. Override with A2APP_CLI. */
const CLI = process.env.A2APP_CLI ?? "a2app";
/** Build/evolve binary. The operate client rejects build verbs by design
 *  (framework spec 5.1), so route each verb to its owner. */
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";
const binFor = (argv: string[]): string => (FRAMEWORK_VERBS.has(argv[0] ?? "") ? FRAMEWORK_CLI : CLI);

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
          const r = await runA2App(binFor(toArgv((params ?? {}) as Args)), toArgv((params ?? {}) as Args));
          return r.json != null ? jsonResult(r.json) : textResult(r.stdout || r.stderr || `exit ${r.code}`);
        },
      }));
    };

    tool("agent_app_describe", "Read an Agent App's entities, fields, and declared operations.",
      Type.Object({ dir: DIR }),
      (p) => [s(p.dir), "data", "schema"]);

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

    tool("agent_app_operations", "List the app's declared operations.",
      Type.Object({ dir: DIR }),
      (p) => [s(p.dir), "ops"]);

    tool("agent_app_run_operation", "Invoke a declared operation. A destructive op returns approval_required with a key; pass `approve` to execute.",
      Type.Object({ dir: DIR, operation: Type.String(), fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())), approve: Type.Optional(Type.String()) }),
      (p) => {
        const a = [s(p.dir), "run", s(p.operation)];
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
          const r = await runA2App(binFor(argv), argv);
          process.stdout.write(r.stdout);
          if (r.stderr) process.stderr.write(r.stderr);
        });
    });
  },
});

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
