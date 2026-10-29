# Blueprint reference — sidecar (adopt a foreign app as-is)

An app that already exists — any HTTP app, in any stack, with no framework
files and no adapter of its own — runs **unchanged** from `upstream/`. In front
of it, the sidecar A2App adapter (`@a2app/reverse-proxy`) starts it, waits until
it answers, and serves the A2App surface on this app's port, forwarding each
declared operation to one of the app's own routes. Accounts, delegated agent
credentials, the ceiling, device sign-in and approval for destructive
operations come with the adapter (`@a2app/adapter-core`); the adopted app needs
none of them.

Where the `importer` skill says "adopt", the answer is here. If this file and
the source disagree, the source wins.

## Read this first

- **Never edit `upstream/`.** It is the adopted app, kept read-only. Anything
  it needs in order to run here — its argv, its port, environment variables —
  is declared in `sidecar.json`, not patched into its code.
- **Operate-only.** The app's data model stays its own: describe reports no
  entities, the walk stops at the module level (`a2app <dir>` → `a2app <dir>
  <module>` → run an operation there), and the `data` verbs do not apply.
- **No View.** The app's own UI stays at its own address. The sidecar serves
  the protocol and the framework's account page (`/_a2app/account`), nothing
  else.
- **Verify the mapping, not the app.** Verification covers the app launching
  and every operation reaching the route it claims to. The app's own features
  ship as they are, quirks included — you cannot fix them and must not try.

## File map — who owns what

| Path | Owner | What it is |
|---|---|---|
| `upstream/` | **YOURS to place, never to edit** | the adopted app's source, exactly as it came. |
| `sidecar.json` | **YOURS** | how the app starts (`upstream`), and which route each operation reaches (`operations`). |
| `operations.json` | **YOURS** | what each operation is: name, module, typed `params`, `destructive`, `readOnly`, `idempotent`, description. |
| `manifest.json` | SYSTEM (hash-locked) | identity, `authMode`, `modules`, and the `pipeline`. Edit `modules`/`authMode`, then reseal with `agent-app <dir> toolkit-sync` (the pipeline is restored from the toolkit; identity and modules are kept). |
| `a2app-account.html` | SYSTEM (hash-locked) | the framework's account page: sign in, invites, people, connected agents, approving an agent's sign-in. The same file in every blueprint. |
| `package.json` | **YOURS** | installs the sidecar. Add a `build` script if the adopted app needs installing or building (see **Build, run, gate**). |
| `AGENT_APP.md` | **YOURS** | what the app is, its modules and operations, for the agents that operate it. |
| `reference/requirements.md` | **YOURS** | the spec of what adoption adds — the launch and the operations, never the app's own features. |
| `reference/tasks.md` | **YOURS** | the build ledger. |
| `reference/blueprint.md` | reference | this file. |
| `.gitignore` | **YOURS** | credentials, framework state, `data/` and `node_modules/` stay out of git. |

## Mental model

```
agent ──A2App──▶ sidecar (this app's port)          upstream/ (its own port, loopback)
                   identity · describe · auth          the adopted app, unchanged
                   POST /api/ops/add-note ──────────▶  POST /notes {"text": …}
                   ◀── { ok, result: <its answer> } ◀── 201 {"id": …}
```

`pipeline.start` runs the sidecar. The sidecar reads `sidecar.json`, starts
`upstream.command` in `upstream.cwd` (argv, never through a shell), polls
`upstream.health` until it answers below 400, then binds this app's port. A
declared operation, once it has passed the adapter's checks (origin,
credential, scope, typed params, approval), becomes exactly one request to the
app. If the app exits, the sidecar exits too — `serve` then shows the app as
down instead of a surface whose every operation fails. Stopping the sidecar
stops the app.

## Adopting an app, step by step

1. **Place the source.** Copy the app into `upstream/` as it came from its
   origin. Read its README and dependency manifest (`package.json`,
   `pyproject.toml`, `go.mod`, `Cargo.toml`): how it starts, which port and
   environment it reads, whether it needs a build step, where it keeps data.
   If it cannot run here at all (a database server, private services, system
   packages), stop and tell the person exactly what is missing.

