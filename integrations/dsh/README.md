# deepseek-harness (dsh) bundle

A real dsh Cordis plugin. A dsh bundle is `export function apply(ctx)`, and tools are registered with `ctx.tools.register(defineTool({...}))`. This bundle registers 11 tools that build and operate Agent Apps by shelling the `a2app` CLI.

- **Host half:** [src/index.ts](src/index.ts) — `apply(ctx)` → `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`.
- **Browser half:** [src/client.ts](src/client.ts) — a `dsh.client` module that renders a launched app in an iframe.

Built by the dsh toolchain, which provides `cordis` and `@deepseek-ai/dsh-tools` as **peer dependencies** — it compiles there, not in the framework monorepo. Set `A2APP_CLI` to point at the `a2app` binary (default `a2app`).
