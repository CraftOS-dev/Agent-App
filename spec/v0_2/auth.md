# A2App 0.2 — principals, delegated credentials, the user ceiling

Normative for protocol `0.2`. Schemas: `schema/credential`, `issued-credential`, `device-authorization`, `account`, `invite`, plus the 0.2 changes to `identity`, `whoami`, `task`, `describe` and `manifest`.

An agent never holds a person's password or session. A person approves the agent in the app, and the app issues the agent its own credential, bound to that person. Whatever the credential says, it can never do more than the person can do at that moment.

## 1. Principals

A **principal** is who a request acts for.

| `authMode` | Principals |
|---|---|
| `none` | One: `owner`. |
| `multi-user` | The app's accounts (§4), plus `owner`, the app's administrator (the local admin credential, §2.3). |

Every principal has a **role**: `owner` or `member`. `owner` (the principal and every account with role `owner`) sees every record; a `member` sees only records it owns (§5).

`permissionsOf(principal)` is what a principal may do: a scope set (§3). It is `*` unless the app narrows it. A principal that is unknown, or an account that is not `active`, has no permissions: every request acting for it is refused `principal_inactive`.

## 2. Credentials

### 2.1 Shape

A credential is a bearer token plus a grant:

    { credentialId, principal, agentName, scopes, createdAt, expiresAt, lastUsedAt, revokedAt, task }

- **Token:** `a2a_` + 256 random bits, base64url (43 chars). Returned once, by the response that issues it (`issued-credential`). The app stores only `sha256` of the full token string and looks credentials up by that hash.
- **Sent as** `X-A2App-Token: <token>`.
- **`scopes`:** as granted; `*` allowed.
- **`expiresAt`:** issued credentials always expire. Default 30 days; `expiresIn` (seconds) may ask for 60 s to 365 days.
- **`revokedAt`:** revocation keeps the record, so a revoked token is told `credential_revoked` rather than `credential_invalid`. Revoked and expired credentials are pruned 30 days later.
- **`lastUsedAt`:** updated on use, at most once a minute.
- **`task`:** set on a task credential (§6.2).

### 2.2 Ways to get one

All issue the same kind of credential.

| How | Approver / issuer | Principal |
|---|---|---|
| Device code (§7) | the person, on the account page | the approving person |
| `POST /api/_a2app/credentials` | a manager (§2.4), for CI or a harness with no browser | the manager, or anyone if the manager is an owner |
| Task credential (§6.2) | an owner manager: the bridge, with the admin credential | whoever queued the task |

### 2.3 The admin credential

The app's own `.agent-token` file holds the **admin credential**: principal `owner`, scopes `*`, no expiry, `credentialId` `cred_local`. It is seeded at boot from the file, is never listed, and cannot be revoked through the API (delete or rotate the file). Framework tooling on the app's host uses it (minting, invites, the bridge). It is never handed to an agent harness (§6.2).

### 2.4 Managers

A **manager** may list, issue and revoke credentials and approve device codes. A manager is one of:

- a signed-in session (§4);
- on an `authMode: none` app, the app's own View (same-origin);
- the admin credential.

A manager acts for its own principal. A manager with role `owner` acts for anyone. A delegated credential is never a manager: it may only revoke itself (`DELETE /api/_a2app/credentials/{its own id}`).

## 3. Scopes and the ceiling

Scope grammar: `data:{entity}:read`, `data:{entity}:write`, `op:{name}`, `*` (every scope the app declares). Effective scopes on every request:

    effective = expand(grant.scopes) ∩ expand(permissionsOf(principal))

This is evaluated per request, never cached across requests. `whoami.scopes` reports `effective`.

## 4. Accounts and sessions (`multi-user` only)

**Accounts** are adapter state, never records, and never served by the records API.

- **Fields:** `{ id, name, login, role, active, createdAt }` plus a password hash.
- **`login`:** 1–254 chars, trimmed and compared lower-cased.
- **`name`:** 1–100 chars.
- **Password:** 10–256 chars, stored as `pbkdf2_sha256$600000$<salt b64>$<hash b64>` (16-byte salt, 32-byte key) and compared in constant time.

**Invites** create accounts.

