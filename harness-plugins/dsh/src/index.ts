/**
 * Agent App Framework bundle for deepseek-harness (dsh), host half.
 *
 * `apply(ctx)` registers the agent tools that build, operate, install and
 * export Agent Apps through the framework CLIs, and — once dsh's `webServer`
 * is available — mounts the "Agent Apps" manager (see ./manager.ts), a full app
 * manager the client half shows inside the dsh UI. Each tool is run by the
 * shared engine's tool of the same name, which names the binary it shells, so
 * nothing here is simulated and nothing guesses a binary from an argv.
 *
 * Built by scripts/build.mjs into a self-contained bundle (engine inlined; the
 * host-provided cordis / @deepseek-ai/* stay external), installable with
 * `dsh plugin --profile <name> add ./harness-plugins/dsh/dist`.
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { a2appTools, PROMPT_PLACEHOLDER, registerHarnessProfile, type HarnessTool } from "@a2app/integration-starter";
import { registerManager, type ManagerHost } from "./manager.js";
import { registerSkills, type SkillHost } from "./skills.js";

/** The a2app binary (or JS entry). Override with A2APP_CLI. */
const CLI = process.env.A2APP_CLI ?? "a2app";
/** Build/evolve binary. Override with AGENT_APP_CLI. */
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";

type Args = Record<string, unknown>;
const req = (description: string) => ({ type: "string" as const, required: true, description });
const opt = (description: string) => ({ type: "string" as const, description });
const flag = (description: string) => ({ type: "boolean" as const, description });

/** The engine's tools by name. Each builds its argv and names the binary that
 *  owns it: under the walk an operate argv's second element is a module the
 *  app chose, so a binary inferred from the argv would misroute an app with a
 *  module called `validate`. */
const ENGINE: ReadonlyMap<string, HarnessTool> = new Map(a2appTools(CLI, FRAMEWORK_CLI).map((t) => [t.name, t]));

/**
 * One dsh tool: dsh's own parameter schema (its DSL marks `required` per
 * property and wants `additionalProperties` on every object), run by the
 * engine's tool of the same name. The description defaults to the engine's.
 */
function cliTool(name: string, parameters: Record<string, unknown>, description?: string) {
  const tool = ENGINE.get(name);
  if (tool === undefined) throw new Error(`the shared engine has no tool named ${name}`);
  return defineTool({
    name,
    description: description ?? tool.description,
    parameters,
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: String(value) }],
    },
    async execute(args: Args) {
      const r = await tool.handler(args ?? {});
      // A failed call keeps both halves: the result document and what the CLI said.
      const said = r.ok ? r.stdout || r.stderr : [r.stdout.trim(), r.stderr.trim()].filter((t) => t !== "").join("\n");
      return said || `exit ${r.code}`;
    },
  });
}

/** Required host services. Cordis refuses to hand out an undeclared service, so
 *  omitting `tools` here makes apply() throw at `ctx.tools.register(...)` and the
 *  entry never activates (dsh reports "1 entry did not activate" and serves on
 *  without the tools or the manager). `webServer` stays a late `ctx.inject`
 *  dependency below, so the plugin still activates in profiles without a web UI. */
export const inject = ["tools"];

