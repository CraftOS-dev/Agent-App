# Changelog

## Unreleased — protocol 0.2

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
  without printing it.
- **Reaching an app from another machine**: `A2APP_HOST` and `A2APP_PUBLIC_URL`,
  plus a Host check in every adapter. An app refuses to listen beyond loopback
  without an https public URL.
- **Task credentials**: a task records who queued it. The bridge runs each
  task's agent with a credential for that person, holding only what the
  capability declares (`capabilities: { <name>: { scopes } }`) and dead when the
  task ends — never with the app's admin credential.
- **`validate` checks who a multi-user app answers**: sign-in must be on, and no
  entity may be readable without it (a public PocketBase rule fails the gate).
- `conformance/multi-user/run.mjs`: a black-box suite every starter passes when
  served as `multi-user`.
- A local app is now addressed the same way as a remote one: `A2APP_TOKEN`, then
  the stored credential for the live app, then the app's own `.agent-token`.

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
  `credential.token` in the body posted to an inbound or gateway route.

### Upgrading an existing app

`agent-app <dir> adapter-sync` (run at every launch) brings the new adapter. The
app's own files keep working: the new schema hooks (`capabilities`,
`permissionsOf`, `ownedBy`) are optional on every stack. Two stacks need one step
of their own:

- **rust-react**: `Cargo.toml` is the app's, so add the adapter's dependencies:
  `url = "2"`, `getrandom = "0.2"`,
  `pbkdf2 = { version = "0.12", default-features = false, features = ["hmac"] }`,
  `subtle = "2"` and `base64 = "0.22"`.
- **pocketbase-react, multi-user only**: copy
  `pb/pb_migrations/1759622300_a2app_accounts.js` from the toolkit, and give
  each collection rules on `@request.auth.id` (see the starter's `tasks`
  migration). Accounts then come from the adapter's invites, and PocketBase's
  own sign-in for `users` is turned off.
