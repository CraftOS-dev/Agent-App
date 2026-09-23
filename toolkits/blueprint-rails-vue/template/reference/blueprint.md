# Blueprint reference — rails-vue

A Vue 3 (Vite) View + a Rails server + a SQLite store, with a native Ruby
A2App adapter (the served surface and pure rules ported to Ruby in
`lib/a2app_adapter.rb`). Parity with every other stack is proven by the
adapter's selftest and the conformance suite, not by inspection.

Where the `creator`/`modify` skill says "per your stack", the answer is here. If
this file and the source disagree, the source wins.

## Read this first

The scaffold gives you a complete, runnable starter app — the A2App adapter, a
working data model, and a full Vue View — which you edit into your own:

- **entities** — the data model in `lib/a2app_schema.rb` (see **Schema** below);
- **custom operations** — declared in `A2appSchema::OPERATIONS` +
  `operations.json` and implemented in `A2appSchema::OPERATION_RUNNERS`
  (see **Operations**);
- **the View** — the Vue app in `ui/`, built on the shipped shared components
  and design tokens (see **The View**).

The starter models a to-do list; replace it with your own entities, operations,
and screens.

## File map — who owns what

Every file that ships on a fresh scaffold, in the order you meet them:

| Path | Owner | What it is |
|---|---|---|
| `lib/a2app_schema.rb` | **YOURS** | the data model + operations: `ENTITIES`, `OPERATIONS`, `OPERATION_RUNNERS`, `SEED` (string-keyed throughout). Edit this to evolve the app; `describe`/`schemaVersion` derive from it. |
| `operations.json` | **YOURS** | the operation declarations `describe` and approval read (name, module, typed params, entity, appliesWhen, flags). Byte-mirror of `A2appSchema::OPERATIONS`. |
| `ui/index.html` | **YOURS** | the Vite entry: links `tokens.css`/`ui.css`, mounts `#app`, loads `src/main.js`. |
| `ui/src/main.js` | **YOURS** | Vue root: `createApp(App).mount("#app")`; imports `updater.js` to start the update watcher. |
| `ui/src/App.vue` | **YOURS** | the View logic (one SFC, `<script setup>`): state machine (loading/ready/error), add/advance/delete actions, filters, the `a2app:datachange` listener, boot. |
| `ui/src/api.js` | **YOURS** | the one fetch wrapper — 10 s timeout, GET retry-once, readable error messages. |
| `ui/src/components/Icon.vue` · `ui/src/toast.js` + `components/ToastRegion.vue` · `ui/src/confirm.js` + `components/ConfirmDialog.vue` · `ui/src/format.js` | **YOURS** | the shared pieces — icon set, `useToast`, `useConfirm` (in-app dialog, never `window.confirm`), day formatting. One impl each; compose, never re-implement. |
| `ui/src/updater.js` | **YOURS** | the runtime bridge to the system-owned update watcher. Keep it when you rewrite the View. |
| `ui/public/tokens.css` | **YOURS** | design tokens (the kit sheet): foundation `--agent-app-*` + semantic bridge, light + dark + style packs. Re-point values; keep the NAMES stable. |
| `ui/public/ui.css` | **YOURS** | component styles (buttons, cards, list rows, dialog, toasts). Consumes semantic tokens only. |
| `ui/vite.config.js` | **YOURS** | the View build: Vue plugin, `../public` output, dev-server proxy to the running app. |
| `ui/package.json` | build | the View's dependencies (vue, vite, @vitejs/plugin-vue) + scripts (`build`, `dev`). Referenced by the pipeline as `npm --prefix ui …`. |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | ignores `data/`, `public/`, credentials, framework state, Rails runtime dirs. Extend for your own artifacts. |
| `Gemfile` | build | the backend's gems (rails, puma, sqlite3). Add your HTTP client here when you call external APIs. |
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]`, `authMode`, `pipeline` (install/build/start/health). Change modules via the CLI, never by hand-editing a locked field. |
| `config/application.rb` | SYSTEM (hash-locked) | the minimal Rails application: action_controller only (NO ActiveRecord), eager-loaded `lib/`, `public/` file server with no-cache headers, headless secret_key_base. Never edit. |
| `config/routes.rb` | SYSTEM (hash-locked) | the three routes: the discovery document, the update watcher, and the `/api/**` catch-all into the adapter. Never edit. |
| `config/puma.rb` | SYSTEM (hash-locked) | the launch contract: PORT (manifest fallback 8096), loopback bind (`A2APP_HOST` to override), single mode. Never edit. |
| `app/controllers/a2app_controller.rb` | SYSTEM (hash-locked) | the wiring: Rack request → `adapter.dispatch()`, 5 MiB body cap before parsing, identity's `appVersion` fingerprint, the watcher route. Never edit. |
| `lib/a2app_adapter.rb` | SYSTEM (hash-locked) | the adapter — served surface (identity, describe, guarded CRUD, operations, tasks/events) + the pure rules (guard, predicates, fingerprint) + the SQLite store + `--selftest`. Never edit. |
| `a2app-update.js` | SYSTEM (hash-locked) | the update watcher served at `/_a2app/update.js` — detects code vs. data staleness in an open tab. Never edit. |
| `config/boot.rb` · `config/environment.rb` · `config.ru` | build | standard Rails boot chain (bundler setup → application → rackup). Leave them alone. |
| `scripts/check_ops.rb` | gate | the "operations resolve" gate step. Leave it alone. |
| `scripts/promote_check.rb` | lifecycle | run by `agent-app promote` after the mandatory backup: refuses to orphan an entity that still holds data. Leave it alone. |
| `public/` | build output | the compiled View (`npm --prefix ui run build`). Git-ignored; served by Rails. Never edit by hand. |
| `data/` | runtime | the live SQLite database (git-ignored, created on first boot). Never edit by hand; never commit. |

SYSTEM files are hashed in `.a2app/system-hashes.json`; the gate fails the build
if one changes. Need a variant of a shared component? Wrap it in `ui/src/`,
never edit the locked original.

## Mental model

- The **adapter is the only agent surface.** A human uses the View; an agent
  operates the same records through A2App. Both converge on the SQLite store.
- **`lib/a2app_schema.rb` is the single source of truth for the model.** You
  never hand-write `describe` — the adapter derives it (and `schemaVersion`)
  from your schema. Change the schema, and every A2App screen updates.
- **The store is schema-derived and additive.** Records are JSON rows in one
  SQLite table keyed (entity, id); there are no migration files on this stack,
  and no ActiveRecord either — the store belongs to the adapter. Add a field
  to the schema and it is simply available; existing rows keep their stored
  values.
- **The View is served BUILT.** `npm --prefix ui run build` compiles
  `ui/index.html` + `ui/src/` into `public/`; Rails serves `public/` with
  `Cache-Control: no-cache`. A source edit does nothing until the next build.

## Schema — entities & fields

Edit `lib/a2app_schema.rb`. Four module-level constants drive the app — all
string-keyed (records travel as JSON; what the wire carries is what the rules
see):

```ruby
ENTITIES = {
  "<entity>" => {
    "module" => "<module-from-manifest>",   # REQUIRED — every entity names its module
    "summary" => "one line shown beside it on the module screen",
    "fields" => [
      { "name" => "title", "type" => "string", "required" => true, "max" => 200 },
      { "name" => "status", "type" => "enum", "values" => ["todo", "doing", "done"] },
      { "name" => "due", "type" => "string", "max" => 10, "dayKey" => true },  # "YYYY-MM-DD"
      { "name" => "created", "type" => "datetime", "readOnly" => true },        # server-set
    ],
  },
}

SEED = { "<entity>" => [{ "id" => "…", "title" => "…", "created" => "2026-01-01T00:00:00Z" }] }
```

**Field types** (the A2App protocol vocabulary): `string` · `number` ·
`boolean` · `datetime` · `enum` (+ `values`) · `ref` (+ `entity`) · `list<enum>`
· `list<ref>` · `json` · `binary`. Field flags: `required`, `readOnly`
(server-managed, agents may not write it), `max`, and `dayKey => true` for a
whole-day text field advertised as `YYYY-MM-DD`.

**Seeding:** `SEED` is applied only when a boot CREATES the database file
(first live boot; every `dev` boot, since dev runs against a fresh per-boot
data directory). An existing database is never re-seeded — that would
resurrect seed records the user deleted.

## Operations — anything beyond plain CRUD

Plain create/read/update/delete needs no operation — the records API covers it.
A declared operation is required only for behavior beyond that. Declare it in
**two places that must agree**, then implement it:

1. `A2appSchema::OPERATIONS` — and the identical row in `operations.json`.
2. `A2appSchema::OPERATION_RUNNERS` — a `name => lambda` map.

```ruby
OPERATIONS = [
  { "name" => "clear-done", "description" => "Delete every task whose status is done.",
    "destructive" => true, "module" => "planning", "params" => {} },
  { "name" => "complete-task", "description" => "Mark one task done.",
    "module" => "planning", "entity" => "tasks",
    "appliesWhen" => { "field" => "status", "ne" => "done" },
    "params" => { "task" => { "type" => "ref", "entity" => "tasks", "required" => true } } },
]

OPERATION_RUNNERS = {
  "clear-done" => lambda do |_args, _ctx, store|
    removed = 0
    store.list_records("tasks", {})["items"].each do |r|
      removed += 1 if r["status"] == "done" && store.delete_record("tasks", r["id"])
    end
    { "removed" => removed }
  end,
  "complete-task" => lambda do |args, _ctx, store|
    task = store.get_record("tasks", args["task"])
    # … guard, mutate …
    store.put_record("tasks", task)
    { "ok" => true }
  end,
}
```

- **Runner signature:** `(args, ctx, store) -> json-able hash`. `store` is the
  live SQLite-backed store — read with `store.get_record(entity, id)` /
  `store.list_records(entity, query)`, write with `store.put_record(entity,
  record)` / `store.delete_record(entity, id)`. Writes are durable when the
  call returns; there is no separate persist step. A record read from the
  store is a COPY: mutate it, then `put_record` it back, or the change never
  happened.
- **`params` is REQUIRED and typed** (same vocabulary as fields); use `{}` for
  none. The record screen renders it as the signature — args described only in
  prose can neither be shown nor checked.
- **`entity`** attaches the op to a record screen; **`appliesWhen`** decides
  availability on a given record and the adapter derives the blocked reason
  from it. Comparisons only — `eq`, `ne`, `in`, `notIn`, `isBlank`, composed
  with `all`/`any`/`not`. Never a natural-language rule.
- **Flags:** `destructive => true` (requires human approval), `readOnly =>
  true` (no side effects), `idempotent => true` (safe to repeat).
- The gate step **"operations resolve"** (`ruby scripts/check_ops.rb`) fails
  the build if any declared operation has no runner lambda.

## The View — `ui/`

A Vue 3 SPA (SFCs with `<script setup>`) over the same records API the agent
uses. Same-origin writes are trusted by the adapter, so the browser needs no
token.

**Records API** the View calls (PocketBase-compatible REST, served by the adapter):

| Call | Meaning |
|---|---|
| `GET /api/collections/<entity>/records?sort=-created&page=1&perPage=100&filter=status = "todo"` | list; returns `{ items, totalItems }` (single-clause filter: `field = "v"` · `field != "v"` · `field ~ "v"`; anything richer is refused `invalid_filter`, never ignored) |
| `POST /api/collections/<entity>/records` (JSON body) | create; returns the stored record |
| `PATCH /api/collections/<entity>/records/<id>` | update |
| `DELETE /api/collections/<entity>/records/<id>` | delete |
| `GET /api/_a2app` | identity (app name, versions) |

Always render back what the server **stored**, not what you sent. Never render an
unbounded collection — page with `perPage`.

**Shared pieces — `ui/src/`** (one implementation each; import, don't rebuild):
`<Icon :name :size>` · `useToast()` → `toast(kind, message)` ·
`useConfirm()` → `{ request, confirm, done }` (in-app dialog — never
`window.confirm`) · `api(path, init)` · `fmtDay(dayKey)` · `isPastDay(dayKey)`.
Component styles are plain CSS classes in `ui/public/ui.css`.

**Tokens — `ui/public/tokens.css`:** the kit sheet — `--agent-app-*` foundation
→ semantic bridge. Components consume ONLY semantic tokens (`--bg-surface`,
`--text-primary`, `--accent-solid`, `--danger-solid`, `--focus-ring`, `--sp-*`,
`--r-*`, `--fs-*`, `--dur-*`, …). Theme by re-pointing the foundation or picking
a `[data-style]` pack; keep the names stable. Light and dark both resolve every
token and hold WCAG AA. Never hardcode a value where a token exists.

**Realtime / staleness — `ui/src/updater.js`** bridges to the system-owned
watcher (`/_a2app/update.js`, a RUNTIME import the bundler must leave alone).
It reloads the tab on a CODE change when nothing is unsaved, and on a DATA
change (an agent wrote through A2App) dispatches `a2app:datachange` on `window`
so the View re-reads without discarding a half-typed form. Keep the bridge and
the listener when you rewrite the View. Do not add your own polling or reload
logic.

**Building:** `npm --prefix ui run build` (the pipeline build step) compiles
the View into `public/`. For tight iteration `npm --prefix ui run dev` runs
Vite's dev server with `/api` and `/_a2app` proxied to the running app —
start the app first (`agent-app <dir> serve` or `dev`).

## External data (third-party APIs)

Call the internet from the **backend only** — never the frontend (CORS breaks,
keys leak). On this stack the backend seam you own is the **operation runner**:
runners execute in-process on the Rails server and can use `Net::HTTP` (or a
client gem you add to the Gemfile). Put third-party calls (and any
secret-bearing request) in a runner, expose the result as records or an
operation return. The controller and adapter are system-owned, so boot-time
fetches are not your seam — model an initial sync as a runner (e.g. a
`refresh` operation) that fills the store when it is empty.

## App→agent triggers

**This blueprint ships no trigger manifest in v0.1.** The creator skill's
"App→agent triggers" section does not apply here — there is no declared-trigger
surface to fire against. Handle app events with plain code. If a feature
genuinely needs the agent to react, say so in `requirements.md` as a known
limitation rather than inventing an unsupported mechanism.

## Build, run, gate

`manifest.json`'s `pipeline` drives everything (`install` → `build` → `start`,
health at `/api/_a2app`). Never start a server by hand.

```bash
agent-app <dir> dev        # boot the candidate on a hidden port: fresh seeded store, prints the dev URL
agent-app <dir> validate   # framework files → build (vite + ruby -c) → adapter self-test → operations resolve → ownership canon → describe budget (on dev)
agent-app <dir> serve      # launch LIVE as a managed, health-polled background process; prints the URL
agent-app <dir> promote    # requires the gate pass; backup, scripts/promote_check.rb, destroys the dev instance
```

Toolkit gate steps (from `a2app.toolkit.json`): **"ruby syntax + adapter
self-test"** (`ruby -c` on the adapter, the schema and the controller, then
`ruby lib/a2app_adapter.rb --selftest` — the selftest covers the rules parity
AND the SQLite store: durability across a reopen, seed-once, idempotency keys,
the filter grammar) and **"operations resolve"** (`ruby scripts/check_ops.rb`).
`lifecycle.dataDir` is `data/`; `lifecycle.promote` is
`bundle exec ruby scripts/promote_check.rb`.

**Environments (one tree, redirected inputs).** `config/puma.rb` and the
controller read `PORT`, `A2APP_DATA_DIR` and `A2APP_ENV` from the framework.
The dev instance runs against a disposable per-boot SQLite store (a fresh
directory means a fresh file means a fresh seed). One honest simplification on
this stack: the View is served from `public/` AS BUILT — there is no separate
boot-time dist snapshot like react-node's. The pipeline build is what changes
`public/`, and promote is what changes the deployed tree, so a mid-iteration
`npm --prefix ui run build` in the LIVE tree reaches live tabs on their next
reload. Build in the dev tree (`agent-app <dir> dev` runs the build via
`lifecycle.dev`), verify there, then promote.

## Footguns for this stack

- **Two files, one truth.** Every operation lives in BOTH
  `A2appSchema::OPERATIONS` and `operations.json`, byte-agreeing on
  name/module/params/flags. The gate fails a mismatch.
- **The View is served built.** Editing `ui/src/` changes nothing a browser
  sees until `npm --prefix ui run build` runs. If the app looks stale, check
  `public/` before debugging the server.
- **No migrations, and NO ActiveRecord.** Schema is declarative and additive;
  do not look for or create a `migrations/` directory, do not add
  `database.yml`, and never `rails generate` models — the store is the
  adapter's (`SqliteStore` in `lib/a2app_adapter.rb`), not AR's.
- **Empty-DB first paint.** A fresh app has no records — the View must render
  its loading/empty/error states without erroring. The verifier fails any
  first-paint error.
- **Keep the update-watcher bridge.** Rewriting the View without
  `ui/src/updater.js` (the runtime import of `/_a2app/update.js`) leaves
  already-open tabs stale forever.
- **A record read out is a COPY.** A runner that mutates a hash from
  `get_record` without `put_record`-ing it back returns success while storing
  nothing.
