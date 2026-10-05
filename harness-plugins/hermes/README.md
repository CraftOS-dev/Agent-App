# Hermes plugin

A Hermes plugin (`plugin.yaml` + `register(ctx)`, Python) whose dashboard tab is the same **Agent Apps manager** the OpenClaw and dsh plugins ship, plus the build + operate tools, the six framework skills, and the `/agent-app` command.

## Surfaces

- **Agent Apps dashboard tab** ([dashboard/](dashboard/)): a browser-style tab strip with one tab per Agent App (status dot; the name greys out when the app is offline) and a **New +** tab. An app tab embeds the running app; an offline app shows **Launch**; the active tab's **⋯** menu offers Pause / Launch, Open in browser, Show session, and Delete (two-step confirm; `agent-app remove --yes` backs data up before deleting). The **New +** form (name, requirement, stack, optional port) starts the build directly.
- **Per-app session panel**: each app has its own Hermes session (id `agent-app-<dir name>-<hash>`). The right panel renders its transcript and a composer. Build progress shows up there as it happens, and evolve or operate requests are messages into that session. A failed turn shows why (for example, no model configured).
- **Tools**: the seventeen `agent_app_*` tools of the shared engine, in the toolset `agent_app`, each shelling a real `agent-app` or `a2app` verb. A relative `dir` resolves against the agent's terminal directory.
- **Skills**: the six framework skills, registered as plugin skills (`agent-app:creator`, `agent-app:modify`, ...) and loaded with `skill_view`. Hermes keeps plugin skills out of the `<available_skills>` index and gives them no slash command, so the plugin also registers a system-prompt section that routes any app request to the right one.
- **`/agent-app <request>`**: hands the request to the agent. In the classic CLI the command injects it as the next turn. On messaging platforms a `pre_gateway_dispatch` hook rewrites `/agent-app <request>` (or `/agent_app`, for Telegram) into the request before dispatch. The TUI and the dashboard chat give plugin commands no way to start a turn, so there the command says to send the request as a normal message, which the routing section still covers.
- **`hermes agent-app <args...>`**: a passthrough to the CLIs, routed by verb (build/evolve verbs to `agent-app`, the rest to `a2app`), output streamed and exit code propagated.
- **Bridge route**: on load the plugin registers Hermes with `agent-app <dir> bridge`, the service that starts a harness when an app queues work, as a `hermes` profile in `$A2APP_HOME/harnesses.json`: `hermes --cli chat -Q -q {prompt}`, one turn in the app's directory. The framework has no built-in Hermes profile, so without this the bridge cannot see Hermes. Written once; an existing `hermes` entry (your own) is kept.

## How it works

`register(ctx)` ([__init__.py](__init__.py)) runs in every Hermes process and registers the tools, skills, routing section, command, gateway hook, passthrough, and bridge route. The tab is a separate half: `hermes dashboard` imports [dashboard/plugin_api.py](dashboard/plugin_api.py) at startup and mounts its `router` at `/api/plugins/agent-app/`, where the dashboard's own session-token auth covers it. The page ([dashboard/manager.js](dashboard/manager.js)) is a classic script on the dashboard plugin SDK and calls that API with the SDK's `fetchJSON`.

A session turn is one subprocess, `hermes --cli chat -Q --resume <session> --source tool --in <app dir> --query-file -`, with the message on stdin. This is how Hermes runs its own background workers (the kanban dispatcher), so a turn uses your configured model, toolsets, and approval policy, and nothing depends on agent internals. Turns on one session run one at a time, in order. The `tool` source keeps these sessions out of Hermes's session lists; they live in the tab. Each turn's output is appended to `$HERMES_HOME/plugin-data/agent-app/logs/<session>.log`, and the transcript is read back from the session database. New apps are created under `$A2APP_HOME/apps/<slug>` (default `~/.a2app/apps`), as in the other managers. App status comes from `agent-app list --json`, polled by the page.

[engine.py](engine.py) is a Python port of the shared TypeScript engine ([../integration-starter/](../integration-starter/)): same tool names, schemas, and argv, same build kickoff prompt, same harness-file rules. No shell is used. On Windows an npm `.cmd` shim is read for the script it runs and Node is started on that script directly, so a field value holding `& | ^ < > %` or quotes reaches the CLI intact.

**Embedding:** an app listens on the Hermes machine's loopback interface, so the tab embeds it when the dashboard is open over http on that machine (`http://127.0.0.1:9119` by default). Opened from another host or over HTTPS, the tab shows the app's URL in place of a frame that could not load.

**Hermes Desktop** does not load dashboard plugins (it has its own plugin SDK), so the tab appears in `hermes dashboard`. The tools, skills, command, and passthrough work on every Hermes surface.

## Build and install

Requires the framework CLIs on `PATH` (`npm i -g agent-app-framework`; from a cloned repo, `pnpm -r build` then `npm link` in `framework/cli`). The Hermes home is `$HERMES_HOME`, default `~/.hermes` (`%LOCALAPPDATA%\hermes` on native Windows).

From a cloned repo, [scripts/build.py](scripts/build.py) stages a self-contained `dist/` (the plugin plus the six skills from the repo-root [../../skills](../../skills)) and `--install` copies it to `$HERMES_HOME/plugins/agent-app`:

```bash
python harness-plugins/hermes/scripts/build.py --install
hermes plugins enable agent-app --no-allow-tool-override
hermes dashboard
```

With Hermes's own installer, from GitHub:

```bash
hermes plugins install CraftOS-dev/Agent-App/harness-plugins/hermes --enable
```

That clones this directory, which holds no copy of the skills, so the plugin uses the ones the installed CLI ships (`agent-app skills --path`).

Hermes plugins are opt-in: nothing loads until `agent-app` is in `plugins.enabled`, which `hermes plugins enable` writes, and it takes effect in the next session. Restart a running `hermes dashboard` after enabling, because the dashboard mounts plugin APIs at startup.

## Configuration

- `AGENT_APP_CLI` (build/evolve, default `agent-app`) and `A2APP_CLI` (operate, default `a2app`): the binaries to shell. A value ending in `.js`/`.mjs`/`.cjs` is run with Node directly.
- `A2APP_HOME`: the framework home (default `~/.a2app`), where new apps and `harnesses.json` go.
- `HERMES_BIN`: the `hermes` the tab runs session turns with. Default: the dashboard's own interpreter (`python -m hermes_cli.main`), which is the same install and profile.
- Approvals: session turns and bridge runs are single-query runs, so a command Hermes flags as dangerous follows `approvals.single_query_mode` (default `deny`: the command is blocked and the agent is told). The plugin grants nothing on your behalf.

## Tests

```bash
python harness-plugins/hermes/test/test_plugin.py
```

Standard library plus Node (the fake CLIs are `.js` entries); the dashboard API tests also need FastAPI and are skipped without it. The suite loads the plugin the way Hermes's loader does and the backend the way the dashboard does, with fakes for the plugin context and the `hermes` binary, and checks argv and kickoff prompts against the compiled TypeScript engine when `@a2app/integration-starter` is built.
