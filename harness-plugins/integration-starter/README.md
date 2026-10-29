# @a2app/integration-starter

The shared engine every harness plugin is built on, and the copy-to-create template for a new harness.

A plugin's real job is small and identical everywhere: expose the `agent-app` and `a2app` CLIs as agent tools, ship the skills, and embed a launched app in the harness UI. This package implements all of it; a harness plugin is a thin binding that maps its host's plugin API onto `HarnessContext`.

## Exports

| Export | What it does |
|---|---|
| `a2appTools(cliBin?, frameworkBin?)` | The 22 tools. **Operate** (`a2app`): `agent_app_describe`, `_find`, `_list`, `_get`, `_create`, `_update`, `_delete`, `_run_operation`, and the task tools `_poll_tasks`, `_next_task`, `_task_progress`, `_complete_task`, which take work an app queued and close it. **Build and run** (`agent-app`): `_build`, `_validate`, `_serve`, `_stop`, `_open`, `_list_apps`. **Packages** (`agent-app`, [packaging spec](../../spec/v0_2/packaging.md)): `_catalogue {search?, source?}`, `_inspect {id \| from, source?}`, `_install {id \| from, source?, into?, name?, set?, noStart?, open?}`, `_export {dir, out?}`. Each shells a real verb on the binary it names. `_install` returns the CLI's result; its description tells the agent that `trust: "catalogued"` owes nothing more and `"untrusted"` owes a walk-verify, and to do what `next` lists. There is deliberately no `agent_app_operations`: an operation is found on the screen it belongs to, never in a global list. |
| `registerA2AppPlugin(ctx, opts?)` | Register every tool + the skills bundle + an `agent-app` passthrough command into a `HarnessContext`. |
| `runA2App(cliBin, argv, { onLine? })` | Run the CLI and return `{ code, ok, stdout, stderr, json }`; `onLine` sees each stdout line as it is written. **Never uses a shell** — field values reach the CLI as literal argv, so injection is impossible. Point `cliBin` at a `…/cli.js` entry to run it via Node. |
| `binFor(argv)`, `FRAMEWORK_VERBS`, `REGISTRY_VERBS` | Route a hand-typed argv (a passthrough command) to the binary that owns its verb. The tables copy the CLI's command table, and the test asks the built CLI about every command module it has, so the two cannot drift apart unnoticed. |
| `runInstall(frameworkBin, request, onStep)`, `parseInstallEvent(line)`, `INSTALL_STEPS` | For a UI: run `install … --events` and get a callback per step line (`step`, `status`: `start`, `done`, `failed` or `skipped`, plus its detail), then the result. |
| `PackageApi`, `InstallJobs`, `saveUpload` | A manager tab's marketplace and import routes, independent of how a harness serves HTTP: `catalogue`, `inspect`, `install` (starts a job and returns at once), `job` (each step's state, then the result), `upload` (a zip saved privately for `--from`, 512 MiB at most). A page polls the job, so no client timeout is ever shorter than the CLI's own. |
| `buildKickoffPrompt(body)` | The prompt that hands a form to the agent, naming the owning skill: `build` (creator), `modify`, `operate` (operator), and `install`, `import` (convert) and `adopt` (importer). |
| `registerHarnessProfile(profile)` | Make this harness reachable from `agent-app <dir> bridge`: adds its route to `$A2APP_HOME/harnesses.json` when no profile with that id exists, and otherwise leaves the file alone (never overwrites an entry, never sets `default`, never rewrites a file it cannot parse). Returns `registered` / `kept` / `refused` for the plugin to log. |
| `showAgentApp(ctx, app)` | Register an embedded display for a launched app. `registerA2AppPlugin` calls this automatically when the host implements `registerDisplay` (for `agent_app_serve` and `agent_app_install`), and suppresses the CLI's own browser opener so the user gets an embedded view instead of a stray window. |

## Verified

`pnpm test` runs two suites. `test/harness.test.mjs` pins the harness-file rules, the argv every package tool builds, how `--events` lines are read, the kickoffs, and the router, checked verb by verb against the built CLI. `test/packages.test.mjs` drives the manager routes against a fake CLI, then the real install path through the tools against a marketplace that is a local directory: `agent_app_catalogue`, `agent_app_install` with `noStart`, `agent_app_list_apps`, `agent_app_export`, `agent_app_inspect` of the export, and an install job followed step by step. Neither uses the network.

The six harness plugins in [`../`](../) each bind this engine to a real harness API (Hermes through a Python port of it).
