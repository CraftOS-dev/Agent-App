# Harness Integrations

Per-harness **plugins**: each registers agent tools that build and operate Agent Apps by shelling the framework CLIs (`agent-app` for build/evolve, `a2app` for operate), in the harness's own plugin API. The shared logic lives once in [integration-starter/](integration-starter/) (the engine); each plugin is a thin binding to a real harness API. Harnesses with no plugin use the universal [../skills/](../skills/) route (the app opens in the browser, no code needed).

| Directory | Harness | Language / API | What it registers |
|---|---|---|---|
| [integration-starter/](integration-starter/) | — (shared engine + template) | TypeScript | The 12 build+operate tools, skills, display, and `runA2App`; every plugin below uses it |
| [openclaw/](openclaw/) | [OpenClaw](https://docs.openclaw.ai) | TypeScript, `definePluginEntry` (peer deps `openclaw`, `typebox`) | 11 tools + `agent-app` CLI + a Control-UI tab; ships `openclaw.plugin.json` |
| [hermes/](hermes/) | [Hermes](https://github.com/NousResearch/hermes-agent) | **Python**, `plugin.yaml` + `register(ctx)` | 11 tools via `ctx.register_tool(...)` |
| [dsh/](dsh/) | deepseek-harness | TypeScript Cordis (peer deps `cordis`, `@deepseek-ai/dsh-tools`) | 11 tools via `ctx.tools.register(defineTool(...))`; a browser iframe renderer |
| [craftbot/](craftbot/) | [CraftBot](https://github.com/CraftOS-dev/CraftBot) | **Python**, `@action` decorator (`agent_core`) | 11 actions in the `agent_app` action set |
| [claude-code/](claude-code/) | Claude Code | **MCP** (stdio JSON-RPC 2.0) | 12 tools via a real MCP server; register with `claude mcp add` |
| [../.claude-plugin/](../.claude-plugin/) | Claude Code | Plugin marketplace manifest (no code) | The six [../skills/](../skills/), installable with `/plugin`. Skills only — no build step, so it works from a clean checkout; add the MCP server above for the tool surface |

Each plugin builds against its harness's SDK in that harness's toolchain (the TypeScript ones declare it as a peer dependency; the Python ones load inside the harness). None uses a shell — record field values reach the CLI as literal arguments. Two binaries (framework spec 5.1): set `A2APP_CLI` for the `a2app` operate client and `AGENT_APP_CLI` for the `agent-app` build/evolve binary. Each plugin routes a verb to its owner, so a build verb never reaches the operate client.
