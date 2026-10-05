# PocketBase-React Agent App

## Plan
PocketBase backend + a React (Vite) frontend, with the
A2App adapter as in-process PocketBase JS hooks (`pb/pb_hooks/_a2app*.js`).
PocketBase serves records natively; the adapter adds identity + describe, a
guard that validates the raw body before PocketBase coerces it, declared
operations, and the app→agent task queue. The View lives in `ui/` and is
compiled into `pb/pb_public/` by the pipeline build. Evolve the app by editing
collections (migrations), `operations.json` + `pb/pb_hooks/operations.js`, and
`ui/src/` — never the `_a2app*` hook files (system-owned, hash-locked).

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. PocketBase collections
cannot carry a module of their own, so `manifest.json` maps them: each
`modules[].entities` lists the collections in that module.
- **planning** — tasks and the work in front of you.

## Entities
Define collections in PocketBase migrations (`pb/pb_migrations/`). `describe`
derives entities from the live collection schema, so it cannot drift.
- **tasks** — a to-do item, created by the starter migration. Fields: `title`
  (string, required), `status` (enum: todo/doing/done), `due` (day key
  YYYY-MM-DD), `notes` (string), `agentTask` (the queue task an agent is, or
  was last, working on; set by `request-triage`, declared read-only in
  `pb/pb_hooks/operations.js`).

## Operations
Declared in `operations.json`, run by the same-named runner in
`pb/pb_hooks/operations.js`.
- **clear-done** — deletes every task whose status is done. `destructive`.
- **count-tasks** — counts the tasks. `readOnly`, `idempotent`.
- **complete-task** — marks one task done. Acts on `tasks`; available while the
  task is not already done.
- **request-triage** — asks an agent to work out what one task needs. Queues a
  `triage` task (event `task.needs_triage`) and records its id in `agentTask`;
  the View shows the work until it is done.

## Conventions
- The adapter is the only agent surface; the guard validates the raw body
 (`onRecordCreateRequest`/`onRecordUpdateRequest`), before coercion.
- An operation runner is a transaction: write through `a2app.app`, queue agent
 work with `a2app.trigger`, and keep slow outbound calls out of it.
- Day-key text fields named like dates (≤12 chars) are advertised with
 `format: YYYY-MM-DD`.
- Migrations are additive; never edit an applied one, never drop a collection
 that holds data.
- The design system lives in `ui/public/tokens.css` (kit sheet: foundation →
 semantic bridge); components consume ONLY semantic tokens. Shared pieces
 (Icon, `useToast`, `useConfirm` — never `window.confirm`, `AgentTask.jsx` for
 work queued for an agent) live in `ui/src/`; compose them, never re-implement
 per screen.
- The View is served BUILT: `npm --prefix ui run build` → `pb/pb_public/`.
 Editing `ui/src/` changes nothing a browser sees until the next build.

## Checklist
Build and evolve tasks live in `reference/tasks.md` - one home. This section
points there.
