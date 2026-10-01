# Claude Code plugin (MCP server)

Claude Code consumes tools over the **Model Context Protocol**. This package is a real MCP server (stdio, newline-delimited JSON-RPC 2.0) that exposes the framework engine's build + operate tools, so an agent in Claude Code can build, evolve, and operate Agent Apps.

- **Server:** [src/index.ts](src/index.ts) — implements `initialize`, `tools/list`, `tools/call`; each tool is one of the 17 from [`@a2app/integration-starter`](../integration-starter/), shelling the real framework CLIs.
- **Config:** [.mcp.json](.mcp.json).

## Register

```sh
pnpm --filter @a2app/integration-claude-code build
claude mcp add a2app -- node <abs path>/harness-plugins/claude-code/dist/index.js
# or copy .mcp.json into your project and set A2APP_CLI / AGENT_APP_CLI to the binaries
```

Then the agent has tools `agent_app_describe`, `agent_app_find`, `agent_app_list`, `agent_app_get`, `agent_app_create`, `agent_app_update`, `agent_app_delete`, `agent_app_run_operation`, `agent_app_poll_tasks`, `agent_app_next_task`, `agent_app_task_progress`, `agent_app_complete_task`, `agent_app_build`, `agent_app_validate`, `agent_app_serve`, `agent_app_stop`, `agent_app_open` — the full build/operate surface, including taking and closing work an app queued. Set `A2APP_CLI` (operate client, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`); a `…/cli.js` entry is run with Node. Verbs route to the owning binary. No shell is used, so field values can't inject.

## Taking work from an app

When the server starts it registers Claude Code with `agent-app <dir> bridge` (the service that starts a harness when an app queues work), as a `claude` profile in `$A2APP_HOME/harnesses.json` that replaces the framework's built-in one:

```
claude -p {prompt} --permission-mode dontAsk --allowedTools "Bash(a2app *)"
```

The built-in runs `claude -p` with no permission flags, and print mode denies every Bash call that would prompt, so the agent could not run a single `a2app` command. `dontAsk` denies anything not listed instead of prompting, and the one rule lets the agent operate the app through the a2app CLI and nothing else. The entry is written once; if the file already has a `claude` profile (your own), it is kept. The outcome goes to stderr, since stdout carries JSON-RPC.
