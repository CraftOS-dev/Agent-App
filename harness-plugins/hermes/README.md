# Hermes plugin

A Hermes plugin (`plugin.yaml` + `register(ctx)`, Python) whose dashboard tab is the same **Agent Apps manager** the OpenClaw and dsh plugins ship, plus the build + operate tools, the six framework skills, and the `/agent-app` command.

## Surfaces

- **Agent Apps dashboard tab** ([dashboard/](dashboard/)): a browser-style tab strip with one tab per Agent App (status dot; the name greys out when the app is offline) and a **New +** tab. An app tab embeds the running app; an offline app shows **Launch**; the active tab's **⋯** menu offers Pause / Launch, Open in browser, Show session, and Delete (two-step confirm; `agent-app remove --yes` backs data up before deleting). The **New +** form (name, requirement, stack, optional port) starts the build directly.
- **Per-app session panel**: each app has its own Hermes session (id `agent-app-<dir name>-<hash>`). The right panel renders its transcript and a composer. Build progress shows up there as it happens, and evolve or operate requests are messages into that session. A failed turn shows why (for example, no model configured).
- **Tools**: the seventeen `agent_app_*` tools of the shared engine, in the toolset `agent_app`, each shelling a real `agent-app` or `a2app` verb. A relative `dir` resolves against the calling session's working directory.
- **Skills**: the six framework skills, registered as plugin skills (`agent-app:creator`, `agent-app:modify`, ...) and loaded with `skill_view`. Hermes keeps plugin skills out of the `<available_skills>` index (they do get `/agent-app:<skill>` commands in the CLI, TUI and Desktop, but not on messaging platforms), so the plugin also registers a system-prompt section that routes any app request to the right one.
- **`/agent-app <request>`**: hands the request to the agent. In the classic CLI the command injects it as the next turn. On messaging platforms a `pre_gateway_dispatch` hook rewrites `/agent-app <request>` (or `/agent_app`, for Telegram) into the request before dispatch. The TUI and the dashboard chat give plugin commands no way to start a turn, so there the command says to send the request as a normal message, which the routing section still covers.
- **`hermes agent-app <args...>`**: a passthrough to the CLIs, routed by verb (build/evolve verbs to `agent-app`, the rest to `a2app`), output streamed and exit code propagated.
- **The same tab in hermes-webui** ([webui/](webui/)): an "Agent Apps" rail button in [hermes-webui](https://github.com/nesquena/hermes-webui), as a web UI extension. See [hermes-webui](#hermes-webui).
- **Bridge route**: on load the plugin registers Hermes with `agent-app <dir> bridge`, the service that starts a harness when an app queues work, as a `hermes` profile in `$A2APP_HOME/harnesses.json`: `hermes --cli chat -Q --query-file -` with the prompt on stdin, one turn in the app's directory. The framework has no built-in Hermes profile, so without this the bridge cannot see Hermes. Written once; an existing `hermes` entry (your own) is kept.

## How it works

`register(ctx)` ([__init__.py](__init__.py)) runs in every Hermes process and registers the tools, skills, routing section, command, gateway hook, passthrough, and bridge route. The tab is a separate half: `hermes dashboard` imports [dashboard/plugin_api.py](dashboard/plugin_api.py) at startup and mounts its `router` at `/api/plugins/agent-app/`, where the dashboard's own session-token auth covers it. The page ([dashboard/manager.js](dashboard/manager.js)) is a classic script on the dashboard plugin SDK and calls that API with the SDK's `fetchJSON`.

A session turn is one subprocess, `hermes --cli chat -Q --resume <session> --source tool --in <app dir> --query-file -`, with the message on stdin. This is how Hermes runs its own background workers (the kanban dispatcher), so a turn uses your configured model, toolsets, and approval policy, and nothing depends on agent internals. Turns on one session run one at a time, in order, and a turn never inherits the host process's own session or approval state (a session-less `/yolo` there does not reach it). The `tool` source keeps these sessions out of the CLI, TUI and Desktop session pickers and the dashboard's Chats view; they live in the tab (the dashboard's Sessions page still lists them under Automation and All). Deleting an app stops its session's running turn before the app is removed. Each turn's output is appended to `$HERMES_HOME/plugin-data/agent-app/logs/<session>.log`, and the transcript is read back from the session database. New apps are created under `$A2APP_HOME/apps/<slug>` (default `~/.a2app/apps`), as in the other managers. App status comes from `agent-app list --json`, polled by the page.

[engine.py](engine.py) is a Python port of the shared TypeScript engine ([../integration-starter/](../integration-starter/)): same tool names, schemas, and argv, same build kickoff prompt, same harness-file rules. No shell is used. On Windows an npm `.cmd` shim is read for the script it runs and Node is started on that script directly, so a field value holding `& | ^ < > %` or quotes reaches the CLI intact.

**Embedding:** an app listens on the Hermes machine's loopback interface, so the tab embeds it when the dashboard is open over http on that machine (`http://127.0.0.1:9119` by default). Opened from another host or over HTTPS, the tab shows the app's URL in place of a frame that could not load.

**Hermes Desktop** does not load dashboard plugins (it has its own plugin SDK), so the tab appears in `hermes dashboard` and, as an extension, in hermes-webui. The tools, skills, command, and passthrough work on every Hermes surface.

## hermes-webui

[hermes-webui](https://github.com/nesquena/hermes-webui) runs the agent in-process, so the plugin's tools, skills, and routing section load in its chats once the plugin is enabled. It cannot start a turn from a plugin command, so there `/agent-app` says to send the request as a normal message. It hosts a dashboard plugin's tab only as a sandboxed iframe and never runs `plugin_api.py`, and an app framed inside that sandbox has no origin of its own (no cookies or storage, its requests to itself refused). So the tab comes as an extension instead:

- [webui/agent-apps.js](webui/agent-apps.js) runs in the web UI's main page. It adds an **Agent Apps** rail button and fills the web UI's own plugin page view with the manager ([dashboard/manager.js](dashboard/manager.js), mounted through `window.__AGENT_APP_MANAGER__.mount`). Settings → Plugins → Open for agent-app lands in the same place.
- The tab's API is served by the plugin itself: when it loads in the hermes-webui server process (and only there), [webui_backend.py](webui_backend.py) starts the same routes on a loopback port, on its own thread (the web UI loads plugins midway through its own imports, and `register()` must not wait on them). It publishes its address and a token in `runtime.json` beside the extension's files, which the web UI serves like them, so the backend is exactly as protected as the web UI. Each request needs that token, the web UI's own origin (or none, for a local tool), and a loopback `Host`.

Install both halves, allow framing local apps, and restart the web UI:

```bash
python harness-plugins/hermes/scripts/build.py --install --webui
hermes plugins enable agent-app --no-allow-tool-override
echo 'HERMES_WEBUI_CSP_FRAME_EXTRA="http://127.0.0.1:* http://localhost:*"' >> ~/.hermes/.env
./ctl.sh restart    # in the hermes-webui checkout
```

`--webui` copies [webui/](webui/) and the manager into the web UI's managed extension directory (`$HERMES_WEBUI_STATE_DIR/extensions/agent-app`, default `~/.hermes/webui`) and records it as the web UI's gallery installer does, so Settings → Extensions lists it and can disable or uninstall it. Without the frame setting the tab still works, and links to running apps instead of embedding them.

A web UI started by a supervisor may not have your shell's `PATH`, so give the plugin absolute paths in `~/.hermes/.env` (Hermes loads it in every process): `AGENT_APP_CLI`, `A2APP_CLI`, and `HERMES_BIN` (the `hermes` session turns run). Turns use Hermes's own model configuration (`hermes model`), not a model picked in the web UI's composer.

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
- `HERMES_BIN`: the `hermes` the tab runs session turns with. Default: the dashboard's own interpreter (`python -m hermes_cli.main`, the same install and profile) when it runs in Hermes's venv, else the `hermes` launcher.
- hermes-webui: `AGENT_APP_WEBUI_BACKEND=0` keeps the tab backend from starting; `AGENT_APP_WEBUI_BACKEND_PORT` fixes its port (default: a free one); `AGENT_APP_WEBUI_ORIGINS` adds origins allowed to call it, for a web UI reached at other than `http://127.0.0.1:<HERMES_WEBUI_PORT>` or `localhost`.
- Approvals: session turns and bridge runs are single-query runs, so a command Hermes flags as dangerous follows `approvals.single_query_mode` (default `deny`: the command is blocked and the agent is told). The plugin grants nothing on your behalf.

## Tests

```bash
python harness-plugins/hermes/test/test_plugin.py
```

Standard library plus Node (the fake CLIs are `.js` entries); the dashboard API tests also need FastAPI and are skipped without it (the hermes-webui backend's do not). The suite loads the plugin the way Hermes's loader does and the backend the way the dashboard does, with fakes for the plugin context and the `hermes` binary, and checks argv and kickoff prompts against the compiled TypeScript engine when `@a2app/integration-starter` is built.
