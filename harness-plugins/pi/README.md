# Pi plugin

A [Pi](https://pi.dev) package that exposes the Agent App Framework as **a command plus the six framework skills — no tool code** — and one small extension that makes Pi reachable from `agent-app <dir> bridge`. This is the same declarative shape as the [Claude Code plugin](../../.claude-plugin/): the `/agent-app` launcher routes a request to the right skill, and the skills direct the agent to the `agent-app` (build/evolve) and `a2app` (operate) CLIs. Pi drives those CLIs with its built-in `bash` tool, so no per-tool binding is needed.

- **Command:** [prompts/agent-app.md](prompts/agent-app.md) — a Pi [prompt template](https://pi.dev/docs/latest) (`description` + `argument-hint` frontmatter, `$ARGUMENTS` body). Typing `/agent-app <request>` expands it into the routing prompt.
- **Skills:** the six framework skills from [../../skills](../../skills) (`creator`, `modify`, `importer`, `operator`, `walk-verify`, `connect`), copied into `./skills` by `build`. Pi discovers `SKILL.md` folders recursively; each is loadable with `/skill:<name>`.
- **Bridge route:** [extensions/a2app-bridge.ts](extensions/a2app-bridge.ts) — on load, registers Pi with `agent-app <dir> bridge` (the service that starts a harness when an app queues work) as a `pi` profile in `$A2APP_HOME/harnesses.json`: `pi -p {prompt}`, one run in the app's directory. The framework has no built-in Pi profile, so without it the bridge cannot see Pi. Written once; an existing `pi` entry (your own) is kept. It uses Node built-ins only, because Pi installs by copying files.
- **Manifest:** [package.json](package.json) — a `pi` manifest (`prompts` + `skills` + `extensions`) with the `pi-package` keyword.

## Install

Requires the CLIs `agent-app` and `a2app` on `PATH` (`npm i -g agent-app-framework`; from a cloned repo, `pnpm -r build` then `npm link` in `framework/cli`).

**Recommended — native Pi dirs (no package, always works):**

```bash
# Skills → Pi's global skills dir (auto-discovered)
agent-app skills --install ~/.pi/agent/skills
# Command → Pi's global prompts dir
cp harness-plugins/pi/prompts/agent-app.md ~/.pi/agent/prompts/
# Bridge route → Pi's global extensions dir (auto-discovered)
cp harness-plugins/pi/extensions/a2app-bridge.ts ~/.pi/agent/extensions/
```

Then in Pi: `/agent-app build a CRM` (or `/skill:creator`). Use `.pi/skills` and `.pi/prompts` for a project-local, trusted-project install instead of the `~/.pi/agent/*` global dirs.

**As a versioned package** (bundles command + skills as one unit):

```bash
pi install npm:@craftos/agent-app-pi     # from npm
pnpm --filter @craftos/agent-app-pi build && pi install ./harness-plugins/pi   # from a cloned repo (local path)
```

The manifest's `skills` points at `./skills`, a copy of the single source of truth at the repo root (`../../skills`). `build` makes the copy and `npm pack`/`npm publish` remake it (`prepack`), because Pi resolves manifest paths inside the package and a published tarball holds nothing outside it. The copy is not tracked in git.

## Configuration

- `AGENT_APP_CLI` — the build/evolve binary (default `agent-app`).
- `A2APP_CLI` — the operate binary (default `a2app`).

These are read by the CLIs the skills invoke. The only code is the extension, which Pi loads as TypeScript, so `build` only copies the skills; `pnpm typecheck` and `pnpm test` check the extension.