- `POST /api/_a2app/invites {role}` (an owner manager) returns a one-time `code` and `url`.
- The `code` is 256 random bits, stored as its sha256, single use, and expires after 7 days.
- `agent-app <app> owner` uses the admin credential to make the first owner's invite.
- The last active owner cannot be deactivated or demoted: `409 last_owner`.

**Sessions.**

- `POST /api/_a2app/session {login, password}` sets the cookie `a2app_session_<appId>`.
- The cookie value is 256 random bits, stored as its sha256.
- Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 14 days, and `Secure` when the app's public URL is https (§9).
- A deactivated account's sessions stop working on the next request.
- **CSRF:** a session-authenticated request that changes anything must carry an `Origin` that is this app's own; otherwise `403 forbidden_origin`.
- **Sign-in failures:** 10 per login per 15 minutes, then `429 rate_limited` with `retryAfterSeconds`.

## 5. Record ownership

An entity may declare `ownedBy: "<field>"`, a string field the adapter manages: `describe` marks it `readOnly` and publishes `ownedBy` on the entity level. On a `multi-user` app:

- create sets the field to the caller's principal;
- a `member` lists, reads, updates and deletes only records it owns. Anyone else's record answers `404 record_not_found`, so existence is not leaked;
- an `owner` sees and changes every record.

On `authMode: none` the field is set to `owner` and nothing is filtered. Operation runners receive the caller as `ctx = { credentialId, agentName, principal, role }` and apply the same rule to records they touch.

## 6. Tasks

### 6.1 Who queued it

A trigger fired by an operation records the operation's principal as `task.request.principal`. Work the app queues on its own records `null`, and runs as `owner`.

### 6.2 Task credentials

`POST /api/_a2app/tasks/{id}/credential {agentName?}` (owner manager; the bridge uses the admin credential) issues a credential with:

- **principal:** `task.request.principal` (or `owner`);
- **scopes:** what the app declares the capability needs (`capabilities: { <name>: { scopes } }`, else `*`), always limited by §3;
- **`task`:** the task id;
- **`expiresAt`:** at most 1 hour.

The credential is refused `credential_revoked` once the task is `completed`, `failed` or `canceled`, and none is issued for such a task (`409 task_not_claimable`) or for a principal no longer active (`401 principal_inactive`). The bridge runs every harness with such a credential, never with the admin credential: as `A2APP_TOKEN` for a process it starts, and as `credential.token` in the body it posts to an HTTP route.

## 7. Device-code sign-in (RFC 8628 shape)

| Step | Call |
|---|---|
| Agent asks | `POST /api/_a2app/auth/device {agentName?, scopes?, expiresIn?}` → `device-authorization` |
| Person reviews | `GET /api/_a2app/auth/device/{userCode}` (manager) → `{ userCode, agentName, scopes, expiresIn, expiresAt }` |
| Person decides | `POST /api/_a2app/auth/device/{userCode} {approve, scopes?}` (manager; `scopes` may only narrow) |
| Agent polls | `POST /api/_a2app/auth/token {deviceCode}` → `issued-credential` |

Codes:

- `userCode`: 8 letters from `BCDFGHJKLMNPQRSTVWXZ`, shown as `XXXX-XXXX`, matched case-insensitively with the dash ignored.
- `deviceCode`: 256 random bits, stored as its sha256.
- Both expire after 600 s and are single use.

Polling `auth/token` answers `400`, `ok: false`, with one of:

- `authorization_pending`: keep polling at `interval`;
- `slow_down`: polled sooner than `interval`. Add 5 s to the interval;
- `access_denied`: the person refused;
- `expired_token`: start again.

The issued credential acts for the approving manager's principal, with the approved scopes.

`verificationUri` is the account page's approve screen on the app's public origin. `verificationUriComplete` adds the code.

## 8. Endpoints

