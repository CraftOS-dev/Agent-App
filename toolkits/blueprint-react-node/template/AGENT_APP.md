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
- **complete-task** — marks one task done. Acts on `tasks`; available while the
  task is not already done.

## Conventions
- The adapter is the only agent surface; the View writes same-origin through the
  records API (trusted by the origin rule), the agent writes through A2App.
- **The design system lives in `public/tokens.css`** (two tiers: primitives →
  semantic). Components consume ONLY semantic tokens; theming re-points the
  semantic tier and never edits a component. Never hardcode a colour, size, or
  duration where a token exists.
- **Widgets live in `public/ui.css` + `public/ui.js`** (buttons, fields, status
  pills, toasts, the confirm dialog, the icon set, formatting helpers). Screens
  compose them — one implementation per widget, no per-screen copies, no native
  browser dialogs. New icons join the set in `ui.js`.
- **Every screen renders all of its states**: loading skeletons (sized so
  arriving content does not shift the layout), a designed empty state with the
  action that fills it, an error state with a retry path, disabled/pending
  controls while a write is in flight, and success read back from what the
  server stored.
- To add an entity: add it to `schema.entities` in `a2app.schema.mjs`; describe and
  `schemaVersion` update automatically. Keep `operations.json` in sync with the
  schema's `operations`.
- Migrations are additive; the JSON store keeps existing records across schema
  additions. Never remove a field that holds data without a migration plan.
- The server logs one JSON line per event (`evt: boot | http | crash`) to the
  log `agent-app serve` captures; keep record contents and secrets out of it.

## Checklist
Build and evolve tasks live in `reference/tasks.md` — one home. This section
points there.
