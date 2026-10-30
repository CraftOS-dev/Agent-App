# Changelog

## Unreleased

### Fixed

- **Any signed-in person reached every task.** The task API checked only that
  the caller was signed in, so a member listed everyone's tasks — the payload,
  and the result an agent wrote for someone else — and could claim, report on
  or cancel them. A task is now reached like a record (spec/v0_2/auth.md §6.3):
  an owner reaches every task, a task credential its own, anyone else the tasks
  they asked for. Anything else answers `404 task_not_found`, and progress or
  completion from a caller that does not hold the claim answers
  `403 task_not_held`. In every adapter.
- **A finished request could never be asked again.** A repeated request joined
  the earlier task even after it was completed, failed or canceled, so asking
  again handed back the finished task. It now joins only an open task (§6.1).

### Upgrading an existing app

`agent-app <dir> adapter-sync` (run at every launch) brings the fixed adapter;
pocketbase-react apps take it with `agent-app <dir> toolkit-sync`. A View that
follows a task with the person's own session keeps working, since a person
reaches the tasks they asked for.

## 0.2.0 — protocol 0.2

`agent-app-framework`, `@a2app/rules`, `@a2app/sdk`, `@a2app/adapter-core` and
`@a2app/reverse-proxy` are released together at 0.2.0; the react-node and
sidecar blueprints depend on `^0.2.0`.

Agents get their own credentials, approved by the person they act for, and can
never do more than that person can. The normative text is
[spec/v0_2/auth.md](spec/v0_2/auth.md).

### Added

- **Accounts on multi-user apps**, in every starter (react-node, go-react,
  python-fastapi, rust-react, rails-vue, pocketbase-react): owner setup, sign-in,
  one-time invite links, and members. The account page lives at
  `/_a2app/account`. Records can be owned by their creator (`ownedBy`).
  `agent-app <dir> scaffold --auth-mode multi-user` makes one.
- **Delegated credentials**: an agent credential acts for one person, is stored
  only as a hash, expires, and can be revoked. People manage them under
  *Connected agents*, or with `agent-app <app> credential list | mint | revoke`.
- **The user ceiling**: on every request, a credential's effective scopes are
  its own scopes intersected with what its person may do now. Demoting or
  deactivating the person narrows or stops all of their agents at once.
- **`a2app <app> login` / `logout`**: device-code sign-in (RFC 8628). The person
  approves the request in their browser, and the CLI stores the credential
  without printing it. Approving produces a one-time confirmation code, and only
  the agent presenting it gets the credential, so approving a link someone else
  sent you gives them nothing. On the person's own computer the code comes back
  to the CLI by itself (a loopback redirect, RFC 8252); an agent elsewhere
  finishes with `login --confirm <code>`. The approve screen says when the
  request was made and where the agent is.
- **Reaching an app from another machine**: `A2APP_HOST` and `A2APP_PUBLIC_URL`,
  plus a Host check in every adapter. An app refuses to listen beyond loopback
  without an https public URL.
- **Task credentials**: a task records who queued it. The bridge runs each
  task's agent with a credential for that person, holding only what the
  capability declares (`capabilities: { <name>: { scopes } }`) and dead when the
  task ends — never with the app's admin credential.
- **`validate` checks who a multi-user app answers**: sign-in must be on, and no
  entity may be readable without it (a public PocketBase rule fails the gate).
- `conformance/multi-user/run.mjs` (65 checks) and `conformance/starter/run.mjs`
  (32 checks): black-box suites a running starter must pass. Every starter
  passes the multi-user suite. The starter suite is passed by react-node, go-react,
  python-fastapi, rust-react and rails-vue. pocketbase-react, which serves records
  through PocketBase itself, passes 20 of the 32.
- **The native adapters match the reference** (go-react, python-fastapi,
  rust-react, rails-vue):
  - operation arguments are guarded;
  - idempotency covers operations and updates;
  - runners can refuse with typed errors;
  - approval keys use the reference's format;
  - the record guard follows the current rules;
  - tasks, events, approvals, idempotency keys and the audit log persist across
    a restart;
  - every app has viewers, `dataVersion`, `targetParam` and describe budgets,
    and a Host check on every path.
- **Installing apps** ([spec/v0_2/packaging.md](spec/v0_2/packaging.md)). Every
  source goes through one pipeline, so every harness gets the same result: the
  app is acquired into staging, inspected, sanitized, re-vendored from a local
  toolkit, placed, registered, gated and served.
  - `agent-app catalogue`: browse a marketplace (default
    `CraftOS-dev/agent-app-collection`, falling back to
    `living-ui-marketplace`).
  - `agent-app install <id>`: install a marketplace app, delivered as CraftBot
    delivers it. No walk-verify is owed.
  - `agent-app install --from <zip|folder|github:…|git+…>`: install from any
    other source. These are untrusted, so a walk-verify is owed.
  - `agent-app inspect`: what a source is and what installing it would run.
  - `agent-app <dir> export`: package an app.
  - `agent-app <dir> import`: the same pipeline, in place.
- **Adopting a foreign app as-is**: `blueprint-sidecar` runs any HTTP app
  unchanged behind the sidecar adapter (`@a2app/reverse-proxy`, now runnable as
  `a2app-sidecar`), with the full 0.2 auth in front of it.
- **pocketbase-react runs PocketBase 0.39.7.** `pipeline.install` fetches the
  pinned release itself and verifies it against checksums embedded in the
  launcher.
