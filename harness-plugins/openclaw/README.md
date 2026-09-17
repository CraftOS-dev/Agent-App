# OpenClaw plugin

A real OpenClaw plugin (`definePluginEntry`) with three surfaces, all driving the framework CLIs; it deliberately registers **no agent tools** — the agent surface is the six framework skills it ships plus the CLIs (the universal route).

- **`/agent-app` chat command** — the action path. `/agent-app build a CRM` hands the request to the agent (`continueAgent: true`); standing `agentPromptGuidance` tells the agent to route it to the owning framework skill (creator / modify / operator / importer / walk-verify / connect) instead of building from general knowledge. Bare `/agent-app` replies with usage.
- **`openclaw agent-app <args...>` CLI passthrough** — registered with `api.registerCli(({ program }) => …, { descriptors })`; `binFor` routes each verb to `agent-app` (build/evolve) or `a2app` (operate).
- **"Agent Apps" Control-UI tab** — a **read-only** entry form. OpenClaw frames plugin tabs behind a GET/HEAD-only auth grant in an opaque-origin sandbox (no forms, no clipboard, no mutations), so the form never POSTs: submitting navigates the frame to its own URL with the fields as query parameters, the route composes the kickoff prompt server-side (`buildKickoffPrompt`) and re-renders the page with the prompt in a click-to-select textarea the user copies into chat. Everything — app dropdowns, selections, the prompt — is server-rendered; no data crosses into script context.

**Entry:** [src/index.ts](src/index.ts). **Manifest:** [openclaw.plugin.json](openclaw.plugin.json) — `id` + the required `configSchema`, `commandAliases`, `cliCommands`, `skills`, startup activation.

## Build and install

OpenClaw installs a plugin by copying its folder, rejects `node_modules` symlinks that escape it, and does not install dependencies for a local-dir install — so the installable artifact must be self-contained. [scripts/build.mjs](scripts/build.mjs) stages exactly that into `dist/`: the bundled entry (engine inlined; only the host-provided `openclaw/plugin-sdk/*` imports stay external), a generated `package.json` declaring the entry via `openclaw.extensions` (OpenClaw does not read `main`), the manifest, and the six skills copied from the repo-root [../../skills](../../skills) so the manifest's `./skills` resolves inside the plugin root.

```bash
pnpm install
pnpm --filter @a2app/integration-starter build   # the engine the bundle inlines
pnpm --filter @a2app/integration-openclaw build  # stages dist/
openclaw plugins install ./harness-plugins/openclaw/dist
```

Requires the framework CLIs on `PATH` (v0.1: `pnpm -r build` then `npm link` in `framework/cli`; once published, `npm i -g agent-app`). Set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`) to override which binaries are shelled; a value ending in `.js`/`.mjs`/`.cjs` is run with Node directly.

**Windows hosts:** the CLIs are spawned via cross-spawn, so npm's `.cmd` shims work. One cmd.exe limitation remains: a shim *outside* a `node_modules/.bin` directory (npm's global prefix, where `npm link` puts it) re-expands its arguments once, so a record field value containing a cmd metacharacter (`& | ^ < >`) would be corrupted in transit. Point `A2APP_CLI`/`AGENT_APP_CLI` at the CLIs' `.js` entries to bypass shims entirely — argv then reaches the CLI literally in every case.
