# OpenClaw plugin

A real OpenClaw plugin (`definePluginEntry`) that registers agent tools for building and operating Agent Apps, an `openclaw agent-app …` CLI passthrough, and a Control-UI tab for a launched app. Every tool shells the `a2app` CLI through [`@a2app/integration-starter`](../integration-starter/).

- **Entry:** [src/index.ts](src/index.ts) — `definePluginEntry({ id: "a2app", register(api){…} })`; tools via `api.registerTool(() => ({ name, parameters: Type.Object(…), execute }))`, CLI via `api.registerCli`, display via `api.session.controls.registerControlUiDescriptor`.
- **Manifest:** [openclaw.plugin.json](openclaw.plugin.json) — declares the 11 tools, the `agent-app` command, and `skills`.

Built by the OpenClaw plugin toolchain, which provides `openclaw` and `typebox` as **peer dependencies** — it compiles there, not in the framework monorepo. Set `A2APP_CLI` to point at the `a2app` binary (default `a2app`).
