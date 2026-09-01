# SDKs

Thin client libraries for speaking A2App, **generated from [`spec/`](../spec/)** — the schema is the single normative artifact; SDKs never hand-maintain wire types (avoiding AG-UI's cross-SDK drift).

| Directory | Language | Status |
|---|---|---|
| [typescript/](typescript/) | TypeScript (`@a2app/sdk`) | first |
| [python/](python/) | Python (`a2app-sdk`) | first additional SDK — native client for Python harnesses (hermes, CraftBot) |

Each SDK ships a thin conformance harness (~100 lines) that runs the language-agnostic suites in [../conformance/](../conformance/).
