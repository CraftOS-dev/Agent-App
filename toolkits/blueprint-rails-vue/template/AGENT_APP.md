# Rails-Vue Agent App

## Plan
A to-do app on a Rails server with a SQLite store and a Vue 3 (Vite) View. The
A2App adapter is a native Ruby port (`lib/a2app_adapter.rb`), dispatched by one
system-owned controller. You evolve the app by editing `lib/a2app_schema.rb`
(the Model + operations) and `ui/` (the View, built into `public/`) — never the
adapter, the controller, or the config files (system-owned, hash-locked).

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. They are declared in
`manifest.json`; each entity names its module in `lib/a2app_schema.rb`.
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
- **The design system lives in `ui/public/tokens.css`** (foundation → semantic
  bridge). Components consume ONLY semantic tokens; theming re-points the
  foundation and never edits a component. Never hardcode a colour, size, or
  duration where a token exists.
- **Shared pieces live in `ui/src/`** — `components/Icon.vue` (the icon set),
  `toast.js` + `components/ToastRegion.vue` (`useToast`), `confirm.js` +
  `components/ConfirmDialog.vue` (`useConfirm` — never `window.confirm`),
  `format.js`, `api.js` (the one fetch wrapper). Screens compose them — one
  implementation per widget, no per-screen copies, no native browser dialogs.
  Component styles live in `ui/public/ui.css`.
- **Every screen renders all of its states**: loading skeletons (sized so
  arriving content does not shift the layout), a designed empty state with the
  action that fills it, an error state with a retry path, disabled/pending
  controls while a write is in flight, and success read back from what the
  server stored.
- KEEP the update watcher when you rewrite the View. `ui/src/updater.js`
  imports `/_a2app/update.js` at runtime (served by the system-owned
  controller from `a2app-update.js`; it cannot be bundled). Without it, a tab
  someone left open goes on running the JavaScript it already downloaded after
  you promote a change, and nothing tells them. It reloads only when the page
  holds nothing unsaved — reloading a page with half-typed input destroys
  work, which is worse than the stale tab.
- `schemaVersion` is NOT a signal that the UI changed. It fingerprints entities
  and operations only, so a new component, a CSS change, or reworded copy leaves
  it identical. Identity's `appVersion` is the marker that moves for those.
- To add an entity: add it to `ENTITIES` in `lib/a2app_schema.rb`; describe and
  `schemaVersion` update automatically. Keep `operations.json` in sync with the
  schema's `OPERATIONS`.
- Two files, one truth: every operation lives in BOTH `A2appSchema::OPERATIONS`
  and `operations.json`, byte-agreeing on name/module/params/flags.
- Operation runners read/write through the store API (`get_record` /
  `list_records` / `put_record` / `delete_record`); writes are durable when
  the call returns, and a record read out is a COPY — `put_record` it back
  after mutating, or the change never happened.
- Migrations are additive; the SQLite store keeps existing records across
  schema additions. There is NO ActiveRecord on this stack — never
  `rails generate` a model; the store is the adapter's. Never remove a field
  that holds data without a migration plan.
- The View is served BUILT (`npm --prefix ui run build` → `public/`). A View
  edit is invisible until the next build; `npm --prefix ui run dev` runs
  Vite's dev server (with `/api` and `/_a2app` proxied to the running app)
  for tight iteration.

## Checklist
Build and evolve tasks live in `reference/tasks.md` — one home. This section
points there.