2. **Declare how it starts** in `sidecar.json`'s `upstream`:

   ```json
   "upstream": {
     "command": ["node", "server.js"],
     "cwd": "upstream",
     "port": "auto",
     "env": { "PORT": "{port}", "HOST": "127.0.0.1", "DATA_DIR": "{dataDir}" },
     "health": "/health"
   }
   ```

   - `command` is an argv list, run without a shell. Name the program itself:
     on Windows a `.cmd`/`.bat` script (`npm`, `npx`, `yarn`) cannot be started
     this way, so run its target with `node` (`["node",
     "node_modules/vite/bin/vite.js", "preview"]`), or the app's own entry file.
   - `port: "auto"` picks a free port at each boot and hands it over as
     `{port}`, in an argument or an environment variable. Prefer it: a fixed
     port collides when the dev instance and the live app run side by side.
     Use a number only for an app whose port cannot be changed.
   - `{dataDir}` is a directory for the app's own data inside this app's data
     directory: a dev instance gets a fresh one, and backups cover it. Hand it
     over when the app lets you choose where its data goes.
   - Bind loopback: if the app reads a host setting, pass `127.0.0.1`.
   - `health` is a path the app answers below 400 once it is ready; `/` works
     for most apps with a UI, an API often has `/health` or `/docs`.

3. **Name the modules.** The grouping is already there — use it. OpenAPI tags,
   route prefixes (`/api/invoices/*`, `/api/customers/*`) and controller files
   each name an area a person would recognise; make each one a module in
   `manifest.json`, then `agent-app <dir> toolkit-sync`. Flattening a large API
   into one module produces a screen the describe budget (2,000 characters per
   level) will fail. Never use a reserved first segment: `data`, `identity`,
   `whoami`, `context`, `tasks`, `events`.

4. **Map its API.** For each thing an agent should be able to do, declare an
   operation in `operations.json` and map it in `sidecar.json`:

   ```json
   { "name": "delete-note", "description": "Delete one note.", "module": "notes",
     "destructive": true, "params": { "id": { "type": "string", "required": true } } }
   ```

   ```json
   "operations": { "delete-note": { "method": "DELETE", "path": "/notes/{id}" } }
   ```

   Probe in order: an OpenAPI/Swagger spec in the repo → route definitions in
   code → the README. Derive `params` from the OpenAPI parameter schema where
   there is one; otherwise read the handler and declare them — an operation
   whose arguments you cannot state does not ship. Mark everything that deletes
   or overwrites `"destructive": true`; mark pure reads `"readOnly": true`
   (an anonymous caller on a single-user app may run those). If the app has no
   server API (a static site), leave `operations` empty and say so — never
   invent verbs, never map direct database writes.

5. **Validate, serve, walk-verify.**

   ```bash
   agent-app <dir> validate        # framework files → build → sidecar.json check → canon
   agent-app <dir> serve           # starts the sidecar, which starts the app
   a2app <dir>                     # root: your modules
   a2app <dir> notes               # a module: its operations and their signatures
   a2app <dir> notes add-note --text "hello"
   agent-app <dir> validate        # again, now measuring the running app's describe budget
   ```

   Invoke every non-destructive operation for real and check the app did what
   the mapping claims; a destructive one is shape-checked (it must answer
   `approval_required`), never fired. A mapping that does not work must not
   ship — fix it or remove the operation.

## `sidecar.json`

| Key | Required | Meaning |
|---|---|---|
| `upstream.command` | yes | argv that starts the app; `{port}` and `{dataDir}` are filled in. Never a shell string. |
| `upstream.cwd` | no (`"upstream"`) | the app's working directory, inside this app. |
| `upstream.port` | yes | `"auto"` (a free port each boot, handed over as `{port}`), or the fixed port the app binds — never this app's own port. |
| `upstream.env` | no | environment variables for the app; values may use `{port}` and `{dataDir}`. |
| `upstream.health` | yes | a path answering below 400 once the app is ready. |
| `upstream.startTimeoutMs` | no (15000) | how long the app has to answer `health`. `serve` waits 20 s for the whole launch. |
| `upstream.timeoutMs` | no (30000) | how long one forwarded operation may take. |
| `operations.<name>.method` | yes | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. |
| `operations.<name>.path` | yes | the app's route; each `{param}` is a declared, required parameter, filled in and escaped. |
| `operations.<name>.send` | no | where the other args go: `query` (default for `GET`) or `body` (JSON; default otherwise). |

