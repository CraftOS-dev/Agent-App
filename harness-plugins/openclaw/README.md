# OpenClaw plugin

A real OpenClaw plugin (`definePluginEntry`) whose Control-UI tab is a full **Agent Apps manager**, styled with OpenClaw's own design tokens. It deliberately registers **no agent tools** — the agent surface is the six framework skills it ships plus the CLIs (the universal route).

## Surfaces

- **"Agent Apps" Control-UI tab** ([src/ui.ts](src/ui.ts)) — a browser-style tab strip: one tab per Agent App (status dot; the name greys out when the app is offline) plus a rightmost **New +** tab. An app tab embeds the running app; an offline app shows a **Launch** button; the active tab's **⋯** menu offers Pause / Launch, Show session, and Delete (two-step confirm; `agent-app remove --yes` backs data up before deleting). The **New +** form (name, requirement, stack, optional port) starts the build directly — no prompt copy-pasting.
- **Per-app session panel** — each app has a dedicated OpenClaw session (deterministic key `subagent:agent-app:<dir>`, the workboard pattern). The right sidebar renders its transcript and a composer: build progress streams here as it happens, and evolve/operate requests are simply messages into this session — which is why the form has no Evolve/Operate modes.
- **`/agent-app` chat command** — hands a request to the agent (`continueAgent: true`) with standing `agentPromptGuidance` routing it to the owning framework skill.
- **`openclaw agent-app <args…>` CLI passthrough** — a true passthrough (`passThroughOptions`, flags forwarded verbatim, exit code propagated), verbs routed to `agent-app` or `a2app` by `binFor`.

## How it works

`/agent-app/home` (`auth: "gateway"`) serves the page — only the authenticated Control UI can load it, and each load embeds a fresh API token. `/agent-app/api` (`auth: "plugin"`) is the JSON API the page calls (apps list, build, serve/stop/remove, session read/send); the plugin owns its auth (the token) and CORS. Lifecycle actions shell the framework CLI; builds and chat run through OpenClaw's plugin runtime (`runtime.subagent.run`), with the creator-skill kickoff prompt composed by the shared engine. New apps are created under `$A2APP_HOME/apps/<slug>` (default `~/.a2app/apps`). App status comes from `agent-app list --json`, whose running/stopped/unreachable state is a live identity probe, polled by the page.

**Embedding requirement:** OpenClaw renders plugin tabs in an opaque-origin sandbox by default, which breaks any embedded app's own backend calls. To display apps inside the tab, set in your OpenClaw config:

```
gateway.controlUi.embedSandbox: "trusted"
```

Everything else (tabs, build, lifecycle, session panel) works under the default sandbox; without the setting the page shows this exact requirement in place of the frame. The Control-UI tab also requires a secure context (HTTPS, Tailscale Serve, or trusted loopback) — an OpenClaw platform rule for plugin tabs.

## Build and install

OpenClaw installs a plugin by copying its folder, rejects `node_modules` symlinks that escape it, and does not install dependencies for a local-dir install — so [scripts/build.mjs](scripts/build.mjs) stages a self-contained `dist/`: the bundled entry (engine + UI inlined; only the host-provided `openclaw/plugin-sdk/*` imports stay external), a generated `package.json` declaring the entry via `openclaw.extensions`, the manifest ([openclaw.plugin.json](openclaw.plugin.json) — `id`, required `configSchema`, `commandAliases`, `cliCommands`, `skills`, startup activation), and the six skills copied from the repo-root [../../skills](../../skills).

```bash
pnpm install
pnpm --filter @a2app/integration-starter build   # the engine the bundle inlines
pnpm --filter @a2app/integration-openclaw build  # stages dist/
openclaw plugins install ./harness-plugins/openclaw/dist
openclaw plugins enable a2app
```

Requires the framework CLIs on `PATH` (v0.1: `pnpm -r build` then `npm link` in `framework/cli`; once published, `npm i -g agent-app`). Set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`) to override which binaries are shelled; a value ending in `.js`/`.mjs`/`.cjs` is run with Node directly.

**Windows hosts:** the CLIs are spawned via cross-spawn, so npm's `.cmd` shims work. One cmd.exe limitation remains: a shim *outside* a `node_modules/.bin` directory (npm's global prefix, where `npm link` puts it) re-expands its arguments once, so a record field value containing a cmd metacharacter (`& | ^ < >`) would be corrupted in transit. Point `A2APP_CLI`/`AGENT_APP_CLI` at the CLIs' `.js` entries to bypass shims entirely — argv then reaches the CLI literally in every case.
