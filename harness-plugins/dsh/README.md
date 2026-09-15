# deepseek-harness (dsh) bundle

A real dsh Cordis plugin. A dsh bundle is `export function apply(ctx)`, and tools are registered with `ctx.tools.register(defineTool({...}))`. This bundle registers 11 tools that build and operate Agent Apps by shelling the framework CLIs.

- **Host half:** [src/index.ts](src/index.ts) — `apply(ctx)` → `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`.
- **Browser half:** [src/client.ts](src/client.ts) — a `dsh.client` module that renders a launched app in an iframe.

Built by the dsh toolchain, which provides `cordis` and `@deepseek-ai/dsh-tools` as **peer dependencies** — it compiles there, not in the framework monorepo. Set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`).
