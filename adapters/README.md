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
| [reverse-proxy/](reverse-proxy/) | Form 3: sidecar runtime reading a declarative mapping — **a reserved deployment form**; kept as the wrap-in-place path for foreign codebases |

Certification = the conformance suite ([../conformance/](../conformance/)), classes A (core) / B (CLI) / C (bidirectional). Reference adapter: the PocketBase hooks adapter in [../toolkits/blueprint-pocketbase-react/](../toolkits/blueprint-pocketbase-react/).
