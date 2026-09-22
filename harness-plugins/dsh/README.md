# deepseek-harness (dsh) bundle

A real dsh Cordis bundle with an **Agent Apps manager** shown inside the dsh UI, alongside the agent tools. It registers no new top-level route (dsh has none for plugins); the manager lives in the frame's `shell.overlay` slot as a launcher that opens a full-screen manager.

## Surfaces

- **Agent tools** ([src/index.ts](src/index.ts)) — `apply(ctx)` registers the build+operate tools via `ctx.tools.register(defineTool(...))`, each shelling a framework CLI verb through the shared engine.
- **Agent Apps manager** ([src/manager.ts](src/manager.ts) + [src/ui.ts](src/ui.ts)) — mounted once dsh's `webServer` is available. Browser-style tabs (one per app, status dot, greyed when offline) plus a **New +** build form; an app tab embeds the running app in an iframe; each app has a resizable **session side panel** (transcript + composer); the **⋯** menu launches/pauses/deletes. Build and chat drive a dedicated dsh session (`ctx.agents.create` + `agent.followup`); the transcript is read back with `session.deriveMessages()`; lifecycle shells the CLIs (`serve`/`stop`/`remove`).
- **Client half** ([src/client/index.ts](src/client/index.ts)) — a `shell.overlay` slot component: a launcher pill that opens the manager iframe. It renders inline in the dsh document, so it uses dsh's own `--dsw-*` tokens and follows dark/light; the manager iframe is same-origin with the dsh server (its fetches and any embedded app work with no CORS), and is told the theme through the route.

## Build and install

dsh loads a bundle as a normally-resolvable npm package whose `dsh.bundle.patch` manifest points at `cordis.patch.yml`, with a host half (`main` → `lib/index.js`) and a browser half (`./client` → `lib/client.js`). [scripts/build.mjs](scripts/build.mjs) stages a self-contained `dist/`: the host bundle (engine inlined; cordis + `@deepseek-ai/*` external), the browser bundle wrapped in dsh's module-loader closure (the frozen platform module table — react, cordis, ui-slots — external, everything else inlined), a generated `package.json` with the `dsh.bundle` + `dsh.client` manifest, the patch, and the six skills.

```bash
pnpm install
pnpm --filter @a2app/integration-starter build   # the engine the host bundle inlines
pnpm --filter @a2app/integration-dsh build        # stages dist/
dsh plugin --profile <name> add ./harness-plugins/dsh/dist
```

Requires the framework CLIs on `PATH` (v0.1: `pnpm -r build` then `npm link` in `framework/cli`; once published, `npm i -g agent-app`). Set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`) to override which binaries are shelled; a value ending in `.js`/`.mjs`/`.cjs` is run with Node directly.
