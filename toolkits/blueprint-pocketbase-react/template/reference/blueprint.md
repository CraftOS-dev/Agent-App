# Blueprint reference — pocketbase-react

A PocketBase backend + a React frontend, with the A2App adapter running as
in-process PocketBase JS hooks (`pb/pb_hooks/_a2app*.js`). PocketBase serves
records natively; the adapter adds identity + describe, a guard that validates
the raw request body before PocketBase coerces it, declared operations
(`POST /api/ops/{name}`), and the app→agent task queue and event log.

Where the `creator`/`modify` skill says "per your stack", the answer is here. If
this file and the source disagree, the source wins.

## Read this first

The scaffold gives you the A2App adapter and the framework files. You build what
the app actually does:

- **entities** — PocketBase collections, defined by JavaScript migration files
  under `pb/pb_migrations/` (a migration is a `.js` file PocketBase runs at boot
  to create or alter collections — see **Schema** below);
- **operations** — declared in `operations.json`, run by a function of the same
  name in `pb/pb_hooks/operations.js` (see **Operations**);
- **the View** — the React (Vite) starter app in `ui/`, compiled by the pipeline
  build into `pb/pb_public/`, which PocketBase serves (see **The View**).

A freshly scaffolded app is the starter to-do list: one migration creates the
`tasks` collection (with a welcome row), `operations.js` runs four operations
including `request-triage`, which queues work for an agent, and the View shows
that work until it is done. Replace all three with your own.

## File map — who owns what

**Ships on a fresh scaffold:**

