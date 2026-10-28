# Blueprint reference — pocketbase-react

A PocketBase backend + a React frontend, with the A2App adapter running as
in-process PocketBase JS hooks (`pb/pb_hooks/_a2app*.js`). PocketBase serves
records natively; the adapter adds identity + describe, a guard that validates
the raw request body before PocketBase coerces it, declared operations
(`POST /api/ops/{name}`), the app→agent task queue and event log, and who may
do what: agent credentials, and accounts on a multi-user app.

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
| `pb/pb_hooks/operations.js` | **YOURS** | the operation RUNNERS (one per declared operation, same name), the `events` this app may emit, the `readOnly` fields only runners write, whose records are whose (`ownedBy`), what each capability's agent may do (`capabilities`), and optionally what each person may do (`permissionsOf`). Loaded with `require()`, never as a hook file. |
| `pb/pb_migrations/1759622400_created_tasks.js` | **YOURS** | the starter's `tasks` collection (with its `owner` field and access rules chosen by the app's mode) and welcome row — the first link in your migration chain. Never edit it once applied; change `tasks` with a new migration. |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | ignores `pb/pb_data`, credentials, the binary, and the built View (`pb/pb_public/`). Extend as needed. |
| `ui/index.html` · `ui/src/**` | **YOURS** | the React View source: App, shared pieces (Icon, `useToast`, `useConfirm`, `api`, formatting). Compiled into `pb/pb_public/` by the pipeline build. |
| `ui/public/tokens.css` · `ui/public/ui.css` | **YOURS** | the kit design-token sheet + component styles, copied through the build verbatim. Re-point token values; keep the names stable. |
| `ui/vite.config.js` · `ui/package.json` | build | the View build: React plugin, output to `../pb/pb_public`, dev-server proxy to the running app. |
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]` **and their `entities[]`** (the collection→module map you maintain), `authMode`, `pipeline`. |
| `pb-serve.mjs` | SYSTEM (hash-locked) | the cross-platform launcher `pipeline.start` runs. Reads `PORT`/`A2APP_DATA_DIR`/`A2APP_ENV`, hands migrations the app's mode (`A2APP_AUTH_MODE`), ensures the superuser, snapshots the View for live boots, and runs `pocketbase serve` (or `--migrate` for promote). Never edit. |
| `pb/pb_hooks/_a2app.pb.js` | SYSTEM (hash-locked) | the adapter hook REGISTRATIONS — thin one-liner handlers that `require()` the impl module (PocketBase runs each handler isolated from file scope). Never edit. |
| `pb/pb_hooks/_a2app_impl.js` | SYSTEM (hash-locked) | the adapter IMPLEMENTATION: identity, describe, the record guards, operations, the task queue and event log, credentials, accounts, sessions and device sign-in, loaded via `require()` from the handlers. Never edit. |
| `pb/pb_hooks/_a2app_rules.js` | SYSTEM (hash-locked) | the pure rules (guard, predicates, fingerprint, operation args, approval/dedup keys, task lifecycle, sweep, scopes and the ceiling, credentials, cookies, user codes, sign-in limits, device polling) + `--selftest`. Never edit. |
| `pb/pb_migrations/1759622300_a2app_accounts.js` | SYSTEM (hash-locked) | prepares PocketBase's `users` collection to hold a multi-user app's accounts (`login`, `role`, `active`), turns off PocketBase's own sign-in and locks its rules. Applied once, before your migrations. Never edit. |
| `a2app-account.html` | SYSTEM (hash-locked) | the framework's account page at `/_a2app/account`: sign in, accept an invite, people (owner), the agents acting for you. The same file in every blueprint. Never edit. |

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
- **Queue and access state is the adapter's, not yours.** Tasks, events,
  approval keys, agent credentials, sessions, invites and device sign-in
  requests live in tables of their own in `data.db` (`_a2app_tasks`,
  `_a2app_events`, `_a2app_approvals`, `_a2app_grants`, `_a2app_sessions`, …),
  created at boot, every secret stored only as its SHA-256. They are not
  collections, so they never appear in describe or the records API, and you
  never migrate them. They survive a restart; a dev boot starts empty. The one
  exception is accounts: on a multi-user app they are records of PocketBase's
  `users` collection, so your collection rules can name the signed-in person
  (see **Accounts and whose records**).
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
- **Whose records.** A collection whose records belong to the person who made
  them gets a text field for it and an entry in `operations.js`'s
  `ownedBy: { <collection>: "<field>" }`, plus the matching access rules in its
  migration (see **Accounts and whose records**).
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
a single-user app or a signed-in person on a multi-user one, or an agent's
credential holding `op:<name>`; a `readOnly` operation also answers an
uncredentialled caller on a single-user app), and for a `destructive`
operation answers **428 + an `approvalKey`** until the call is repeated with
that key in `X-A2App-Approval`. The key is content-addressed — this operation
with these exact arguments — and good once. A call carrying an
`Idempotency-Key` that already ran is refused with 409 `duplicate_request`
instead of running twice.

A runner receives `(args, ctx, a2app)`:

- `ctx` — who is calling: `{ credentialId, agentName, principal, role }`.
  `principal` is `owner` or an account id; `role` is `owner` or `member`.
- `a2app.app` — the PocketBase app to read and write through. **It is a
  transaction**: the whole runner, and every task it queues, commits together
  or not at all, so a runner that throws leaves nothing half-written. Use it
  rather than `$app`, and keep slow outbound calls out of runners — the
  transaction holds the database's write lock until you return. It is not held
  to your collection rules, so a runner holds itself to them: the starter's
  `mine(ctx, record)` helper is the pattern.
- `a2app.trigger(type, payload, capability)` — see **App→agent triggers**.
- `a2app.task(id)` — a queued task as the agent sees it (`{ id, status, … }`),
  or `null`. Read inside the same transaction, so it is current.
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
  the agent operates. The guard validates every create/update.
- `POST /api/ops/<name>` — run a declared operation. Same-origin, so no
  credential: on a single-user app the View is trusted, on a multi-user app the
  person's session carries it.
- `GET /api/_a2app/tasks/<id>` — follow work queued for an agent.
- `GET /api/_a2app` — identity (app name, versions, `authMode`, `accountUrl`).

`ui/src/api.js` sends a person who is not signed in to the account page (on
`401 sign_in_required`) and back, and the footer links to it from
`identity.accountUrl`; the View has no auth code of its own.

Every route answers only on its own `Host` (loopback, or the public URL's), and
a browser `Origin` other than the app's own is refused (403). PocketBase's own
routes (records, realtime, files, batch) and the adapter's go through the same
check of who is calling: an agent's credential (`X-A2App-Token`), held to its
scopes; on a multi-user app, the signed-in person, whose changes must carry the
app's own `Origin`; on a single-user app, the app's own View, and a program
with no credential may read. A signed-in superuser (the dashboard) passes as
itself. On PocketBase's routes the caller then becomes `@request.auth`, so your
collection rules decide what it sees — see **Accounts and whose records**.
`pb-serve.mjs` also limits CORS to the app's own origin.

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
  "request-triage": (args, ctx, a2app) => {
    const task = mine(ctx, findTask(a2app, args.task)); // the caller's own, or an owner's pick
    if (!task) return { ok: false, reason: "no such task" };
    const previous = task.getString("agentTask");
    const current = previous ? a2app.task(previous) : null;
    if (current && !["completed", "failed", "canceled"].includes(current.status)) {
      return { ok: true, task: task.id, queued: current.id, alreadyQueued: true }; // one open run per record
    }
    const payload = previous ? { task: task.id, previous } : { task: task.id };
    const { taskId } = a2app.trigger("task.needs_triage", payload, "triage");
    task.set("agentTask", taskId);
    a2app.app.save(task);
    return { ok: true, task: task.id, queued: taskId };
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
- **The agent acts as whoever asked.** The task records the runner's caller
  (`request.principal`), and the bridge runs the agent with a credential for
  that person: it sees and changes only what they could, and dies when the task
  ends. Say what the work needs in `operations.js`'s `capabilities` —
  `{ triage: { scopes: ["data:tasks:read", "data:tasks:write"] } }` — and the
  credential holds no more; a capability left out gets `*`, still within that
  person's reach. Work queued outside an operation (below) has no caller and
  runs as the owner.
- **The same occurrence is one task.** Type + capability + payload + who asked
  is the dedup key, even after the task has finished, so asking again with the
  same payload hands back the old task. Put the previous task id in the payload
  (as above) to ask again for real.
- **One open run per record.** Check the record's last task with `a2app.task`
  and hand it back while it is unfinished (as above). Otherwise a double click,
  a retry, or the agent itself asking from inside its run queues a second run
  for the same record.
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

**Keep the task id on the record.** An agent run takes seconds to minutes. Put
the returned `taskId` on the record (the starter's `agentTask`), so the View, or
an agent reading the record, can follow the work with
`GET /api/_a2app/tasks/{id}` until it is done: `submitted`, `working` (with the
agent's `progress.step`), then `completed` (`result.summary`) or `failed`
(`reason`). The View needs no credential for this read: on a single-user app it
is trusted, and on a multi-user app the person's session makes it. A 404 means
the task is gone.

**Declare that field read-only.** An agent that saves a record it read a
minute earlier would otherwise write back the old task id. PocketBase has no
read-only flag for a field, so declare it in `operations.js`:

```js
readOnly: { tasks: ["agentTask"] },
```

Describe then publishes it as `readOnly`, and a client write to it (the View,
an agent, the records API) is refused with `read_only_field`, as on the other
stacks. Your runners still set it through `a2app.app.save()`, which does not pass
through the request guard, and the owner can still edit it in the PocketBase
dashboard. If `operations.js` cannot be loaded, client writes are refused with
503 `app_code_unavailable` until it is fixed, rather than letting a read-only
field be overwritten unnoticed.

## Accounts and whose records (`authMode: multi-user`)

Scaffold with `--auth-mode multi-user` for an app with accounts. The adapter
then holds the accounts and sessions itself, and the View needs no auth code of
its own:

- **Signing in** happens on the framework's account page, `/_a2app/account`. A
  request from the View with no session answers `401 sign_in_required`, and
  `ui/src/api.js` sends the person there; it sends them back afterwards.
  PocketBase's own sign-in is turned off, so this is the only way in.
- **The first owner** comes from `agent-app <dir> owner`, which prints a
  one-time setup link. Owners invite everyone else from the account page (or
  `agent-app <dir> invite`). Nobody's password passes through the CLI or an
  agent.
- **Accounts are `users` records.** They live in PocketBase's `users`
  collection (`name`, `login`, `role`, `active`) so that a collection rule can
  name the signed-in person. On every request to PocketBase's own routes the
  adapter makes the caller `@request.auth`: the person's `users` record for
  their session or for an agent acting for them, and the app's superuser for
  the owner's own credential (the `.agent-token`). The collection itself is
  locked: no rule lists, creates or changes an account through the records API.
- **Whose records.** `ownedBy: { <collection>: "<field>" }` in `operations.js`
  names a text field the adapter fills with the creator's principal (an account
  id, or `owner`) and no client may write; describe publishes it. The
  collection's own rules do the rest. The starter's `tasks` migration chooses
  them by the app's mode (`$os.getenv("A2APP_AUTH_MODE")`, set by
  `pb-serve.mjs`):

  ```js
  const theirs = '@request.auth.id != "" && (owner = @request.auth.id || @request.auth.role = "owner")';
  // list/view/update/delete: theirs · create: '@request.auth.id != ""'
  ```

  A member then lists, reads, changes and deletes only its own records (anyone
  else's answer 404, and a list is filtered before it is paged); an owner sees
  all. **Every collection you add needs rules like these on a multi-user app**:
  the adapter turns away anyone not signed in, but a public (`""`) rule shows
  every record to every signed-in person and every agent acting for one. The
  rules are written when the migration runs, so an app switched to multi-user
  later needs a new migration that sets them.
- **Runners** get the caller as `ctx = { principal, role, … }` and must hold
  themselves to the same rule for records they touch — they write through a
  transaction the rules do not see. The starter's `mine` helper in
  `operations.js` is the pattern.
- **What each person may do.** An optional `permissionsOf(principal)` in
  `operations.js` returns the scopes a person may use; every agent acting for
  them is limited to the same, on every request. Without it everyone active may
  use everything (their records stay their own).

On `authMode: none` the same code runs with one principal, `owner`: every
record is the owner's, the starter's rules are public, and nothing is filtered.

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
agent-app <dir> validate   # framework files → build → hooks syntax + rules self-test → operations resolve → ownership canon → describe budget (on dev)
agent-app <dir> serve      # launch LIVE as a managed, health-polled background process; prints the URL
agent-app <dir> promote    # requires the gate pass; backup, `pb-serve.mjs --migrate` applies new migrations to live, destroys dev
```

Toolkit gate steps (from `a2app.toolkit.json`): **"hooks syntax + rules
self-test"** (`node --check` the three adapter files, then
`node pb/pb_hooks/_a2app_rules.js --selftest`, which covers the guard, the
predicates, the fingerprint, operation arguments, the approval and dedup keys,
the task lifecycle and the sweep, and the access rules: scopes and the
ceiling, credentials, cookies, user codes, sign-in limits, device polling),
and **"operations resolve"** (every
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
  slow outbound HTTP out of it. It is not held to your collection rules: check
  `ctx` yourself (`mine`).
- **Collection rules are the ownership.** On a multi-user app the adapter only
  says who is calling; what they see is your collection's rules. A new
  collection with public (`""`) rules is readable by every signed-in person.
- **Empty-DB first paint.** The View must render loading/empty/error states
  against a database with no records; the verifier fails any first-paint error.
- **The View is served built.** Editing `ui/src/` changes nothing a browser sees
  until `npm --prefix ui run build` regenerates `pb/pb_public/` (live also needs
  promote + serve — it serves a boot-time snapshot).
- **Goja, not Node.** Hook handlers `require()` their modules locally and cannot
  close over file-scope state.
