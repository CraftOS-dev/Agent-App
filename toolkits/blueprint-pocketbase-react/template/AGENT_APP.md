# PocketBase-React Agent App

## Plan
PocketBase backend + a React frontend, with the
A2App adapter as in-process PocketBase JS hooks (`pb/pb_hooks/_a2app*.js`).
PocketBase serves records natively; the adapter adds identity + describe and a
guard that validates the raw body before PocketBase coerces it. Evolve the app by
editing collections (migrations) and the React UI — never the hook files
(system-owned, hash-locked).

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. PocketBase collections
cannot carry a module of their own, so `manifest.json` maps them: each
`modules[].entities` lists the collections in that module.
- **planning** — tasks and the work in front of you.

## Entities
Define collections in PocketBase (via migrations or the admin UI). `describe`
derives entities from the live collection schema, so it cannot drift. A starter
`tasks` collection is expected (title, status, due, created).

## Operations
- **archive-done** — archive every completed task. `destructive`.

## Conventions
- The adapter is the only agent surface; the guard validates the raw body
 (`onRecordCreateRequest`/`onRecordUpdateRequest`), before coercion.
- Day-key text fields named like dates (≤12 chars) are advertised with
 `format: YYYY-MM-DD`.
- Migrations are additive; never drop a collection that holds data.

## Checklist
- [x] A2App hooks adapter (identity, describe, guard)
- [x] rules parity self-test in the gate
- [ ] tasks collection + React UI
- [ ] archive-done operation
