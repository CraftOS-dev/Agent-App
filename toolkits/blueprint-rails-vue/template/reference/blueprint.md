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
| `lib/a2app_schema.rb` | **YOURS** | the data model + operations: `ENTITIES`, `OPERATIONS`, `OPERATION_RUNNERS`, `EVENTS`, `CAPABILITIES`, `SEED` (string-keyed throughout), and optionally `PERMISSIONS_OF`. Edit this to evolve the app; `describe`/`schemaVersion` derive from it. |
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
| `config/application.rb` | SYSTEM (hash-locked) | the minimal Rails application: action_controller only (NO ActiveRecord), eager-loaded `lib/`, the adapter's Host check in front of every path, request bodies never parsed or logged by Rails, errors in the protocol's envelope, headless secret_key_base. Never edit. |
| `config/routes.rb` | SYSTEM (hash-locked) | one catch-all route: every path and verb goes to the controller. Never edit. |
| `config/puma.rb` | SYSTEM (hash-locked) | the launch contract: PORT (manifest fallback 8096), loopback bind (`A2APP_HOST` to override), single mode. Never edit. |
| `app/controllers/a2app_controller.rb` | SYSTEM (hash-locked) | the wiring: Rack request → `adapter.dispatch()`, 5 MiB body cap before parsing, any error answered `adapter_error`; every other path is the View — `public/`, the watcher and the account page — served with ETag validators; identity's `appVersion` fingerprint. Never edit. |
| `lib/a2app_adapter.rb` | SYSTEM (hash-locked) | the adapter — served surface (identity, describe, guarded CRUD, operations, tasks/events, accounts, credentials, device sign-in) + the pure rules (guard, predicates, fingerprint) + the SQLite store (records, and every table of adapter state) + the View's static server + `--selftest`. Never edit. |
| `a2app-update.js` | SYSTEM (hash-locked) | the update watcher served at `/_a2app/update.js` — detects code vs. data staleness in an open tab. Never edit. |
| `a2app-account.html` | SYSTEM (hash-locked) | the framework's account page at `/_a2app/account`: sign in, accept an invite, people (owner), the agents acting for you. The same file in every blueprint. Never edit. |
| `config/boot.rb` · `config/environment.rb` · `config.ru` | build | standard Rails boot chain (bundler setup → application → rackup). Leave them alone. |
| `scripts/check_ops.rb` | gate | the "operations resolve" gate step. Leave it alone. |
| `scripts/promote_check.rb` | lifecycle | run by `agent-app promote` after the mandatory backup: refuses to orphan an entity that still holds data. Leave it alone. |
| `public/` | build output | the compiled View (`npm --prefix ui run build`). Git-ignored; served by the app. Never edit by hand. |
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
  `ui/index.html` + `ui/src/` into `public/`; the app serves `public/` with
  `Cache-Control: no-cache` and an ETag. A source edit does nothing until the
  next build.
- **The adapter's state is durable too.** Tasks, events, approval and
  idempotency keys, credentials, accounts and the audit log live in the same
  SQLite file, in tables of their own: a restart loses no queued work, no
  event cursor and no pending approval.

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

- **Runner signature:** `(args, ctx, store) -> json-able hash`. `ctx` is who
  is calling (`{"credentialId", "agentName", "principal", "role"}`). `store` is the
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
- **Arguments are guarded like a record write:** a missing required
  parameter, an undeclared one or an ill-typed value is refused `400` before
  the runner runs (and before a person is asked to approve anything).
- **Refusing:** a runner that cannot do what was asked raises
  `A2appAdapter::OperationError.new(code, message, status = 400, extra = nil)`
  — the caller gets that status and code, with `extra`'s fields beside them.
  Anything else a runner raises is a `500 operation_failed`.
- The gate step **"operations resolve"** (`ruby scripts/check_ops.rb`) fails
  the build if any declared operation has no runner lambda.

## The View — `ui/`

A Vue 3 SPA (SFCs with `<script setup>`) over the same records API the agent
uses. The browser never needs a token: on a single-user app same-origin
requests are trusted as the owner, and on a multi-user app the person's
session cookie makes them (see **Accounts and whose records**).

**Records API** the View calls (PocketBase-compatible REST, served by the adapter):

| Call | Meaning |
|---|---|
| `GET /api/collections/<entity>/records?sort=-created&page=1&perPage=100&filter=status = "todo"` | list; returns `{ items, totalItems }` (single-clause filter: `field = "v"` · `field != "v"` · `field ~ "v"`; anything richer is refused `invalid_filter`, never ignored) |
| `POST /api/collections/<entity>/records` (JSON body) | create; returns the stored record |
| `PATCH /api/collections/<entity>/records/<id>` | update |
| `DELETE /api/collections/<entity>/records/<id>` | delete |
| `GET /api/_a2app` | identity (app name, versions, `authMode`, `accountUrl`) |

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

## App→agent (tasks/events)

**This blueprint supports them.** An operation runner reaches the queue through
the `store` it is handed, and the event types it may fire are declared in
`lib/a2app_schema.rb`:

```ruby
EVENTS = [{ "type" => "invoice.needs_review" }].freeze # every type a runner fires

"request-review" => lambda do |args, _ctx, store|
  rec = store.get_record("invoices", args["invoice"])
  fired = store.trigger("invoice.needs_review", { "invoice" => rec["id"] }, "review")
  { "ok" => true, "queued" => fired["taskId"] }
end,
```

`store.trigger(etype, payload, capability = nil)` emits the event and, when a
capability is named, puts a task on the app's queue; it returns
`{"eventId", "taskId"}`. Without a capability it only announces something —
nothing is queued and no agent is handed it. An undeclared type raises. The
starter's `request-triage` operation is the worked example.

