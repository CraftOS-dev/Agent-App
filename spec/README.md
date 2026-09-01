# Spec home

This directory holds the **machine-readable normative schemas** and version snapshots for the Agent App Framework and the A2App protocol — the shipped contract two implementations validate against to interoperate.

| Path | Contents |
|---|---|
| `v0_1/schema/` | JSON Schemas (Draft 2020-12) for the framework files (`manifest`, `operations`) and the protocol payloads (`identity`, `describe`, `error`, `violation`, `whoami`, `context`, `event`, `task`). **Authoritative:** an implementation conforms by validating against these. |
| `v0_1/docs/` | Explanatory per-surface notes (non-normative; the root specs are the contract) |
| `proposals/` | Change proposals targeting the next version (e.g. deferred v2 items: spec'd query subset, optional SSE push, MCP binding) |

Rules: released version directories are frozen snapshots — superseded, never edited. Two implementations that both validate against these schemas interoperate.
