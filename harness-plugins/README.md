# Harness Plugins

Per-harness **plugins**: each registers agent tools that build and operate Agent Apps by shelling the framework CLIs (`agent-app` for build/evolve, `a2app` for operate), in the harness's own plugin API. The shared logic lives once in [integration-starter/](integration-starter/) (the engine); each plugin is a thin binding to a real harness API. Harnesses with no plugin use the universal [../skills/](../skills/) route: the skills tell the agent to run `agent-app <dir> open`, and the CLI opens the app itself (harness-declared opener, else the OS browser, always printing the URL) — so a launched app reaches the user with no plugin code at all.

| Directory | Harness | Language / API | What it registers |
|---|---|---|---|
| [integration-starter/](integration-starter/) | — (shared engine + template) | TypeScript | The 14 build+operate tools, skills, display, and `runA2App`; every plugin below uses it |
| [openclaw/](openclaw/) | [OpenClaw](https://docs.openclaw.ai) | TypeScript, `definePluginEntry` (peer deps `openclaw`, `typebox`) | 11 tools + `agent-app` CLI + a Control-UI tab; ships `openclaw.plugin.json` |
| [hermes/](hermes/) | [Hermes](https://github.com/NousResearch/hermes-agent) | **Python**, `plugin.yaml` + `register(ctx)` | 11 tools via `ctx.register_tool(...)` |
| [dsh/](dsh/) | deepseek-harness | TypeScript Cordis (peer deps `cordis`, `@deepseek-ai/dsh-tools`) | 11 tools via `ctx.tools.register(defineTool(...))`; a browser iframe renderer |
| [craftbot/](craftbot/) | [CraftBot](https://github.com/CraftOS-dev/CraftBot) | **Python**, `@action` decorator (`agent_core`) | 11 actions in the `agent_app` action set |
| [claude-code/](claude-code/) | Claude Code | **MCP** (stdio JSON-RPC 2.0) | 14 tools via a real MCP server; register with `claude mcp add` |
| [../.claude-plugin/](../.claude-plugin/) | Claude Code | Plugin marketplace manifest (no code) | The six [../skills/](../skills/), installable with `/plugin`. Skills only — no build step, so it works from a clean checkout; add the MCP server above for the tool surface |

Each plugin builds against its harness's SDK in that harness's toolchain (the TypeScript ones declare it as a peer dependency; the Python ones load inside the harness). None uses a shell — record field values reach the CLI as literal arguments. Two binaries (framework spec 5.1): set `A2APP_CLI` for the `a2app` operate client and `AGENT_APP_CLI` for the `agent-app` build/evolve binary. Each plugin routes a verb to its owner, so a build verb never reaches the operate client.

## Showing a launched app

`agent-app <dir> serve` returns the app's URL; getting a human in front of it is a
harness capability, not a lifecycle step, so it is resolved in a fixed order:

1. **The agent's own browser tool** — a harness that gave the model one (a built-in
   browser pane, a Chrome extension). Unreachable from a child process, so the
   agent passes `open --print-only` and opens the URL with its own tool.
2. **The harness plugin** — a plugin implementing `registerDisplay` embeds the app
   in its own UI. `registerA2AppPlugin` detects this and suppresses the CLI opener,
   so the user gets an embedded view rather than a stray browser window.
3. **`AGENT_APP_OPEN_CMD`** — whitespace-separated argv the CLI runs with the URL
   appended (`code --open-url`, `wslview`, a script). Never shell-parsed.
4. **The OS browser** — `start` / `open` / `xdg-open`, suppressed when `CI` or
   `SSH_CONNECTION` is set or Linux has no display (WSL excepted, it has an opener).
5. **The printed URL** — always, on every path above. This is the real floor: every
   harness renders a loopback URL as clickable text.

Only 3–5 are the CLI's; 1 and 2 belong to the caller. `"opened": false` is not an
error — the app is running and the URL is valid, which is what the caller asked.