The app's environment is the sidecar's own, less `PORT` (the sidecar's port,
not the app's) and every `A2APP_*` variable (the framework's, a credential among
them), plus what `env` declares. Unknown keys are refused, not ignored: a typo
is a setting silently not applied. Do not put a secret in `sidecar.json` — it
ships with the app.

## What an operation does on the wire

- Path parameters fill their segments, URL-escaped. A value that would reach a
  different route — empty, `.` or `..` — is refused `400 invalid_argument`.
- The rest go as a query string (a list as repeated keys) or as a JSON body.
- Only the mapping travels: the caller's credential, cookies and headers never
  reach the app.
- The app's answer comes back as the operation's `result` (JSON when it parses,
  text otherwise), capped at 5 MiB.

| The app… | The caller gets |
|---|---|
| answers below 400 | `200 { ok: true, result }` |
| answers 4xx (not 401/403/407) | that status, `upstream_error`, with `upstreamStatus` and the app's answer as `upstream` |
| answers 5xx, 401, 403 or 407 | `502 upstream_error` (an auth refusal concerns the sidecar's access to the app, not the caller's) |
| does not answer in time | `504 upstream_timeout` |
| is not running | `503 upstream_unavailable` |
| answers more than 5 MiB | `502 upstream_response_too_large` |

## Accounts (`authMode: multi-user`)

Set `"authMode": "multi-user"` in `manifest.json` and reseal. People then sign
in on `/_a2app/account`; the admin credential (`.agent-token`) invites them, and
each approves the agents acting for them (`a2app <dir> login`). Every request is
held to the agent's scopes and to what its person may still do. The adopted app
itself sees one caller — the sidecar — whoever asked: it cannot tell people
apart, so per-person data separation is the app's own business, if it has any.

## Reaching the app from another machine

The sidecar listens on loopback and answers only to its own names. To let
people and agents reach it from elsewhere, serve it with `A2APP_PUBLIC_URL`
(behind a TLS proxy, or through an SSH tunnel to loopback); listening on the
network directly (`A2APP_HOST=0.0.0.0`) needs an `https` public URL, or the
sidecar refuses to start. The adopted app keeps its own loopback port either
way: only the A2App surface is exposed.

## Build, run, gate

`manifest.json`'s pipeline: `install` is `npm install` (the sidecar), `build`
is `npm run build --if-present`, `start` runs the sidecar. If the adopted app
needs its own dependencies installed or a build, add a `build` script to
`package.json` — for example `"build": "npm --prefix upstream ci"` — so it runs
through the same pipeline; it writes into `upstream/node_modules` or the app's
build output, never into its source.

```bash
agent-app <dir> validate   # framework files → build → sidecar.json valid, operations resolve → canon → describe budget
agent-app <dir> serve      # launch as a managed background process; prints the URL
agent-app <dir> stop       # stops the sidecar and, with it, the app
```

The toolkit's gate step, **"sidecar.json valid; operations resolve"**, runs
`a2app-sidecar --check`: every declared operation must map onto a route, every
mapping must name a declared operation, and the upstream must be declared in
full. The sidecar runs the same check at boot and refuses to start on a
problem. `lifecycle.dataDir` is `data/`: the sidecar's state (accounts,
credentials, idempotency keys, audit) and the app's `{dataDir}` live there.
Adopted apps change live (no `promote`): edit the declarations, stop, serve.

## Footguns

- **Two files, one truth.** An operation lives in `operations.json` (what it
  is) and `sidecar.json` (where it goes). The gate fails one without the other.
- **A shell string is not an argv.** `"command": "npm start"` is refused; and
  `["npm", "start"]` fails on Windows — run the target with `node`.
- **`port: "auto"` needs a `{port}`.** If nothing hands the port over, the app
  binds whatever it likes and the sidecar waits for a health check that never
  answers.
- **The adopted app's data is not the framework's** unless you put it in
  `{dataDir}`. Data elsewhere is shared by the dev instance and the live app,
  and is not in backups.
- **Its UI is not reachable through this app's port.** Only the protocol and
  the account page are; the boot log line `upstream` names where the app
  itself answers.
