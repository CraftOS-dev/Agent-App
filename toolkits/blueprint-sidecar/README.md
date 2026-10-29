# blueprint-sidecar — adopt a foreign app as-is

For an app that already exists and should keep running exactly as it is: any HTTP app, in any stack, with no framework files and no adapter of its own (packaging spec §7, **adopt**). Its source goes into `upstream/` and is never edited; the sidecar adapter, [`@a2app/reverse-proxy`](../../adapters/reverse-proxy/), starts it, waits until it answers, and serves the A2App surface on the app's port. Each declared operation is forwarded to one of the app's own routes.

```
manifest.json          # identity, authMode, modules; pipeline.start runs the sidecar (system-owned)
sidecar.json           # how the app starts, and which of its routes each operation reaches
operations.json        # the operations agents may run: module, typed params, destructive?
AGENT_APP.md           # what this app is, for the agents that operate it
reference/blueprint.md # how to adopt an app, step by step
a2app-account.html     # the framework's account page (system-owned, same file in every blueprint)
upstream/              # the adopted app's source — yours to place, never to edit
```

Agents get the full 0.2 auth for free, because the sidecar is built on `@a2app/adapter-core`: accounts and sign-in on a multi-user app, delegated credentials, the ceiling, device sign-in with confirmation, task credentials, approval for destructive operations.

The adopted app is **operate-only**: `describe` reports no entities, the walk stops at the module level, and the `data` verbs do not apply. Its own UI stays at its own address; the sidecar serves only the protocol and the account page.

`a2app.toolkit.json` declares one gate step, `a2app-sidecar --check`, which validates `sidecar.json` and fails while any declared operation has no mapping. A fresh scaffold has no app behind it, so `validate` refuses it until an app is placed, mapped and specified.