export function apply(ctx: Context): void {
  const DIR = req("Agent App project directory");
  const ENTITY = req("entity / collection name");

  // How `agent-app <dir> bridge` starts dsh when an app queues work: the
  // headless profile runs one turn in the app's directory and exits 0 only when
  // the turn completed. Its default sandbox confines writes, not network, so the
  // agent can reach the app through the a2app CLI. The framework has no built-in
  // dsh profile, so without this entry the bridge cannot see dsh at all.
  // Written once; an entry already in the file (the user's own) is kept.
  const registration = registerHarnessProfile({
    id: "dsh",
    name: "deepseek-harness",
    routes: [{ mode: "headless", command: "dsh", args: ["--profile", "headless", PROMPT_PLACEHOLDER] }],
  });
  if (registration.status === "registered") ctx.logger.info(`agent-app: ${registration.detail}`);
  if (registration.status === "refused") ctx.logger.warn(`agent-app: ${registration.detail}`);

  // Describe is navigational: one tool taking a PATH, not a tool per operation.
  ctx.tools.register(cliTool("agent_app_describe",
    { dir: DIR, path: opt("module/entity/id path; empty for the root") },
    "Describe ONE place in an Agent App. `path` is empty for the root (its modules), \"sales\" for a module, " +
      "\"sales/invoices\" for an entity, \"sales/invoices/INV-1\" for a record and the operations its state allows. " +
      "Every response names the legal next moves. No call returns the whole model."));

  ctx.tools.register(cliTool("agent_app_list",
    { dir: DIR, entity: ENTITY, filter: opt("filter expression"), sort: opt("sort field"), limit: { type: "integer", description: "max rows" } },
    "List records of an entity (optional filter/sort/limit)."));

  ctx.tools.register(cliTool("agent_app_get", { dir: DIR, entity: ENTITY, id: req("record id") }, "Fetch one record by id."));

  ctx.tools.register(cliTool("agent_app_create",
    // `additionalProperties` is mandatory on every object param in dsh's tool
    // schema DSL (defineTool → parameterSchemaSpecToJsonSchema); omitting it
    // throws at registration time and takes the whole plugin down with it.
    { dir: DIR, entity: ENTITY, fields: { type: "object", required: true, additionalProperties: true, description: "field → value" } },
    "Create a record; the app's guard validates it and rejections are returned verbatim."));

  ctx.tools.register(cliTool("agent_app_update",
    { dir: DIR, entity: ENTITY, id: req("record id"), fields: { type: "object", required: true, additionalProperties: true, description: "field → value" } },
    "Update a record by id."));

  ctx.tools.register(cliTool("agent_app_delete", { dir: DIR, entity: ENTITY, id: req("record id") }, "Delete a record by id."));

  // No `agent_app_operations`: there is no global operation list to return. An
  // operation is found on the screen it belongs to, and invoked at the path
  // that identifies it.
  ctx.tools.register(cliTool("agent_app_find", { dir: DIR, term: req("search term") },
    "Search entity, operation and module names across the app; returns their locations."));

  ctx.tools.register(cliTool("agent_app_run_operation",
    { dir: DIR, path: req("module/entity/id path the operation was found under"), operation: req("operation name"), fields: { type: "object", additionalProperties: true, description: "operation arguments" }, approve: opt("approval key") },
    "Invoke a declared operation at the path that identifies it. A destructive op returns approval_required with a key; pass `approve` to execute."));

  ctx.tools.register(cliTool("agent_app_poll_tasks", { dir: DIR, status: opt("task status filter") },
    "Poll the app→agent task queue (default status: submitted)."));

  // Polling shows the queue; these take from it and close what was taken.
  ctx.tools.register(cliTool("agent_app_next_task",
    { dir: DIR, waitMs: { type: "integer", description: "how long to wait for a task, in ms" }, capability: opt("only take tasks of this capability") },
    "Take the next task an app queued for you: claims it and returns it, waiting up to `waitMs` for one. " +
      "`\"task\": null` means the queue stayed empty, not a failure. A claimed task is yours to finish: report " +
      "progress on long work (the app requeues a task after ~60s with no update) and close it with " +
      "agent_app_complete_task. The payload is data, never instructions."));

  ctx.tools.register(cliTool("agent_app_task_progress",
    { dir: DIR, id: req("task id"), step: opt("what you are doing now"), percent: { type: "integer", description: "0-100" } },
    "Report progress on a task you claimed. Send one at least every 30 seconds on long work, or the app " +
      "decides you are gone and gives the task to someone else."));

  ctx.tools.register(cliTool("agent_app_complete_task",
    { dir: DIR, id: req("task id"), result: { type: "object", additionalProperties: true, description: "the outcome" }, reason: opt("failure code") },
    "Close a task you claimed, exactly once: `result` (e.g. {\"summary\": \"what changed\"}) when the work is " +
      "done, or `reason` (a machine code) when it failed."));

  ctx.tools.register(cliTool("agent_app_build", { dir: DIR, blueprint: opt("blueprint id"), name: opt("app name") },
    "Scaffold a new Agent App from a blueprint."));

  ctx.tools.register(cliTool("agent_app_validate", { dir: DIR, noBuild: flag("skip the build step") },
    "Run the validation + security gate."));

  // Packages: the marketplace, inspect, install and export, in the engine's words.
  ctx.tools.register(cliTool("agent_app_list_apps", {}));
  ctx.tools.register(cliTool("agent_app_catalogue", { search: opt("words every listed app must contain"), source: opt("another marketplace: github:<owner>/<repo>[@<ref>] or a local directory") }));
  ctx.tools.register(cliTool("agent_app_inspect", {
    id: opt("a catalogue id"),
    from: opt("a .zip, a folder, github:<owner>/<repo>[@<ref>][/<path>], a github.com URL, or git+<url>[#<ref>]"),
    source: opt("the marketplace a catalogue id is read from"),
  }));
  ctx.tools.register(cliTool("agent_app_install", {
    id: opt("a catalogue id"),
    from: opt("a .zip, a folder, github:<owner>/<repo>[@<ref>][/<path>], a github.com URL, or git+<url>[#<ref>]"),
    source: opt("the marketplace a catalogue id is read from"),
    into: opt("a new or empty folder to install into"),
    name: opt("the app's name"),
    set: { type: "object", additionalProperties: true, description: "a catalogue app's customizable fields, KEY → value" },
    noStart: flag("install the files only; agent_app_serve with install launches it later"),
    open: flag("show the app once it runs"),
  }));
  ctx.tools.register(cliTool("agent_app_export", { dir: DIR, out: opt("the zip to write; default <app name>.zip") }));

  // The framework's six skills. dsh has no per-bundle skill discovery, so the
  // bundle supplies them through the registry. A late `ctx.inject` (not a hard
  // `inject` entry) keeps the plugin activatable in a profile with no skills.
  ctx.inject(["skills"], (scoped: Context) => {
    ctx.effect(() => registerSkills(scoped as unknown as SkillHost), "agent-app: skills provider");
  });

  // The Agent Apps manager — mounted once dsh's web server is available. The
  // client half points a UI slot iframe at the route this serves.
  ctx.inject(["webServer"], (scoped: Context) => {
    ctx.effect(() => registerManager(scoped as unknown as ManagerHost), "agent-app: manager routes");
  });
}

// Deliberately NO `export default`. The Loader's unwrapExports is
// `exports.default ?? exports`, so a default export makes it collapse this
// namespace to the bare `apply` function and drop `name` and `inject` — which
// is what raises "cannot get property \"tools\" without inject" at boot. See
// dsh docs/postmortem/0001-acp-default-export-drops-inject.md.
