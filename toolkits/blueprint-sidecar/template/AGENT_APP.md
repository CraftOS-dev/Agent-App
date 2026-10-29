# Adopted App

## Plan
A foreign app, adopted as-is. Its source lives in `upstream/` and runs
unchanged; the sidecar A2App adapter (`@a2app/reverse-proxy`) starts it from
`sidecar.json`, waits until it answers, and serves the A2App surface on this
app's port, forwarding each declared operation to one of the app's own routes.
Replace this paragraph with what the adopted app is, what it is for, and who
uses it. Follow `reference/blueprint.md` to adopt it.

## Modules
Modules are the organizing unit: every operation belongs to exactly one, and
describe's root screen lists them. Take them from the app's own grouping — its
OpenAPI tags, its route prefixes, its controllers — and declare them in
`manifest.json`, then reseal it with `agent-app <dir> toolkit-sync`.
- **core** — rename it after the app's first area; add one module per area.

## Entities
None, by design. An adopted app is operate-only: its data model is the app's
own and is not mapped, so describe reports no entities and the `data` verbs do
not apply.

## Operations
None yet. Each operation is declared in `operations.json` (name, module, typed
params, `destructive`) and mapped onto one of the app's routes in
`sidecar.json` (method, path, query or body). List each one here: its module,
the route it reaches, and what it does.

## Conventions
- The adapter is the only agent surface: agents run the declared operations
  over A2App and never drive the app's own UI to operate it.
- `upstream/` is the adopted app, kept read-only. Never edit its code; what it
  needs to run here is declared in `sidecar.json` (argv, port, environment).
- Anything that deletes or overwrites is `"destructive": true`, so a person
  approves each call.
- Credentials are runtime-only; never commit them.

## Checklist
Build and evolve tasks live in `reference/tasks.md` — one home. This section
points there.
