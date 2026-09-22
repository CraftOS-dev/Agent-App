# Toolkits: blueprints & kits — NOT part of the framework

An agent can start from a blueprint or kit, but **none is required for compliance** — every tier produces the same artifact (app + adapter + framework files). This catalog grows without touching the protocol. A toolkit that vendors files registers them as system-owned in the ownership canon and provides its sync command; it defines its own stack-specific gate steps on top of the framework minimum.

| Toolkit | Tier | What `agent-app <dir> scaffold --blueprint` produces |
|---|---|---|
| [blueprint-base/](blueprint-base/) | Tier 1 — fully stack-agnostic | framework-file templates, conventions, conformance checklist; no runtime code — the agent picks the stack |
| [blueprint-react-node/](blueprint-react-node/) | Tier 2 — React + Hono + SQLite | React (Vite) View + Hono server + SQLite store; embedded `@a2app/adapter-core` middleware |
| [blueprint-python-fastapi/](blueprint-python-fastapi/) | Tier 2 — FastAPI + SQLite | FastAPI + a SQLite store (stdlib `sqlite3`) + an in-process adapter (served surface + rules ported to Python) |
| [blueprint-pocketbase-react/](blueprint-pocketbase-react/) | Tier 2 — PocketBase + React | PocketBase records + a React (Vite) View + the A2App adapter as in-process JS hooks |
| [kit/](kit/) | The reference kit | browser client glue + design tokens, vendored by tier-2 blueprints and hash-registered in the canon |

All four blueprints pass `scaffold → validate` in the [conformance](../conformance/) Toolkit class.
