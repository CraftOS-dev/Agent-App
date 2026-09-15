# Blueprint reference — pocketbase-react

A PocketBase backend + a React frontend, with the A2App adapter running as
in-process PocketBase JS hooks (`pb/pb_hooks/_a2app*.js`). PocketBase serves
records natively; the adapter adds identity + describe and a guard that validates
the raw request body before PocketBase coerces it.

Where the `creator`/`modify` skill says "per your stack", the answer is here. If
this file and the source disagree, the source wins.

## Read this first

The scaffold gives you the A2App adapter and the framework files. You build what
the app actually does:

- **entities** — PocketBase collections, defined by JavaScript migration files you
  add under `pb/pb_migrations/` (a migration is a `.js` file PocketBase runs at
  boot to create or alter collections — see **Schema** below);
- **custom operations** — new hook files under `pb/pb_hooks/` (see **Operations**);
- **the View** — a React app in `pb/pb_public/`, with components and design tokens
  you supply.

A freshly scaffolded app has its modules declared but no collections, so it stores
nothing until you add your first migration file under `pb/pb_migrations/`.

## File map — who owns what

**Ships on a fresh scaffold:**

| Path | Owner | What it is |
|---|---|---|
| `operations.json` | **YOURS** | the operation declarations `describe` and approval read (name, module, typed params, entity, appliesWhen, flags). |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | ignores `pb/pb_data`, credentials, the binary. Extend as needed. |
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]` **and their `entities[]`** (the collection→module map you maintain), `authMode`, `pipeline`. |
| `pb-serve.mjs` | SYSTEM (hash-locked) | the cross-platform launcher `pipeline.start` runs. Resolves the binary + data dirs and reads the port from the environment. Never edit. |
| `pb/pb_hooks/_a2app.pb.js` | SYSTEM (hash-locked) | the adapter: identity, describe, and the create/update guard. Never edit. |
| `pb/pb_hooks/_a2app_rules.js` | SYSTEM (hash-locked) | the pure rules (guard, predicates, fingerprint) + `--selftest`. Never edit. |

**You create or obtain (nothing ships for these):**

| Path | Owner | What it is |
|---|---|---|
| `pb/pocketbase` (`pb/pocketbase.exe` on Windows) | runtime | the PocketBase binary. You download it (see pipeline `install`); nothing runs without it. `pb-serve.mjs` picks the right name per platform. Git-ignored. |
| `pb/pb_migrations/*.js` | **YOURS** | collection (entity) definitions as PocketBase JS migrations. You write these — none ship, so a fresh app has zero collections. |
| `pb/pb_hooks/<your-op>.pb.js` | **YOURS** | custom operation implementations — a new hook file per op with a `routerAdd(...)` route. Never touch `_a2app*`. |
| `pb/pb_public/**` | **YOURS** | the React View; PocketBase serves it statically. You build it and bring your own component set and design tokens. |
| `pb/pb_data/` | runtime | the live database (git-ignored, created on first boot). Never edit by hand; never commit. |

SYSTEM files are hashed in `.a2app/system-hashes.json`; the gate fails the build
if one changes. Need a variant of adapter behavior? You cannot edit the hooks —
model it as your own collection field, migration, or operation hook instead.

## Mental model

- The **adapter is the only agent surface.** PocketBase serves records; the hooks
  add the protocol surface and validate raw writes via
  `onRecordCreateRequest`/`onRecordUpdateRequest`.
- **`describe`/`schemaVersion` are derived from the LIVE collection schema** — so
  they can never drift from what the database actually holds. You never
  hand-write describe.
- **Entities are PocketBase collections, and the module mapping lives in the
  manifest.** A PocketBase collection cannot carry a module of its own, so
  `manifest.json`'s `modules[].entities` names which collections belong to each
  module. Create a collection without listing it there and it has no screen and
  cannot be walked.

## Schema — collections via migrations

Entities are PocketBase **collections**. Create and evolve them with PocketBase
JS migrations under `pb/pb_migrations/` (or the admin UI, which writes a migration
for you). The exact migration API is PocketBase's own and moves between PocketBase
versions — follow the PocketBase JS-migrations documentation for the binary you
downloaded rather than guessing. The framework rules on top of it:

- **Additive only. A migration filename is its identity in the live database.**
  Never edit, rename, or delete a migration that has already been applied (after
  any successful launch) — on the next boot PocketBase would try to re-run the
  "new" file into the existing schema and the app cannot start. Fix a past
  migration's mistake by writing a **new** migration that alters the collection.
- **Never drop a collection that holds data.**
- **After creating a collection, add it to `manifest.json`** under the right
  module's `entities[]` (this is a system-owned file — change modules/entities via
  the CLI where possible; the mapping is what gives the entity a screen).
- **Field → protocol type mapping** the adapter publishes: PocketBase `text` →
  `string`, `number` → `number`, `bool` → `boolean`, `date` → `datetime`,
  `json` → `json`, `file` → `binary`, `select` (single) → `enum` / (multi) →
  `list<enum>`, `relation` (single) → `ref` / (multi) → `list<ref>`. A short
  `text` field (max ≤ 12) named like `due`/`day`/`date`/`*_date`/`*_day` is
  advertised as a `YYYY-MM-DD` day key automatically.
- **Seeding:** seed starter rows in a migration so they survive a fresh build.

## Operations — anything beyond plain CRUD

Plain create/read/update/delete is served natively by PocketBase — no operation
needed. A declared operation is for behavior beyond CRUD:

1. Declare it in `operations.json` with `module`, typed `params` (`{}` if none),
   optional `entity` + `appliesWhen`, and flags.
2. Implement it as a **new hook file**, e.g. `pb/pb_hooks/<name>.pb.js`, adding a
   route with `routerAdd(...)` that does the work. (Never edit `_a2app.pb.js`.)

Declaration fields (same contract as every stack):

- **`params`** — REQUIRED and typed (`string`/`number`/`ref`/…); the record
  screen renders it as the operation's signature. Args in prose don't count.
- **`entity`** attaches the op to a record screen; **`appliesWhen`** decides
  availability and the adapter derives the blocked reason from it. Comparisons
  only — `eq`, `ne`, `in`, `notIn`, `isBlank`, composed with `all`/`any`/`not`.
- **Flags:** `destructive: true` (requires human approval), `readOnly: true`,
  `idempotent: true`.

> **This stack does NOT gate operation resolution.** Unlike react-node and
> python-fastapi, this blueprint's gate has no "operations resolve" step — a
> declared operation with no working route will pass `validate` silently. You
> MUST verify each operation for real in the REALITY CHECK: run
> `a2app <dir> <module> <entity> <id>` on a live record and confirm the operation
> is available when it should be and blocked (with a sensible reason) when it
> should not.

## The View — `pb/pb_public/`

PocketBase serves static files from `pb/pb_public/` — that is where your React
View goes; no system-owned file is involved and no build seam needs wiring. **No
component kit or design tokens ship with this blueprint** — bring your own React
setup and adopt a single design system (tokens for colour/spacing/type, light +
dark, WCAG AA) to meet the Quality Standard (`../QUALITY.md`). Build the View
against PocketBase's records API / JS SDK:

- `GET/POST/PATCH/DELETE /api/collections/<entity>/records` — the same records
  the agent operates. Same-origin browser writes are fine; the guard validates
  every create/update.
- `GET /api/_a2app` — identity (app name, versions).

Render back what the server **stored**, never what you sent; page large lists;
design the loading/empty/error states, not just the happy path.

## External data (third-party APIs)

Call the internet from the **backend only** (never the frontend). Your backend
seam is a **hook** — a `pb/pb_hooks/*.pb.js` route or a PocketBase event hook can
make outbound HTTP (`$http.send(...)`). Put third-party calls and secrets there;
model an initial sync as a hook that populates a collection when it is empty.
Note PocketBase hooks run in the Goja JS runtime, not Node — a handler cannot
close over file-scope variables; `require()` inside each handler.

## App→agent triggers

**This blueprint ships no trigger manifest in v0.1.** The creator skill's
"App→agent triggers" section does not apply — handle app events with plain hook
code. Do not invent an unsupported mechanism.

## Build, run, gate

`manifest.json`'s `pipeline`:

- `install` prints a reminder to **download the PocketBase binary into `./pb`** —
  do this before serving, or `start` has nothing to run.
- `build` = `node --check pb/pb_hooks/_a2app.pb.js` (syntax only).
- `start` = `node pb-serve.mjs` — the launcher runs `pocketbase serve` bound to the
  environment's `PORT`. It is cross-platform on purpose: the raw `pb/pocketbase
  serve --http 127.0.0.1:${PORT} ...` form is not, because cmd.exe neither expands
  `${PORT}` nor runs an executable path written with `/`.
- `health` = `/api/_a2app`.

```bash
agent-app <dir> validate   # framework files → build → hooks syntax + rules self-test → ownership canon → describe budget
agent-app <dir> serve      # launch as a managed, health-polled background process; prints the URL
```

Toolkit gate step (from `a2app.toolkit.json`): **"hooks syntax + rules
self-test"** (`node --check` both hook files, then
`node pb/pb_hooks/_a2app_rules.js --selftest`). `lifecycle.dataDir` is
`pb/pb_data`.

## Footguns for this stack

- **Get the binary first.** Nothing runs until `pb/pocketbase` exists.
- **Zero collections on scaffold.** Write migrations to create your entities;
  until you do, `a2app <dir>` shows modules with `0 entities`.
- **Register every new collection in `manifest.json`'s module `entities[]`** or it
  has no screen and cannot be walked.
- **Migrations are identity-locked and additive.** Never edit/rename/delete an
  applied migration; fix mistakes with a new one; never drop a collection with
  data.
- **Operation resolution is UNCHECKED here** — verify every declared operation
  for real (see Operations above).
- **Empty-DB first paint.** The View must render loading/empty/error states
  against a database with no records; the verifier fails any first-paint error.
- **Goja, not Node.** Hook handlers `require()` their modules locally and cannot
  close over file-scope state.
