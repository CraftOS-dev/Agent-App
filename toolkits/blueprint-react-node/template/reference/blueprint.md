# Blueprint reference — react-node

Node's built-in `http` server + a JSON-file store + a dependency-free SPA View,
with the A2App adapter mounted as embedded `@a2app/adapter-core` middleware.

Where the `creator`/`modify` skill says "per your stack", the answer is here. If
this file and the source disagree, the source wins.

## Read this first

The scaffold gives you a complete, runnable starter app — the A2App adapter, a
working data model, and a full View — which you edit into your own:

- **entities** — the data model in `a2app.schema.mjs` (see **Schema** below);
- **custom operations** — declared in `schema.operations` + `operations.json` and
  implemented in `schema.operationRunners` (see **Operations**);
- **the View** — the SPA in `public/`, built on the shipped widget kit and design
  tokens (see **The View**).

The starter models a to-do list; replace it with your own entities, operations,
and screens.

## File map — who owns what

Every file that ships on a fresh scaffold, in the order you meet them:

| Path | Owner | What it is |
|---|---|---|
| `a2app.schema.mjs` | **YOURS** | the data model + operations: exports `schema = { entities, operations, operationRunners }`, each entity carrying `module`/`summary`/`fields`/`seed`. Edit this to evolve the app; `describe`/`schemaVersion` derive from it. |
| `operations.json` | **YOURS** | the operation declarations `describe` and approval read (name, module, typed params, entity, appliesWhen, flags). Byte-mirror of `schema.operations`. |
| `public/index.html` | **YOURS** | the View shell + first-paint skeleton; links `tokens.css`/`ui.css`, loads `app.js`. Keep the `/_a2app/update.js` script tag. |
| `public/app.js` | **YOURS** | the View logic: fetch wrapper, load/render, add/advance/delete actions, filters, the `a2app:datachange` listener, boot. |
| `public/ui.js` | **YOURS** | the widget kit — `el` · `icon` · `toast` · `confirmDialog` · `fmtDay` · `isPastDay`. One impl each; compose, never re-implement. |
| `public/ui.css` | **YOURS** | component styles (buttons, cards, list rows, dialog, toasts). Consumes Tier-2 tokens only. |
| `public/tokens.css` | **YOURS** | design tokens: Tier-1 primitives → Tier-2 semantic, light + dark, WCAG AA. Re-point values; keep the NAMES stable. |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | ignores `data/`, credentials, and framework state. Extend for your own artifacts. |
| `package.json` | build | dependencies + build script (`type: module`, Node ≥ 20). Referenced by the pipeline. |
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]`, `authMode`, `pipeline` (install/build/start/health). Change modules via the CLI, never by hand-editing a locked field. |
| `server.mjs` | SYSTEM (hash-locked) | the Node `http` server + `@a2app/adapter-core` middleware: serves the records API, identity, describe, and `/_a2app/update.js`. Never edit. |
| `a2app-update.js` | SYSTEM (hash-locked) | the update watcher served at `/_a2app/update.js` — detects code vs. data staleness in an open tab. Never edit. |
| `scripts/dev-prepare.mjs` | lifecycle | run by `agent-app dev`: builds a fresh, seeded store in an isolated dir. Leave it alone. |
| `scripts/promote-apply.mjs` | lifecycle | run by `agent-app promote`: applies to live after a mandatory backup. Leave it alone. |
| `data/` | runtime | the live JSON store (git-ignored, created on first boot). Never edit by hand; never commit. |

SYSTEM files are hashed in `.a2app/system-hashes.json`; the gate fails the build
if one changes. Need a variant of a kit widget? Wrap it in `public/`, never edit
the locked original.

## Mental model

- The **adapter is the only agent surface.** A human uses the View; an agent
  operates the same records through A2App. Both converge on the JSON store.
- **`a2app.schema.mjs` is the single source of truth for the model.** You never
  hand-write `describe` — the adapter derives it (and `schemaVersion`) from your
  schema. Change the schema, and every A2App screen updates.
- **The store is schema-derived and additive.** There are no migration files on
  this stack. Add a field to the schema and it is simply available; existing rows
  keep their stored values. This is the opposite of the pocketbase stack — do not
  go looking for a `migrations/` directory.

## Schema — entities & fields

Edit `a2app.schema.mjs`. It exports one object:

```js
export const schema = {
  entities: {
    <entity>: {
      module: "<module-from-manifest>",   // REQUIRED — every entity names its module
      summary: "one line shown beside it on the module screen",
      fields: [
        { name: "title", type: "string", required: true, max: 200 },
        { name: "status", type: "enum", values: ["todo", "doing", "done"] },
        { name: "due", type: "string", max: 10, dayKey: true },  // "YYYY-MM-DD"
        { name: "created", type: "datetime", readOnly: true },   // server-set
      ],
      seed: [ { id: "…", title: "…", created: "2026-01-01T00:00:00.000Z" } ],
    },
  },
  operations: [ /* see below */ ],
  operationRunners: { /* see below */ },
};
```

**Field types** (the A2App protocol vocabulary): `string` · `number` ·
`boolean` · `datetime` · `enum` (+ `values`) · `ref` (+ `entity`) · `list<enum>`
· `list<ref>` · `json` · `binary`. Field flags: `required`, `readOnly`
(server-managed, agents may not write it), `max`, and `dayKey: true` for a
whole-day text field advertised as `YYYY-MM-DD`.

**Seeding:** `entities.<name>.seed` is applied when the store is built fresh
(first boot, `dev`, and after `promote`). Seeded data survives; test data you add
at runtime does not carry to a fresh DB.

## Operations — anything beyond plain CRUD

Plain create/read/update/delete needs no operation — the records API covers it.
A declared operation is required only for behavior beyond that. Declare it in
**two places that must agree**, then implement it:

1. `schema.operations` (in `a2app.schema.mjs`) — and the identical row in
   `operations.json`.
2. `schema.operationRunners` — the implementation.

```js
operations: [
  { name: "clear-done", description: "Delete every done task.",
    destructive: true, module: "planning", params: {} },
  { name: "complete-task", description: "Mark one task done.",
    module: "planning", entity: "tasks",
    appliesWhen: { field: "status", ne: "done" },
    params: { task: { type: "ref", entity: "tasks", required: true } } },
],
operationRunners: {
  "clear-done": (_args, _ctx, { db, persist }) => { /* mutate db, then */ persist(); return { removed }; },
  "complete-task": (args, _ctx, { db, persist }) => { const t = db.tasks?.[args.task]; /* … */ persist(); return { ok: true }; },
},
```

- **Runner signature:** `(args, ctx, { db, persist }) => jsonableResult`. `db` is
  the live store object (`db.<entity>[id]`); call `persist()` after any mutation
  or the write is lost.
- **`params` is REQUIRED and typed** (same vocabulary as fields); use `{}` for
  none. The record screen renders it as the signature — args described only in
  prose can neither be shown nor checked.
- **`entity`** attaches the op to a record screen; **`appliesWhen`** decides
  availability on a given record and the adapter derives the blocked reason from
  it. Comparisons only — `eq`, `ne`, `in`, `notIn`, `isBlank`, composed with
  `all`/`any`/`not`. Never a natural-language rule.
- **Flags:** `destructive: true` (requires human approval), `readOnly: true`
  (no side effects), `idempotent: true` (safe to repeat).
- The gate step **"operations resolve"** fails the build if any declared
  operation has no runner function.

## The View — `public/`

A dependency-free SPA over the same records API the agent uses. Same-origin
writes are trusted by the adapter, so the browser needs no token.

**Records API** the View calls (PocketBase-compatible REST, served by the adapter):

| Call | Meaning |
|---|---|
| `GET /api/collections/<entity>/records?sort=-created&page=1&perPage=100&filter=status = "todo"` | list; returns `{ items, totalItems }` |
| `POST /api/collections/<entity>/records` (JSON body) | create; returns the stored record |
| `PATCH /api/collections/<entity>/records/<id>` | update |
| `DELETE /api/collections/<entity>/records/<id>` | delete |
| `GET /api/_a2app` | identity (app name, versions) |

Always render back what the server **stored**, not what you sent. Never render an
unbounded collection — page with `perPage`.

**Widget kit — `public/ui.js`** (one implementation each; import, don't rebuild):
`el(tag, attrs, ...children)` · `icon(name, size)` · `toast(kind, message)` ·
`confirmDialog({ title, body, confirmLabel, danger })` (in-app dialog — never
`window.confirm`) · `fmtDay(dayKey)` · `isPastDay(dayKey)`.

**Tokens — `public/tokens.css`:** two tiers, primitives → semantic. Components
consume ONLY the semantic tier (`--bg-surface`, `--text-primary`,
`--accent-solid`, `--danger-solid`, `--focus-ring`, `--sp-*`, `--r-*`, `--fs-*`,
`--dur-*`, …). Theme by re-pointing semantic tokens; keep the names stable. Light
and dark both resolve every token and hold WCAG AA. Never hardcode a value where
a token exists.

**Realtime / staleness — `/_a2app/update.js`** (system-owned, loaded by
`index.html`). It reloads the tab on a CODE change when nothing is unsaved, and
on a DATA change (an agent wrote through A2App) dispatches `a2app:datachange` on
`window` so the View re-reads without discarding a half-typed form. Keep the
script tag and the listener when you rewrite the View. Do not add your own
polling or reload logic.

## External data (third-party APIs)

Call the internet from the **backend only** — never the frontend (CORS breaks,
keys leak). On this stack the backend seam you own is the **operation runner**:
runners execute in-process on the Node server and can `fetch()`. Put third-party
calls (and any secret-bearing request) in a runner, expose the result as records
or an operation return. `server.mjs` is system-owned, so boot-time fetches are
not your seam — model an initial sync as a runner (e.g. a `refresh` operation)
that fills the store when it is empty.

## App→agent triggers

**This blueprint ships no trigger manifest in v0.1.** The creator skill's
"App→agent triggers" section does not apply here — there is no declared-trigger
surface to fire against. Handle app events with plain code. If a feature
genuinely needs the agent to react, say so in `requirements.md` as a known
limitation rather than inventing an unsupported mechanism.

## Build, run, gate

`manifest.json`'s `pipeline` drives everything (`install` → `build` → `start`,
health at `/api/health`… this blueprint serves identity at `/api/_a2app`). Never
start a server by hand.

```bash
agent-app <dir> validate   # framework files → build → schema loads → operations resolve → ownership canon → describe budget
agent-app <dir> dev        # scripts/dev-prepare.mjs: fresh seeded store in an isolated dir; starts NO server
agent-app <dir> serve      # launch as a managed, health-polled background process; prints the URL
agent-app <dir> promote    # scripts/promote-apply.mjs: pre-promote backup, then apply to live
```

Toolkit gate steps (from `a2app.toolkit.json`): **"schema loads (fresh,
additive)"** and **"operations resolve"**. `lifecycle.dataDir` is `data/`.

## Footguns for this stack

- **Two files, one truth.** Every operation lives in BOTH `schema.operations`
  and `operations.json`, byte-agreeing on name/module/params/flags. The gate
  fails a mismatch.
- **`persist()` or it never happened.** A runner that mutates `db` without
  calling `persist()` returns success while storing nothing.
- **No migrations here.** Schema is declarative and additive; do not look for or
  create a `migrations/` directory.
- **Empty-DB first paint.** A fresh app has no records — the View must render its
  loading/empty/error states without erroring. The verifier fails any first-paint
  error.
- **Keep the update-watcher tag.** Rewriting `index.html` without
  `<script type="module" src="/_a2app/update.js">` leaves already-open tabs stale
  forever.
