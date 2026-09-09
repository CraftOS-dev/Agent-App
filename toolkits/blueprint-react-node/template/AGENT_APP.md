# React-Node Agent App

## Plan
A to-do app on a Node (built-in `http`) backend with a JSON-file store and a
vanilla SPA View. The A2App adapter (`@a2app/adapter-core`) is mounted as embedded
middleware in `server.mjs`. You evolve the app by editing `a2app.schema.mjs` (the
Model + operations) and `public/` (the View) — never `server.mjs` (system-owned,
hash-locked).

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. They are declared in
`manifest.json`; each entity names its module in `a2app.schema.mjs`.
- **planning** — tasks and the work in front of you.

## Entities
- **tasks** — a to-do item. Fields: `title` (string, required), `status`
  (enum: todo/doing/done), `due` (day key YYYY-MM-DD), `notes` (string),
  `created` (datetime, read-only).

## Operations
- **clear-done** — deletes every task whose status is done. `destructive`.
- **count-tasks** — counts the tasks. `readOnly`, `idempotent`.

## Conventions
- The adapter is the only agent surface; the View writes same-origin through the
  records API (trusted by the origin rule), the agent writes through A2App.
- KEEP the update watcher when you rewrite the View. `index.html` loads
  `<script type="module" src="/_a2app/update.js"></script>`; it is served by
  `server.mjs` from a system-owned file. Without it, a tab someone left open goes
  on running the JavaScript it already downloaded after you promote a change, and
  nothing tells them. It offers a reload and never takes one — reloading a page
  with half-typed input in it destroys work, which is worse than the stale tab.
- `schemaVersion` is NOT a signal that the UI changed. It fingerprints entities
  and operations only, so a new control, a CSS change, or reworded copy leaves it
  identical. Identity's `appVersion` is the marker that moves for those.
- To add an entity: add it to `schema.entities` in `a2app.schema.mjs`; describe and
  `schemaVersion` update automatically. Keep `operations.json` in sync with the
  schema's `operations`.
- Migrations are additive; the JSON store keeps existing records across schema
  additions. Never remove a field that holds data without a migration plan.

## Checklist
- [x] tasks entity + create/update/delete
- [x] clear-done / count-tasks operations
- [ ] your next feature