| Path | Owner | What it is |
|---|---|---|
| `operations.json` | **YOURS** | the operation declarations `describe` and approval read (name, module, typed params, entity, appliesWhen, flags). |
| `pb/pb_hooks/operations.js` | **YOURS** | the operation RUNNERS (one per declared operation, same name), the `events` this app may emit, and the `readOnly` fields only runners write. Loaded with `require()`, never as a hook file. |
| `pb/pb_migrations/1759622400_created_tasks.js` | **YOURS** | the starter's `tasks` collection and welcome row — the first link in your migration chain. Never edit it once applied; change `tasks` with a new migration. |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | ignores `pb/pb_data`, credentials, the binary, and the built View (`pb/pb_public/`). Extend as needed. |
| `ui/index.html` · `ui/src/**` | **YOURS** | the React View source: App, shared pieces (Icon, `useToast`, `useConfirm`, `api`, formatting, `AgentTask.jsx`). Compiled into `pb/pb_public/` by the pipeline build. |
| `ui/public/tokens.css` · `ui/public/ui.css` | **YOURS** | the kit design-token sheet + component styles, copied through the build verbatim. Re-point token values; keep the names stable. |
| `ui/vite.config.js` · `ui/package.json` | build | the View build: React plugin, output to `../pb/pb_public`, dev-server proxy to the running app. |
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]` **and their `entities[]`** (the collection→module map you maintain), `authMode`, `pipeline`. |
| `pb-serve.mjs` | SYSTEM (hash-locked) | the cross-platform launcher `pipeline.start` runs. Reads `PORT`/`A2APP_DATA_DIR`/`A2APP_ENV`, ensures the superuser, snapshots the View for live boots, and runs `pocketbase serve` (or `--migrate` for promote). Never edit. |
| `pb/pb_hooks/_a2app.pb.js` | SYSTEM (hash-locked) | the adapter hook REGISTRATIONS — thin one-liner handlers that `require()` the impl module (PocketBase runs each handler isolated from file scope). Never edit. |
| `pb/pb_hooks/_a2app_impl.js` | SYSTEM (hash-locked) | the adapter IMPLEMENTATION: identity, describe, the record guards, operations, the task queue and event log, loaded via `require()` from the handlers. Never edit. |
| `pb/pb_hooks/_a2app_rules.js` | SYSTEM (hash-locked) | the pure rules (guard, predicates, fingerprint, operation args, approval/dedup keys, task lifecycle, sweep) + `--selftest`. Never edit. |

**You create or obtain (nothing ships for these):**

| Path | Owner | What it is |
|---|---|---|
| `pb/pocketbase` (`pb/pocketbase.exe` on Windows) | runtime | the PocketBase binary, **pinned to v0.26.6** (the adapter targets the 0.26 JSVM API). You download it (see pipeline `install`); nothing runs without it. `pb-serve.mjs` picks the right name per platform and refuses to launch a non‑0.26.x build. Git-ignored. |
| `pb/pb_migrations/*.js` | **YOURS** | every further collection (entity) change, as a new PocketBase JS migration. |
| `pb/pb_hooks/<name>.pb.js` | **YOURS** | your own hooks, if you need any beyond operations: a record event hook, a cron job, an outbound sync. Never touch `_a2app*`. |
| `pb/pb_public/**` | build output | the COMPILED React View (`npm --prefix ui run build`); PocketBase serves it statically. Git-ignored; edit `ui/src/`, never this. |
| `pb/pb_data/` | runtime | the live database (git-ignored, created on first boot). Never edit by hand; never commit. |

SYSTEM files are hashed in `.a2app/system-hashes.json`; the gate fails the build
if one changes. Need a variant of adapter behavior? You cannot edit the hooks —
model it as your own collection field, migration, or operation hook instead.

## Mental model

- The **adapter is the only agent surface.** PocketBase serves records; the hooks
  add the protocol surface and validate raw writes via
  `onRecordCreateRequest`/`onRecordUpdateRequest`.
- **Queue state is the adapter's, not yours.** Tasks, events and approval keys
  live in tables of their own in `data.db` (`_a2app_tasks`, `_a2app_events`,
  `_a2app_approvals`), created at boot. They are not collections, so they never
  appear in describe or the records API, and you never migrate them. They
  survive a restart; a dev boot starts with an empty queue.
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
- **Read-only fields.** PocketBase has no read-only flag for a field. Declare
  the ones only your runners may write in `operations.js` as
  `readOnly: { <collection>: ["<field>", …] }` (see **App→agent triggers**).
- **Field → protocol type mapping** the adapter publishes: PocketBase `text` →
  `string`, `number` → `number`, `bool` → `boolean`, `date` → `datetime`,
  `json` → `json`, `file` → `binary`, `select` (single) → `enum` / (multi) →
  `list<enum>`, `relation` (single) → `ref` / (multi) → `list<ref>`. A short
  `text` field (max ≤ 12) named like `due`/`day`/`date`/`*_date`/`*_day` is
  advertised as a `YYYY-MM-DD` day key automatically.
- **Seeding:** seed starter rows in a migration so they survive a fresh build.

## Operations — anything beyond plain CRUD

Plain create/read/update/delete is served natively by PocketBase — no operation
needed. A declared operation is for behavior beyond CRUD, and it takes two
edits that must agree:

1. **Declare it** in `operations.json` with `module`, typed `params` (`{}` if
   none), optional `entity` + `appliesWhen`, and flags.
2. **Run it** in `pb/pb_hooks/operations.js`, under `runners`, by the same name:

```js
// pb/pb_hooks/operations.js
module.exports = {
  events: [],
  runners: {
    "complete-task": (args, ctx, a2app) => {
      const task = a2app.app.findRecordById("tasks", args.task);
      task.set("status", "done");
      a2app.app.save(task);
      return { ok: true, task: task.id };
    },
  },
};
```

The adapter serves it as `POST /api/ops/{name}`. Before your runner is called it
guards the arguments against the declared `params` (an undeclared or missing
required argument is a 400 with every violation), checks the caller (the View on
a single-user app, or the agent's `.agent-token`; a `readOnly` operation also
answers an uncredentialled caller on a single-user app), and for a `destructive`
operation answers **428 + an `approvalKey`** until the call is repeated with
that key in `X-A2App-Approval`. The key is content-addressed — this operation
with these exact arguments — and good once.

A runner receives `(args, ctx, a2app)`:

- `a2app.app` — the PocketBase app to read and write through. **It is a
  transaction**: the whole runner, and every task it queues, commits together
  or not at all, so a runner that throws leaves nothing half-written. Use it
  rather than `$app`, and keep slow outbound calls out of runners — the
  transaction holds the database's write lock until you return.
- `a2app.trigger(type, payload, capability)` — see **App→agent triggers**.
- `a2app.error(status, code, message)` — `throw` it to refuse with your own
  status and code. Anything else a runner throws is `operation_failed`.

Return a plain JSON-able value; it is the call's `result`.

Declaration fields (same contract as every stack):

- **`params`** — REQUIRED and typed (`string`/`number`/`ref`/…); the record
  screen renders it as the operation's signature. Args in prose don't count.
- **`entity`** attaches the op to a record screen; **`appliesWhen`** decides
  availability and the adapter derives the blocked reason from it. Comparisons
  only — `eq`, `ne`, `in`, `notIn`, `isBlank`, composed with `all`/`any`/`not`.
- **Flags:** `destructive: true` (requires human approval), `readOnly: true`,
  `idempotent: true`.

The gate's **"operations resolve"** step fails a declared operation with no
runner. It cannot tell whether a runner does the right thing: in the REALITY
CHECK, run `a2app <dir> <module> <entity> <id>` on a live record and confirm the
operation is available when it should be, blocked (with a sensible reason) when
it should not, and that running it changes what it says it does.

## The View — `ui/` (React, compiled into `pb/pb_public/`)

A React (Vite) starter View ships in `ui/`: the same to-do screens as the
react-node blueprint — states (loading/empty/error/list), toasts, an in-app
confirm dialog, keyboard shortcut — built on the kit's design tokens
(`ui/public/tokens.css`, light + dark, WCAG AA). The pipeline build compiles it
into `pb/pb_public/`, which PocketBase serves statically; no system-owned file
is involved.

The starter reads the `tasks` collection its migration creates. When you
replace that collection, repoint `ui/src/App.jsx` at your own entities.
For tight iteration `npm --prefix ui run dev` runs Vite's dev server with
`/api` proxied to the running app. The View talks to PocketBase's records API:

- `GET/POST/PATCH/DELETE /api/collections/<entity>/records` — the same records
  the agent operates. Same-origin browser writes are fine; the guard validates
  every create/update.
- `POST /api/ops/<name>` — run a declared operation (the starter's "Ask an
  agent" calls `request-triage`). Same-origin, so no credential on a
  single-user app.
- `GET /api/_a2app/tasks/<id>` — follow work queued for an agent (what
  `AgentTask.jsx` polls).
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

**This blueprint supports them.** The adapter's hooks are system-owned, so the
handle that queues agent work reaches you as `a2app.trigger` in an operation
runner, beside `a2app.app`:

```js
// pb/pb_hooks/operations.js
events: [{ type: "task.needs_triage" }],

runners: {
  "request-triage": (args, _ctx, a2app) => {
    const task = a2app.app.findRecordById("tasks", args.task);
    const payload = { task: task.id };
    if (task.getString("agentTask")) payload.previous = task.getString("agentTask");
    const { taskId } = a2app.trigger("task.needs_triage", payload, "triage");
    task.set("agentTask", taskId);
    a2app.app.save(task);
    return { ok: true, queued: taskId };
  },
},
```

`trigger(type, payload, capability)` emits the event and, when a capability is
named, puts a task on the app's queue. Without a capability it only announces
something — nothing is queued and no agent is ever handed it.

- **The type must be in `events`.** The adapter refuses an undeclared type at
  fire time, inside the operation, so a typo works in review and fails in front
  of a user — the operation answers `operation_failed` and rolls back.
- **Send ids.** The agent re-reads the record; a copy in the payload is stale by
  the time it is read, and prose there is an instruction the app does not get to
  give.
- **The same occurrence is one task.** Type + capability + payload is the dedup
  key, even after the task has finished, so asking again with the same payload
  hands back the old task. Put the previous task id in the payload (as above) to
  ask again for real.
- **Outside an operation** — a record hook or a cron job in your own
  `pb/pb_hooks/<name>.pb.js` — call
  ``require(`${__hooks}/_a2app_impl.js`).trigger(type, payload, capability)``
  inside the handler (Goja handlers cannot see file scope). It runs in a
  transaction of its own; inside your own `$app.runInTransaction((txApp) => …)`
  pass `txApp` as a fourth argument, or it would wait on itself.

The queue only moves when something is listening: `agent-app <dir> bridge start`,
or a harness polling `a2app <dir> tasks next --wait`. A claimed task with no
update for 60 s goes back to the queue; after 5 deliveries it fails as
`redelivery_exhausted`.

**Show the queued work in the View — with `ui/src/AgentTask.jsx`.** An agent run
takes seconds to minutes, so the control that queued it has to show where it is
until it is done. Keep the returned `taskId` on the record (a text field the
runner sets and the app declares read-only, like the starter's `agentTask`),
then render it:

```jsx
import { AgentTaskBadge, AgentTaskPanel } from "./AgentTask.jsx";

<AgentTaskBadge taskId={rec.agentTask} />          // in the list row, beside the title
<AgentTaskPanel taskId={rec.agentTask}             // full width: under the row, or on the record's screen
  onSettled={reloadRecord} onRetry={askAgain} retrying={asking} />
```

The panel follows `GET /api/_a2app/tasks/{id}` while the run is unfinished and
renders every state the creator skill lists: waiting with elapsed time (and "no
agent is listening" after ~20 s), the agent's step and running time, the
`result.summary` in its own readable block, and the failure `reason` with "Ask
again". `useAgentTask(id)` gives you the same state to disable a control while a
run is open. The starter's "Ask an agent" button is the worked example.

Never put the result in a title cell or a narrow column. It is prose of any
length, and the panel is where it goes.

On a single-user app (`authMode: "none"`) the View needs no credential for the
task read. **On a multi-user app it answers 401** to a caller without the agent
token. There, have the agent write its progress onto the record and pass it as
`progress={{ status, step, summary, reason }}`; the panel and badge render it the
same way. A 404 means the task is gone, so the indicator disappears.

**Declare that field read-only.** An agent that saves a record it read a
minute earlier would otherwise write back the old task id, and the View would
stop showing the run in progress. PocketBase has no read-only flag for a field,
so declare it in `operations.js`:

```js
readOnly: { tasks: ["agentTask"] },
```

Describe then publishes it as `readOnly`, and a client write to it (the View,
an agent, the records API) is refused with `read_only_field`, as on the other
stacks. Your runners still set it through `a2app.app.save()`, which does not pass
through the request guard, and the owner can still edit it in the PocketBase
dashboard.

**`validate` checks this.** Its "agent work shown in the View" step fails an
app whose code queues work (`trigger(…)` with a capability) when no View code
renders the component or reads `/api/_a2app/tasks/`.

## Build, run, gate

`manifest.json`'s `pipeline`:

- `install` = `npm --prefix ui install`, then a reminder to **download PocketBase v0.26.6 into `./pb`** — do
  this before serving, or `start` has nothing to run. The adapter targets the 0.26
  JSVM API (`onRecordCreateRequest`/`e.next()`, `$app.find*`, `collection.fields`,
  `e.requestInfo().body`), so **only 0.26.x is supported** — the launcher asserts
  the binary's version and refuses anything else.
- `build` = `npm --prefix ui run build` (compiles the React View into
  `pb/pb_public/`), then `node --check pb/pb_hooks/_a2app.pb.js`.
- `start` = `node pb-serve.mjs` — the launcher runs `pocketbase serve` bound to the
  environment's `PORT`. It is cross-platform on purpose: the raw `pb/pocketbase
  serve --http 127.0.0.1:${PORT} ...` form is not, because cmd.exe neither expands
  `${PORT}` nor runs an executable path written with `/`.
- `health` = `/api/_a2app`.

```bash
agent-app <dir> dev        # boot the candidate on a hidden port: fresh DB from your migration chain, prints the dev URL
agent-app <dir> validate   # framework files → build → hooks syntax + rules self-test → operations resolve → agent work shown in the View → ownership canon → describe budget (on dev)
agent-app <dir> serve      # launch LIVE as a managed, health-polled background process; prints the URL
agent-app <dir> promote    # requires the gate pass; backup, `pb-serve.mjs --migrate` applies new migrations to live, destroys dev
```

Toolkit gate steps (from `a2app.toolkit.json`): **"hooks syntax + rules
self-test"** (`node --check` the three adapter files, then
`node pb/pb_hooks/_a2app_rules.js --selftest`, which covers the guard, the
predicates, the fingerprint, operation arguments, the approval and dedup keys,
the task lifecycle and the sweep), and **"operations resolve"** (every
operation in `operations.json` has a runner in `pb/pb_hooks/operations.js`). `lifecycle.dataDir` is
`pb/pb_data`; `lifecycle.promote` is `node pb-serve.mjs --migrate`.

**Environments (one tree, redirected inputs).** The launcher reads `PORT`,
`A2APP_DATA_DIR` and `A2APP_ENV` from the framework. A dev boot runs against a
fresh per-boot data directory — PocketBase replays your ENTIRE migration chain
into it, so every `dev` re-proves the chain from empty. On dev, `pb_public/`
is served from the tree (View edit → refresh) and hooks run under watch
(auto-restart on hook edits on macOS/Linux; on Windows re-run `dev`). LIVE
serves a boot-time snapshot of `pb_public/` (`.a2app/public`) with hooks
pinned, so nothing you edit reaches users until promote + serve. A superuser
is ensured in the target database before every boot from the project-local
`.superuser` credential (minted on first use) — without it PocketBase would
pop its admin-installer page.

## Footguns for this stack

- **Get the binary first, and it must be v0.26.6.** Nothing runs until
  `pb/pocketbase` exists, and the launcher rejects any non‑0.26.x build (the
  adapter is written against the 0.26 JSVM API).
- **The starter migration is applied on the first boot.** From then on change
  `tasks` with a new migration file, never by editing
  `1759622400_created_tasks.js`.
- **Register every new collection in `manifest.json`'s module `entities[]`** or it
  has no screen and cannot be walked.
- **Migrations are identity-locked and additive.** Never edit/rename/delete an
  applied migration; fix mistakes with a new one; never drop a collection with
  data.
- **Two files per operation.** `operations.json` declares it, `operations.js`
  runs it. The gate fails a declaration with no runner, not a runner that does
  the wrong thing.
- **A runner is a transaction.** Write through `a2app.app`, not `$app`, and keep
  slow outbound HTTP out of it.
- **Empty-DB first paint.** The View must render loading/empty/error states
  against a database with no records; the verifier fails any first-paint error.
- **The View is served built.** Editing `ui/src/` changes nothing a browser sees
  until `npm --prefix ui run build` regenerates `pb/pb_public/` (live also needs
  promote + serve — it serves a boot-time snapshot).
- **Goja, not Node.** Hook handlers `require()` their modules locally and cannot
  close over file-scope state.
