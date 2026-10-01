# @a2app/integration-starter

The shared engine every harness plugin is built on, and the copy-to-create template for a new harness.

A plugin's real job is small and identical everywhere: expose the `agent-app` and `a2app` CLIs as agent tools, ship the skills, and embed a launched app in the harness UI. This package implements all of it; a harness plugin is a thin binding that maps its host's plugin API onto `HarnessContext`.

## Exports

| Export | What it does |
|---|---|
| `a2appTools(cliBin?, frameworkBin?)` | The 17 build+operate tools (`agent_app_describe`, `_find`, `_list`, `_get`, `_create`, `_update`, `_delete`, `_run_operation`, `_poll_tasks`, `_next_task`, `_task_progress`, `_complete_task`, `_build`, `_validate`, `_serve`, `_stop`, `_open`). The three task tools are how an agent takes work an app queued for it and closes it. Each shells a real verb on the owning binary (`agent-app` for build/evolve, `a2app` for operate). There is deliberately no `agent_app_operations`: an operation is found on the screen it belongs to, never in a global list. |
| `registerA2AppPlugin(ctx, opts?)` | Register every tool + the skills bundle + an `agent-app` passthrough command into a `HarnessContext`. |
| `runA2App(cliBin, argv)` | Run the CLI and return `{ code, ok, stdout, stderr, json }`. **Never uses a shell** — field values reach the CLI as literal argv, so injection is impossible. Point `cliBin` at a `…/cli.js` entry to run it via Node. |
| `registerHarnessProfile(profile)` | Make this harness reachable from `agent-app <dir> bridge`: adds its route to `$A2APP_HOME/harnesses.json` when no profile with that id exists, and otherwise leaves the file alone (never overwrites an entry, never sets `default`, never rewrites a file it cannot parse). Returns `registered` / `kept` / `refused` for the plugin to log. |
| `showAgentApp(ctx, app)` | Register an embedded display for a launched app. `registerA2AppPlugin` calls this automatically when the host implements `registerDisplay`, and suppresses the CLI's own browser opener so the user gets an embedded view instead of a stray window. |

## Verified

The engine drives the real CLIs end-to-end: `agent_app_build` (`agent-app <dir> scaffold`) scaffolds an app and `agent_app_validate` (`agent-app <dir> validate`) runs the gate (both exit 0). Every other tool uses the same `runA2App` path.

The five harness plugins in [`../`](../) each bind this engine to a real harness API.