- A local app is now addressed the same way as a remote one: `A2APP_TOKEN`, then
  the stored credential for the live app, then the app's own `.agent-token`.
- `agent-app blueprints` lists what an app can be scaffolded on.
- `agent-app <dir> dev --install` runs the pipeline's install first, which a
  fresh scaffold needs.
- `a2app <app> tasks complete <id> --summary "…"` closes a task with a summary,
  no JSON to quote.
- `a2app <app> data <entity> create|update` also takes fields as `field=value`.
- The harness tools' `agent_app_build` takes `authMode`, so a multi-user app can
  be scaffolded through them.

### Removed

The 0.1 ways of naming a user. The agent's own credential now says who it acts
for, and nothing else is sent.

- **`.principal`**: password sign-in from a file in the app directory. It is no
  longer read; delete the file (it holds a password) and run `a2app <app> login`.
- **`A2APP_AUTH_TOKEN`** and `authToken` in `credentials.json`: the second, user
  token sent as `Authorization`.
- **SDK `authToken` / `auth_token`** client option. Passing it is now an error.

### Changed

- Credentials in an adapter's store are kept as SHA-256 hashes. Plaintext grants
  written by 0.1 are not loaded, so mint those credentials again.
- Clients accept protocol `0.1` and `0.2`.
- `agent-app <app> bridge` always uses the app's admin credential, and gives the
  harness the task's credential: `A2APP_TOKEN` for a headless run,
  `credential.token` in the body posted to an inbound or gateway route. Its log
  names who each run acts as.
- `scaffold` needs `--blueprint`; without one it lists the choices instead of
  writing a stack-free skeleton (`blueprint-base` is that).
- The Claude Code MCP server no longer writes a `claude` profile into
  `harnesses.json`; the bridge uses the framework's built-in one. A profile an
  earlier version wrote replaces the built-in until it is deleted.
- `remove` keeps the app's own backups as well as its data, under
  `removed/<name>-<id>/` in the framework home.

### Fixed

- **`agent-app <dir> import` trusted the folder it imported.** It kept the
  shipped data (accounts, sessions, credential hashes) and took system code from
  a toolkit the folder named. It also left partial files behind on failure. It
  now runs the install pipeline in place. Note that it now removes `.git/` and
  needs a toolkit installed on this machine.
- The CLI's describe cache is kept per credential, under a hash of it, so a walk
  never shows one agent another's reach.
- **The bridge killed runs that had finished.** A heartbeat the app refused was
  read as a lost claim, including the refusal a task gets once its own run has
  completed it, so a run still exiting was killed and logged `claim_lost`. A
  refusal is now read: a task its run completed or failed is left to exit.
- **An app installed from npm got none of its blueprint's `.gitignore`** (npm
  never packs one), so its export shipped the PocketBase binary. The bundled
  blueprints carry it as `_gitignore`, written back on scaffold.
- **`pb-serve.mjs --fetch` trusted any binary that reported the pinned
  version**, running it to ask. A binary is now kept only when its SHA-256 is the
  pinned release's, and anything else is replaced.
- PocketBase's describe root named the app after PocketBase's own setting
  ("Acme" on a fresh database) instead of the manifest.
- A remote agent with no credential was told to read the app's `.agent-token`;
  it is now pointed at `a2app <url> login`.
- `--scopes a,b` from PowerShell arrived as one scope `"a b"`; scopes are now
  separated by commas or spaces.

- **A task's credential could come back to life.** Task ids came from a
  counter that restarted at boot while credentials persisted, so after a restart
  a new task could revive an old task's credential (go-react, python-fastapi,
  rails-vue). Tasks now have random ids and are persisted.
- **rails-vue logged request bodies**, including passwords and device codes. It
  no longer does, and secret-looking values are filtered.
- **adapter-core wrote a raw token into its audit log** when it rate-limited a
  caller. It now records the token's hash.
- A record update whose body is not a JSON object no longer fails with a 500.
- The native adapters no longer lose writes behind a 200, crash, or store wrong
  numbers on unusual input (go-react: NaN and ignored SQLite errors; rust-react:
  a runner panic stopping the process; python-fastapi and rails-vue: framework
  500s, `to_i` numbers).

### Upgrading an existing app

`agent-app <dir> adapter-sync` (run at every launch) brings the new adapter. The
app's own files keep working: the new schema hooks (`capabilities`,
`permissionsOf`, `ownedBy`) are optional on every stack. Two stacks need one step
of their own:

- **rust-react**: `Cargo.toml` is the app's, so add the adapter's dependencies:
  `url = "2"`, `getrandom = "0.2"`,
  `pbkdf2 = { version = "0.12", default-features = false, features = ["hmac"] }`,
  `subtle = "2"` and `base64 = "0.22"`.
- **go-react**: `ENTITIES` in `schema.go` can now be an ordered list (`[]M` with
  `"name"`), which `describe` follows. A map still compiles, listed by name.
- **pocketbase-react**: run `agent-app <dir> toolkit-sync`. The next install
  fetches PocketBase 0.39.7, and data created on 0.26 opens unchanged. An app's
  create rule must not depend on the owner field, because PocketBase 0.27+
  checks rules before the guard fills it.
- **pocketbase-react, multi-user only**: copy
  `pb/pb_migrations/1759622300_a2app_accounts.js` from the toolkit, and give
  each collection rules on `@request.auth.id` (see the starter's `tasks`
  migration). Accounts then come from the adapter's invites, and PocketBase's
  own sign-in for `users` is turned off.
