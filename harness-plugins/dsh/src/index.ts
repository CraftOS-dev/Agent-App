/**
 * Agent App Framework bundle for deepseek-harness (dsh).
 *
 * A real dsh Cordis plugin: `apply(ctx)` registers agent tools that build and
 * operate Agent Apps through the framework CLIs, via
 * `ctx.tools.register(defineTool(...))`. Each tool shells the real CLI through
 * the shared engine, so nothing here is simulated. `client.ts` is the optional
 * browser half that renders a launched app in an iframe.
 *
 * Built by the dsh toolchain, which provides `cordis` and `@deepseek-ai/dsh-tools`
 * as peer dependencies; it is not part of the framework monorepo's `tsc` build.
 */
import type { Context } from "cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { runA2App, binFor } from "@a2app/integration-starter";

/** The a2app binary (or JS entry). Override with A2APP_CLI. */
const CLI = process.env.A2APP_CLI ?? "a2app";
/** Build/evolve binary. The operate client rejects build verbs by design
 *  (framework spec 5.1), so `binFor` routes each verb to its owner. */
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";

type Args = Record<string, unknown>;
const s = (v: unknown) => String(v);
const req = (description: string) => ({ type: "string" as const, required: true, description });
const opt = (description: string) => ({ type: "string" as const, description });

/** Build one dsh tool that shells a CLI verb and returns its output as text. */
function cliTool(name: string, description: string, parameters: Record<string, unknown>, toArgv: (a: Args) => string[]) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: String(value) }],
    },
    async execute(args: Args) {
      const argv = toArgv(args ?? {});
      const r = await runA2App(binFor(argv, CLI, FRAMEWORK_CLI), argv);
      // A guard rejection is useful data; return its message rather than throw.
      return r.stdout || r.stderr || `exit ${r.code}`;
    },
  });
}

export function apply(ctx: Context): void {
  const DIR = req("Agent App project directory");
  const ENTITY = req("entity / collection name");

  // Describe is navigational: one tool taking a PATH, not a tool per operation.
  // A tool list that grew with the app would reproduce the cost and the
  // selection problem the walk exists to remove.
  ctx.tools.register(cliTool("agent_app_describe",
    "Describe ONE place in an Agent App. `path` is empty for the root (its modules), \"sales\" for a module, " +
      "\"sales/invoices\" for an entity, \"sales/invoices/INV-1\" for a record and the operations its state allows. " +
      "Every response names the legal next moves. No call returns the whole model.",
    { dir: DIR, path: opt("module/entity/id path; empty for the root") },
    (a) => [s(a.dir), ...(a.path == null ? [] : s(a.path).split("/").filter((seg) => seg !== ""))]));

  ctx.tools.register(cliTool("agent_app_list", "List records of an entity (optional filter/sort/limit).",
    { dir: DIR, entity: ENTITY, filter: opt("filter expression"), sort: opt("sort field"), limit: { type: "integer", description: "max rows" } },
    (a) => {
      const argv = [s(a.dir), "data", s(a.entity), "list"];
      if (a.filter != null) argv.push("--filter", s(a.filter));
      if (a.sort != null) argv.push("--sort", s(a.sort));
      if (a.limit != null) argv.push("--limit", s(a.limit));
      return argv;
    }));

  ctx.tools.register(cliTool("agent_app_get", "Fetch one record by id.",
    { dir: DIR, entity: ENTITY, id: req("record id") }, (a) => [s(a.dir), "data", s(a.entity), "get", s(a.id)]));

  ctx.tools.register(cliTool("agent_app_create", "Create a record; the app's guard validates it and rejections are returned verbatim.",
    { dir: DIR, entity: ENTITY, fields: { type: "object", required: true, description: "field → value" } },
    (a) => [s(a.dir), "data", s(a.entity), "create", "--json", JSON.stringify(a.fields ?? {})]));

  ctx.tools.register(cliTool("agent_app_update", "Update a record by id.",
    { dir: DIR, entity: ENTITY, id: req("record id"), fields: { type: "object", required: true, description: "field → value" } },
    (a) => [s(a.dir), "data", s(a.entity), "update", s(a.id), "--json", JSON.stringify(a.fields ?? {})]));

  ctx.tools.register(cliTool("agent_app_delete", "Delete a record by id.",
    { dir: DIR, entity: ENTITY, id: req("record id") }, (a) => [s(a.dir), "data", s(a.entity), "delete", s(a.id)]));

  // No `agent_app_operations`: there is no global operation list to return. An
  // operation is found on the screen it belongs to, and invoked at the path that
  // identifies it.
  ctx.tools.register(cliTool("agent_app_find", "Search entity, operation and module names across the app; returns their locations.",
    { dir: DIR, term: req("search term") }, (a) => [s(a.dir), "--find", s(a.term)]));

  ctx.tools.register(cliTool("agent_app_run_operation", "Invoke a declared operation at the path that identifies it. A destructive op returns approval_required with a key; pass `approve` to execute.",
    { dir: DIR, path: req("module/entity/id path the operation was found under"), operation: req("operation name"), fields: { type: "object", description: "operation arguments" }, approve: opt("approval key") },
    (a) => {
      const argv = [s(a.dir), ...s(a.path).split("/").filter((seg) => seg !== ""), s(a.operation)];
      for (const [k, v] of Object.entries((a.fields as Args) ?? {})) argv.push(`--${k}`, s(v));
      if (a.approve != null) argv.push("--approve", s(a.approve));
      return argv;
    }));

  ctx.tools.register(cliTool("agent_app_poll_tasks", "Poll the app→agent task queue (default status: submitted).",
    { dir: DIR, status: opt("task status filter") }, (a) => (a.status != null ? [s(a.dir), "tasks", "--status", s(a.status)] : [s(a.dir), "tasks"])));

  ctx.tools.register(cliTool("agent_app_build", "Scaffold a new Agent App from a blueprint.",
    { dir: DIR, blueprint: opt("blueprint id"), name: opt("app name") },
    (a) => {
      const argv = [s(a.dir), "scaffold"];
      if (a.blueprint != null) argv.push("--blueprint", s(a.blueprint));
      if (a.name != null) argv.push("--name", s(a.name));
      return argv;
    }));

  ctx.tools.register(cliTool("agent_app_validate", "Run the validation + security gate.",
    { dir: DIR, noBuild: { type: "boolean", description: "skip the build step" } },
    (a) => (a.noBuild ? [s(a.dir), "validate", "--no-build"] : [s(a.dir), "validate"])));
}

export default apply;