| Route | Who | Answer |
|---|---|---|
| `GET /api/_a2app/session` | session | `account` · `401 sign_in_required` |
| `POST /api/_a2app/session {login, password}` | anyone | `account` + cookie · `401 sign_in_failed` |
| `DELETE /api/_a2app/session` | session | ends it |
| `POST /api/_a2app/invites {role}` | owner manager | `invite` with `code`, `url` |
| `GET /api/_a2app/invites/{code}` | anyone | `invite` (no code) · `404 invite_invalid` |
| `POST /api/_a2app/invites/{code} {name, login, password}` | anyone | `account` + cookie · `409 login_taken` |
| `GET /api/_a2app/users` | owner manager | `{ users: account[] }` |
| `PATCH /api/_a2app/users/{id} {active?, role?}` | owner manager | `account` · `409 last_owner` |
| `GET /api/_a2app/credentials` | manager | `{ credentials: credential[] }` (own; owner: all) |
| `POST /api/_a2app/credentials {agentName, scopes, expiresIn?, principal?}` | manager | `issued-credential` |
| `DELETE /api/_a2app/credentials/{id}` | manager, or that credential | `{ revoked }` |
| `POST /api/_a2app/auth/device` · `GET/POST /api/_a2app/auth/device/{userCode}` · `POST /api/_a2app/auth/token` | §7 | §7 |
| `POST /api/_a2app/tasks/{id}/credential` | owner manager | `issued-credential` |

The session, invite and user routes exist only on `multi-user` apps; elsewhere they answer `404 not_multi_user`.

## 9. Request authentication, in order

1. **Host:** loopback names, the hosts of the app's own origins, and the public URL's host (§10); otherwise `403 forbidden_host`.
2. **Origin:** present and not the app's own → `403 forbidden_origin`.
3. **`X-A2App-Token`:**
   - unknown → `401 credential_invalid`;
   - revoked, or a task credential whose task is terminal → `401 credential_revoked`;
   - past `expiresAt` → `401 token_expired`;
   - principal without permissions → `401 principal_inactive`.
4. **Session cookie** (`multi-user`), or the app's own View on `authMode: none` (same-origin) as `owner`.
5. **Nothing:**
   - on `authMode: none`, reads and read-only operations proceed as `owner`;
   - otherwise `401 agent_token_required`, or `sign_in_required` when the request came from the app's own View (it carries `signInUrl`).
6. **Scope:** missing from `effective` → `403 insufficient_scope`.

## 10. Reaching an app from elsewhere

`A2APP_PUBLIC_URL` (e.g. `https://crm.example.com`) names the URL people and agents use.

- **Allowed:** its origin is allowed and its host answered (§9).
- **Binding:** the app binds `A2APP_HOST` (default `127.0.0.1`).
- **Refusal:** binding anything other than a loopback address without an `https` public URL is refused at start. A bearer token must not cross a network in clear.
- **Tunnels:** an SSH tunnel to a loopback address needs neither.

## 11. Clients (framework, non-normative)

**Credential lookup**, the same for a local directory and a URL:

1. `A2APP_TOKEN`;
2. `credentials.json` in the framework home, keyed by origin and app id;
3. for a local app only, its `.agent-token`.

**Commands:**

| Command | Does |
|---|---|
| `a2app <app> login [--scopes …] [--expires 30d] [--name …]` | runs §7 and stores the credential in `credentials.json` (0600); the token is never printed |
| `a2app <app> logout` | revokes and forgets it |
| `agent-app <app> credential list` · `mint --for <principal> --scopes … --expires …` · `revoke <id>` | manages credentials with the admin credential; `mint` prints the token once |
| `agent-app <app> owner` · `agent-app <app> invite [--role member]` | prints a setup link |

**Removed in 0.2:** `.principal`, `A2APP_AUTH_TOKEN` and the `authToken` client option. A client sends only the agent's own credential.

## 12. Errors added in 0.2

| Code | Status |
|---|---|
| `credential_invalid` | 401 |
| `credential_revoked` | 401 |
| `token_expired` | 401 |
| `principal_inactive` | 401 |
| `sign_in_required` | 401 |
| `sign_in_failed` | 401 |
| `authorization_pending` | 400 |
| `slow_down` | 400 |
| `access_denied` | 400 |
| `expired_token` | 400 |
| `device_code_invalid` | 404 |
| `invite_invalid` | 404 |
| `not_multi_user` | 404 |
| `login_taken` | 409 |
| `last_owner` | 409 |
| `not_a_manager` | 403 |