- **Declare the type in `EVENTS` first.** A type that is not declared is
  refused at the moment of firing — inside the operation, in front of a user.
- **Firing the same occurrence twice makes one task.** The same type,
  capability and payload return the task already queued rather than a second.
- **Send ids, not prose or copies.** The agent re-reads the record itself, so a
  copy is stale by the time it is read, and prose in a payload is an instruction
  the app does not get to give: on the agent's side it is fenced and labelled as
  data.
- **The agent acts as whoever asked.** The `store` a runner is handed records
  the runner's caller on the task it queues, and the bridge runs the agent with
  a credential for that person: it sees and changes only what they could, and
  dies when the task ends. Say what the work needs in `CAPABILITIES` —
  `{ "triage" => { "scopes" => ["data:tasks:read", "data:tasks:write"] } }` —
  and the credential holds no more; a capability left out gets `*`, still
  within that person's reach.
- There is **no declarative trigger manifest**, and none is coming — what the
  agent does is the agent's decision, which is what keeps a compromised app from
  steering it. Do not invent a manifest format.
- Prefer plain code for plain events. A task is for work a person would
  otherwise have to think about, and it must be idempotent: a task can be
  redelivered if an agent dies holding it.

The queue only moves when something is listening: `agent-app <dir> bridge start`,
or a harness polling `a2app <dir> tasks next --wait`.

**Show the queued work in the View.** Keep the returned `taskId` on the record
and follow it from the UI with a same-origin `GET /api/_a2app/tasks/{id}`, polled
only while it is unfinished. The View needs no credential for this read: on a
single-user app it is trusted, and on a multi-user app the person's session
makes it. A 404 means the task has been pruned, so drop the indicator; don't
retry it. Render queued → working (`progress.step`) → done or failed (`reason`,
plus a way to ask again). The creator skill lists the states. A button that goes
quiet after it queues work looks broken.

## Accounts and whose records (`authMode: multi-user`)

Scaffold with `--auth-mode multi-user` for an app with accounts. The adapter
then holds the accounts and sessions itself — in its own SQLite tables, never
as records — and the View needs no auth code of its own:

- **Signing in** happens on the framework's account page, `/_a2app/account`. A
  request from the View with no session answers `401 sign_in_required`, and
  `ui/src/api.js` sends the person there; it sends them back afterwards. The
  footer's *Account* link comes from identity's `accountUrl`.
- **The first owner** comes from `agent-app <dir> owner`, which prints a
  one-time setup link. Owners invite everyone else from the account page (or
  `agent-app <dir> invite`). Nobody's password passes through the CLI or an
  agent.
- **Whose records.** `"ownedBy" => "<field>"` on an entity names a
  `"readOnly"` string field the adapter fills with the creator's principal. A
  member then lists, reads, changes and deletes only its own records (anyone
  else's answer 404); an owner sees all. The starter's `tasks` is owned by
  `owner`.
- **What each person may do.** An optional `PERMISSIONS_OF` lambda in
  `lib/a2app_schema.rb` returns a person's scopes; every agent acting for them
  is limited to the same, on every request. Without it everyone active may use
  everything (their records stay their own).
- **Runners** get the caller as `ctx = {"principal", "role", …}` and must hold
  themselves to the same rule for records they touch — the starter's `mine`
  helper in `lib/a2app_schema.rb` is the pattern.

On `authMode: none` the same code runs with one principal, `owner`: every
record is the owner's and nothing is filtered.

## Reaching the app from another machine

The app listens on loopback and answers only to its own names. To let people and
agents reach it from elsewhere, tell it the address they will use, with
`A2APP_PUBLIC_URL`:

- **Behind a TLS proxy (recommended).** Keep the default bind (`A2APP_HOST`
  unset: loopback), put a proxy that terminates TLS in front, and serve with the
  public address. With Caddy, which keeps the original `Host`:

      crm.example.com {
          reverse_proxy 127.0.0.1:<port>
      }

      A2APP_PUBLIC_URL=https://crm.example.com agent-app <dir> serve

  An agent elsewhere then operates it as `a2app https://crm.example.com`, with
  a credential the owner gives it.
- **Through an SSH tunnel.** Nothing to configure: `ssh -L 9000:127.0.0.1:<port>
  <host>`, then `a2app http://localhost:9000`. The tunnel ends on loopback, and
  carries the token encrypted.
- **Listening on the network directly** (`A2APP_HOST=0.0.0.0`) needs an `https`
  `A2APP_PUBLIC_URL`; otherwise the app refuses to start, because the agent
  token would cross the network in clear. A plain-`http` public URL is refused
  for the same reason unless it names this machine (a tunnel).

A request under any other host name is refused `403 forbidden_host`: the app
answers only to loopback and the host of `A2APP_PUBLIC_URL`. That refusal is
also what stops a page whose DNS re-resolves to 127.0.0.1 from reading the app.

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
`ruby lib/a2app_adapter.rb --selftest` — the selftest covers the rules parity,
the SQLite store (durability across a reopen, seed-once, the filter grammar,
paging), the auth layer (password hashes interchangeable with adapter-core's,
codes and cookies, the credential ceiling and its refusals, record ownership,
device sign-in's confirmation code), JavaScript's reading of values and RFC
8785 approval keys, operations and the task lifecycle, a restart that keeps
tasks, events, approval and idempotency keys, and the View's static serving) and **"operations resolve"** (`ruby scripts/check_ops.rb`).
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
