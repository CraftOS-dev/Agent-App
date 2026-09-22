# PocketBase-React Agent App

## Plan
PocketBase backend + a React (Vite) frontend, with the
A2App adapter as in-process PocketBase JS hooks (`pb/pb_hooks/_a2app*.js`).
PocketBase serves records natively; the adapter adds identity + describe and a
guard that validates the raw body before PocketBase coerces it. The View lives
in `ui/` and is compiled into `pb/pb_public/` by the pipeline build. Evolve the
app by editing collections (migrations) and `ui/src/` — never the hook files
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
- The design system lives in `ui/public/tokens.css` (kit sheet: foundation →
 semantic bridge); components consume ONLY semantic tokens. Shared pieces
 (Icon, `useToast`, `useConfirm` — never `window.confirm`) live in `ui/src/`;
 compose them, never re-implement per screen.
- The View is served BUILT: `npm --prefix ui run build` → `pb/pb_public/`.
 Editing `ui/src/` changes nothing a browser sees until the next build.

## Checklist
Build and evolve tasks live in `reference/tasks.md` - one home. This section
points there.
