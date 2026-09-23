# Rust-React Agent App

## Plan
A to-do app on a Rust (tiny_http) server with a SQLite store and a React
(Vite) View. The A2App adapter is a native Rust port of the served surface and
pure rules, compiled into the same binary (`src/a2app_adapter.rs`). You evolve
the app by editing `src/schema.rs` (the Model + operations) and `view/` +
`index.html` (the View) — never `src/main.rs` or `src/a2app_adapter.rs`
(system-owned, hash-locked).

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. They are declared in
`manifest.json`; each entity names its module in `src/schema.rs`.
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
- **The design system lives in `public/tokens.css`** (foundation → semantic
  bridge). Components consume ONLY semantic tokens; theming re-points the
  foundation and never edits a component. Never hardcode a colour, size, or
  duration where a token exists.
- **Shared pieces live in `view/`** — `Icon.jsx` (the icon set), `toast.jsx`
  (`useToast`), `ConfirmDialog.jsx` (`useConfirm` — never `window.confirm`),
  `format.js`, `api.js` (the one fetch wrapper). Screens compose them — one
  implementation per widget, no per-screen copies, no native browser dialogs.
  Component styles live in `public/ui.css`. The React sources live in `view/`
  because `src/` belongs to cargo.
- **Every screen renders all of its states**: loading skeletons (sized so
  arriving content does not shift the layout), a designed empty state with the
  action that fills it, an error state with a retry path, disabled/pending
  controls while a write is in flight, and success read back from what the
  server stored.
- KEEP the update watcher when you rewrite the View. `view/updater.js` imports
  `/_a2app/update.js` at runtime (served by the Rust server from a system-owned
  file; it cannot be bundled). Without it, a tab someone left open goes on
  running the JavaScript it already downloaded after you promote a change, and
  nothing tells them. It reloads only when the page holds nothing unsaved —
  reloading a page with half-typed input destroys work, which is worse than the
  stale tab.
- `schemaVersion` is NOT a signal that the UI changed. It fingerprints entities
  and operations only, so a new component, a CSS change, or reworded copy leaves
  it identical. Identity's `appVersion` is the marker that moves for those.
- To add an entity: add it to `entities()` in `src/schema.rs`; describe and
  `schemaVersion` update automatically. Keep `operations.json` in sync with the
  schema's `operations()`.
- A record fetched from the store is a COPY: mutate it, then `put_record` it
  back, or the change never happened. Writes are durable when the call returns.
- Migrations are additive; the SQLite store keeps existing records across schema
  additions. Never remove a field that holds data without a migration plan.
- The View is served BUILT (`npm run build` → `dist/`). A View edit is invisible
  until the next build; `npm run dev:ui` runs Vite's dev server (with `/api`
  proxied to the running app) for tight iteration. Server or schema edits need
  `cargo build` (the pipeline build runs both).
- The server logs one JSON line per event (`evt: boot | http | crash`) to the
  log `agent-app serve` captures; keep record contents and secrets out of it.

## Checklist
Build and evolve tasks live in `reference/tasks.md` — one home. This section
points there.
