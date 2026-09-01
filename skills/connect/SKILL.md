---
name: connect
activity: connect
description: Connect to a published Agent App you do not own — discover it, acquire an owner-issued scoped credential, then operate it exactly as any local app. Load when operating a remote/shared app. Reserved until deployed mode ships.
---

# Connect

Everything after access is ordinary operation: the A2App surface is identical
whether the app is local or remote. What differs is getting in, and the fact that
you can **operate but never modify** a connected app — an Agent App is only
modifiable on its host.

> **Status: reserved.** Full connect requires deployed mode (TLS, real origins,
> grant-based access), which is not yet built. The scope grammar and grant model
> below are fixed now so connecting later breaks no wire format. Today a remote
> app is reachable by LAN URL or tunnel and gated by its own account auth.

## Procedure

1. **Discover.** `GET {base}/.well-known/a2app.json` (or `/api/_a2app`). Confirm the
   `a2app: true` marker and that you recognize the `protocol` major version — if you
   do not, do not write. Confirm `app.id` is the app you intend.
2. **Acquire access — never self-provision.** A first write with no credential
   returns a `401` challenge telling you *how* access is obtained; obtaining it is
   the **owner's** act (the owner hands you a credential, or mints one with chosen
   scopes). Auto-assignment at first contact is ambient access and is prohibited.
3. **Learn your boundaries.** `GET /api/_a2app/whoami` returns your credential id,
   principal, and scope list. Plan within them: your effective permission is your
   granted scopes intersected with the principal's own — you can never exceed the
   user you act for.
4. **Operate** exactly per the **operator** skill. Every call carries your agent
   credential; on a multi-user app an operation also carries the acting user's own
   auth token.

## Constraints

- **No modification over connect** — you may not change a connected app's code.
- **Revocation is the owner's** — your credential is individually revocable,
  effective the next request; do not assume continued access.
- **Untrusted content still applies**, more so than locally.
