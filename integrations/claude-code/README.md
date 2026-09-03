# Claude Code plugin (MCP server)

Claude Code consumes tools over the **Model Context Protocol**. This package is a real MCP server (stdio, newline-delimited JSON-RPC 2.0) that exposes the framework engine's build + operate tools, so an agent in Claude Code can build, evolve, and operate Agent Apps.

- **Server:** [src/index.ts](src/index.ts) — implements `initialize`, `tools/list`, `tools/call`; each tool is one of the 12 from [`@a2app/integration-starter`](../integration-starter/), shelling the real framework CLIs.
- **Config:** [.mcp.json](.mcp.json).

## Register

```sh
pnpm --filter @a2app/integration-claude-code build
claude mcp add a2app -- node <abs path>/integrations/claude-code/dist/index.js
# or copy .mcp.json into your project and set A2APP_CLI / AGENT_APP_CLI to the binaries
```

Then the agent has tools `agent_app_describe`, `agent_app_list`, `agent_app_get`, `agent_app_create`, `agent_app_update`, `agent_app_delete`, `agent_app_operations`, `agent_app_run_operation`, `agent_app_poll_tasks`, `agent_app_build`, `agent_app_validate`, `agent_app_walk_verify` — the full build/operate surface. Set `A2APP_CLI` (operate client, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`); a `…/cli.js` entry is run with Node. Verbs route to the owning binary. No shell is used, so field values can't inject.
