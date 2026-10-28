# Spec home

This directory holds the **machine-readable normative schemas** and version snapshots for the Agent App Framework and the A2App protocol — the shipped contract two implementations validate against to interoperate.

| Path | Contents |
|---|---|
| `v0_2/schema/` | **Current.** JSON Schemas (Draft 2020-12) for protocol `0.2`: everything in 0.1, plus `credential`, `issued-credential`, `device-authorization`, `account` and `invite`, and the 0.2 changes to `identity`, `whoami`, `task`, `describe` and `manifest`. **Authoritative:** an implementation conforms by validating against these. |
| `v0_2/auth.md` | **Normative** for 0.2: principals, delegated agent credentials, the user ceiling, accounts, record ownership, task credentials, device-code sign-in, and reaching an app from elsewhere. |
| `v0_1/schema/` | Protocol `0.1`, frozen. |
| `v0_1/docs/` | Explanatory per-surface notes (non-normative; the root specs are the contract) |
| `proposals/` | Change proposals targeting the next version (e.g. deferred v2 items: spec'd query subset, optional SSE push, MCP binding) |

Rules: released version directories are frozen snapshots — superseded, never edited. Two implementations that both validate against these schemas interoperate.

## Auth in 0.2

An agent never holds a person's password or session.

- **Getting a credential.** The person approves the agent in the app: a device code, approved on the app's account page at `/_a2app/account`. The app issues the agent its own credential, a token shown once and stored as a hash.
- **What it's bound to.** The credential is bound to that person (its *principal*), carries scopes, and always expires.
- **The ceiling.** Every request is checked against `credential scopes ∩ what the principal may do now`. A credential can never do more than its person, and loses access the moment the person does.
- **Accounts.** On a `multi-user` app the adapter holds accounts and sessions, and a member sees only the records it owns. On `authMode: none` there is one principal, `owner`.
- **The bridge.** It runs each queued task with a credential bound to whoever queued it, which dies when the task ends.

The details, endpoints and error codes are in [`v0_2/auth.md`](v0_2/auth.md).
