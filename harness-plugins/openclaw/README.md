# OpenClaw plugin

A real OpenClaw plugin (`definePluginEntry`) that registers agent tools for building and operating Agent Apps, an `openclaw agent-app …` CLI passthrough, an **"Agent Apps" Control-UI tab** (the framework's front door: a form to build / evolve / operate), and a Control-UI tab for a launched app. Every tool shells a framework CLI through [`@a2app/integration-starter`](../integration-starter/).

- **Entry:** [src/index.ts](src/index.ts) — `definePluginEntry({ id: "a2app", register(api){…} })`; tools via `api.registerTool(() => ({ name, parameters: Type.Object(…), execute }))`, CLI via `api.registerCli`, display via `api.session.controls.registerControlUiDescriptor`.
- **Entry form:** the plugin serves it over `api.registerHttpRoute({ path, auth: "gateway", match, handler })` and points a Control-UI tab at that route (rendered in a sandboxed frame — no Custom-plugin-UI lab flag needed). The form HTML and the submit→kickoff-prompt logic live in the shared engine (`agentAppFormHtml`, `handleFormAction`); a submission routes the agent to the matching skill (creator/modify/operator) with the user's context. The exact session-send call and any manifest declaration of the route/tab must be confirmed against the target OpenClaw SDK version.
- **Manifest:** [openclaw.plugin.json](openclaw.plugin.json) — declares the 11 tools, the `agent-app` command, and `skills`.

Built by the OpenClaw plugin toolchain, which provides `openclaw` and `typebox` as **peer dependencies** — it compiles there, not in the framework monorepo. Set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`).
