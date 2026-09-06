# Base Agent App

## Plan
A stack-agnostic starting point. This blueprint ships only the framework files —
no runtime code. Choose a stack, wire an A2App adapter (front face identical
everywhere, back face specific to your stack —), replace
the `pipeline` block in `manifest.json` with your real install/build/start
commands, and build the app feature by feature per the creator skill.

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. Declare them in
`manifest.json` BEFORE declaring anything that names one.
- **core** — this app's first area. Rename it as the app takes shape; split a
  module once its screen would exceed the 2,000-character describe budget.

## Entities
None yet. Add each entity to your Model, then expose it through the adapter's
`describe` so an agent sees it (fields mapped to protocol types).

## Operations
None yet. Declare each operation in `operations.json` (`name`, `destructive`, and
optionally `readOnly` / `idempotent`) and implement it behind the adapter.

## Conventions
- The A2App adapter is the ONLY agent surface. Never make the agent drive the UI to
 operate the app.
- Migrations are additive; never drop a collection that holds data.
- Credentials are runtime-only; never commit them.

## Checklist
- [ ] Choose the stack and replace the `pipeline` block
- [ ] Wire the A2App adapter (identity, describe, guard, records, ops)
- [ ] First entity + first operation
- [ ] Gate passes (`agent-app validate`)
- [ ] Walk-verify passes
