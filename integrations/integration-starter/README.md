# @a2app/integration-starter

The shared engine every harness plugin is built on, and the copy-to-create template for a new harness.

A plugin's real job is small and identical everywhere: expose the `agent-app` and `a2app` CLIs as agent tools, ship the skills, and embed a launched app in the harness UI. This package implements all of it; a harness plugin is a thin binding that maps its host's plugin API onto `HarnessContext`.

## Exports

| Export | What it does |
|---|---|
| `a2appTools(cliBin?, frameworkBin?)` | The 12 build+operate tools (`agent_app_describe`, `_list`, `_get`, `_create`, `_update`, `_delete`, `_operations`, `_run_operation`, `_poll_tasks`, `_build`, `_validate`, `_walk_verify`). Each shells a real verb on the owning binary (`agent-app` for build/evolve, `a2app` for operate). |
| `registerA2AppPlugin(ctx, opts?)` | Register every tool + the skills bundle + an `agent-app` passthrough command into a `HarnessContext`. |
| `runA2App(cliBin, argv)` | Run the CLI and return `{ code, ok, stdout, stderr, json }`. **Never uses a shell** — field values reach the CLI as literal argv, so injection is impossible. Point `cliBin` at a `…/cli.js` entry to run it via Node. |
| `showAgentApp(ctx, app)` | Register an embedded display for a launched app. |

## Verified

The engine drives the real CLIs end-to-end: `agent_app_build` (`agent-app scaffold`) scaffolds an app and `agent_app_validate` (`agent-app validate`) runs the gate (both exit 0). Every other tool uses the same `runA2App` path.

The five harness plugins in [`../`](../) each bind this engine to a real harness API.
