# A2App Adapters

The adapter is the app-side implementation of the A2App interface: **app + adapter = agentic app**. It belongs to the app; the agent installs nothing and only speaks the protocol.

**Two faces, three layers**:

| Layer | Content | Portability |
|---|---|---|
| Pure rules | validation logic, violation messages | **shared verbatim by every adapter** — guarantees two backends reject identical payloads identically |
| Backend binding | type mapping, raw-body interception pre-coercion, live schema read, adapter state | rewritten per stack |
| Served surface | the A2App endpoints (identity, describe, records, operations, tasks/events, IAM) on the app's own port | uniform by definition |

**Rules**: derive-don't-declare (schema/types/`schemaVersion` from the live app); drop-in (class-A conformance requires zero app-code changes); adapter-owned state (idempotency, tasks, audit, **grants**) invisible to app code; fail open internally, fail closed on policy; never modifies app-authored code. The `a2app` operate client is a client of the adapter, not part of it. Delivery: on scaffold/install/import/every launch, idempotent, non-fatal, never overwrites app code.

| Directory | Deployment form |
|---|---|
| [rules/](rules/) | The shared pure-rules layer: validation logic and canonical violation messages, reused verbatim by every backend |
| [adapter-starter/](adapter-starter/) | Copy-to-create template for form 1 (in-process plugin) or form 2 (embedded middleware) on a new stack |
| [reverse-proxy/](reverse-proxy/) | Form 3: the sidecar, for a foreign app adopted as-is — a runnable process (`a2app-sidecar`) that starts the app from a declarative `sidecar.json` and forwards declared operations to its own routes |

**The sidecar (form 3).** For an app that must keep running unchanged — any HTTP app, in any stack, with no adapter of its own (packaging spec §7, *adopt*). Scaffold with [`blueprint-sidecar`](../toolkits/blueprint-sidecar/), put the app's source in `upstream/`, and declare in `sidecar.json` how it starts (an argv, never a shell string; its port, `auto` or fixed; its environment; a health path) and which of its routes each operation in `operations.json` reaches (method, path template, args as query or JSON body). `pipeline.start` runs the sidecar, which starts the app, waits until it answers, serves the A2App surface on the app's port, and stops the app when it stops. It honours the same launch contract as every adapter (`PORT`, `A2APP_DATA_DIR`, `A2APP_HOST`/`A2APP_PUBLIC_URL`, the `.agent-token` admin credential, `authMode`, the account page), and because it is built on `adapter-core` the adopted app gets the whole 0.2 auth surface: accounts on multi-user, delegated credentials, the ceiling, device sign-in with confirmation, task credentials, approval for destructive operations. It is operate-only by design: `describe` reports no entities. `a2app-sidecar --check` is the blueprint's gate step: every declared operation must map onto a route.

Certification = the conformance suite ([../conformance/](../conformance/)), classes A (core) / B (CLI) / C (bidirectional). Reference adapter: the PocketBase hooks adapter in [../toolkits/blueprint-pocketbase-react/](../toolkits/blueprint-pocketbase-react/).
