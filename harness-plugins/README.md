# Harness Plugins

Per-harness **plugins**: each exposes the framework in the harness's own plugin API — registered agent tools and/or commands, display, and skills — by shelling the framework CLIs (`agent-app` for build/evolve, `a2app` for operate). The shared logic lives once in [integration-starter/](integration-starter/) (the engine); each plugin is a thin binding to a real harness API. Harnesses with no plugin use the universal [../skills/](../skills/) route: the skills tell the agent to run `agent-app <dir> open`, and the CLI opens the app itself (harness-declared opener, else the OS browser, always printing the URL) — so a launched app reaches the user with no plugin code at all.

| Directory | Harness | Language / API | What it registers |
|---|---|---|---|
| [integration-starter/](integration-starter/) | — (shared engine + template) | TypeScript | The 14 build+operate tools, skills, display, and `runA2App`; every plugin below uses it |
| [openclaw/](openclaw/) | [OpenClaw](https://docs.openclaw.ai) | TypeScript, `definePluginEntry`; `pnpm build` stages a self-contained installable `dist/` | An "Agent Apps" **manager tab** (browser-style tabs per app: embedded app view, launch/pause/delete, a per-app session side panel, and a build form that starts the agent run directly) + `/agent-app` chat command + `agent-app` CLI + the six skills; no agent tools (skills + CLIs are the agent surface); ships `openclaw.plugin.json` |
| [hermes/](hermes/) | [Hermes](https://github.com/NousResearch/hermes-agent) | **Python**, `plugin.yaml` + `register(ctx)` | 11 tools via `ctx.register_tool(...)` |
| [dsh/](dsh/) | deepseek-harness | TypeScript Cordis (peer deps `cordis`, `@deepseek-ai/dsh-tools`) | 11 tools via `ctx.tools.register(defineTool(...))`; a browser iframe renderer |
| [craftbot/](craftbot/) | [CraftBot](https://github.com/CraftOS-dev/CraftBot) | **Python**, `@action` decorator (`agent_core`) | 11 actions in the `agent_app` action set |
| [claude-code/](claude-code/) | Claude Code | **MCP** (stdio JSON-RPC 2.0) | 14 tools via a real MCP server; register with `claude mcp add` |
| [../.claude-plugin/](../.claude-plugin/) | Claude Code | Plugin marketplace manifest (no code) | The `/agent-app` launcher command ([../commands/](../commands/)) + the six [../skills/](../skills/), installable with `/plugin`. No build step, so it works from a clean checkout; add the MCP server above for the tool surface |

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

## Taking work from an app

The other direction, and the same shape: an app puts work on its queue, and
getting an agent to pick it up is a harness capability, not a protocol step. It
resolves deepest-first (`agent-app <dir> bridge` reports which rung a machine
lands on, and `framework/cli/` documents the whole ladder):

1. **An inbound endpoint** — the harness already serves an HTTP route that starts
   a run. Deepest, and rare; most harnesses have no such API.
2. **A headless CLI** — `claude -p`, `codex exec`, `gemini -p`, `aider --message`.
   Universal, and the **default**: the framework ships profiles for these, so a
   machine with one installed needs no plugin and no configuration at all.
3. **A gateway** — a local process the framework starts and then posts to.
4. **Polling** — the harness cannot be triggered, so it runs
   `a2app <app> tasks next --wait 60000` in a loop of its own and takes work that
   way. Nothing needs to reach into it.
5. **Nothing** — bi-directional operation is not supported on that machine, and
   the CLI says so rather than starting a service that delivers nothing.

**A plugin's job here is one file.** If its harness offers rung 1 or 3 — an
endpoint, or a gateway it can start — the plugin writes that route into
`$A2APP_HOME/harnesses.json` (`~/.a2app/harnesses.json`) at install time, and
every app on the machine can use it. An entry replaces a same-id built-in
outright, so a plugin also uses this to correct a headless invocation whose flags
have changed:

```jsonc
{ "version": 1, "harnesses": [
  { "id": "myharness", "routes": [
    { "mode": "inbound", "url": "http://127.0.0.1:7000/run",
      "health": "http://127.0.0.1:7000/up", "tokenEnv": "MYHARNESS_TOKEN" },
    { "mode": "headless", "command": "myharness", "args": ["run", "--prompt", "{prompt}"] }
  ] }
] }
```

Store the **name** of the variable holding a token, never the token — this file
is hand-edited and pasted around. List every route the harness offers in any
order; the ladder picks. A plugin that does nothing here is not broken: its users
land on rung 2 or 4, which need no plugin code.

What a plugin must **not** do is start a bridge on a user's behalf. A bridge lets
an app start agent runs, which is a capability a person grants once, knowingly,
for an app they chose.
