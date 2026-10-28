# Changelog

## Unreleased — protocol 0.2

Agents get their own credentials, approved by the person they act for, and can
never do more than that person can. The normative text is
[spec/v0_2/auth.md](spec/v0_2/auth.md).

### Added

- **Accounts on multi-user apps**: owner setup, sign-in, one-time invite links,
  and members. The account page lives at `/_a2app/account`. Records can be owned
  by their creator (`ownedBy`).
- **Delegated credentials**: an agent credential acts for one person, is stored
  only as a hash, expires, and can be revoked. People manage them under
  *Connected agents*, or with `a2app <app> credential list | mint | revoke`.
- **The user ceiling**: on every request, a credential's effective scopes are
  its own scopes intersected with what its person may do now. Demoting or
  deactivating the person narrows or stops all of their agents at once.
- **`a2app <app> login` / `logout`**: device-code sign-in (RFC 8628). The person
  approves the request in their browser, and the CLI stores the credential
  without printing it.
- **Reaching an app from another machine**: `A2APP_HOST` and `A2APP_PUBLIC_URL`,
  plus a Host check in every adapter. An app refuses to listen beyond loopback
  without an https public URL.
- A local app is now addressed the same way as a remote one: `A2APP_TOKEN`, then
  the stored credential for the live app, then the app's own `.agent-token`.

### Removed

These are ignored, with a warning, for this release, and will be deleted in the
next one.

- **`.principal`**: password sign-in from a file in the app directory. Delete the
  file and run `a2app <app> login`.
- **`A2APP_AUTH_TOKEN`** and `authToken` in `credentials.json`: the second, user
  token sent as `Authorization`. The agent's own credential now says who it acts
  for.
- **SDK `authToken` / `auth_token`** client option, for the same reason.

### Changed

- Credentials in an adapter's store are kept as SHA-256 hashes. Plaintext grants
  written by 0.1 are not loaded, so mint those credentials again.
- Clients accept protocol `0.1` and `0.2`.
