# Pi plugin

A [Pi](https://pi.dev) package that exposes the Agent App Framework as **a command plus the six framework skills — no tool code**. This is the same declarative shape as the [Claude Code plugin](../../.claude-plugin/): the `/agent-app` launcher routes a request to the right skill, and the skills direct the agent to the `agent-app` (build/evolve) and `a2app` (operate) CLIs. Pi drives those CLIs with its built-in `bash` tool, so no per-tool binding is needed.

- **Command:** [prompts/agent-app.md](prompts/agent-app.md) — a Pi [prompt template](https://pi.dev/docs/latest) (`description` + `argument-hint` frontmatter, `$ARGUMENTS` body). Typing `/agent-app <request>` expands it into the routing prompt.
- **Skills:** the six framework skills under [../../skills](../../skills) (`creator`, `modify`, `importer`, `operator`, `walk-verify`, `connect`). Pi discovers `SKILL.md` folders recursively; each is loadable with `/skill:<name>`.
- **Manifest:** [package.json](package.json) — a `pi` manifest (`prompts` + `skills`) with the `pi-package` keyword.

## Install

Requires the CLIs `agent-app` and `a2app` on `PATH` (v0.1: `pnpm -r build` then `npm link` in `framework/cli`; once published, `npm i -g agent-app`).

**Recommended — native Pi dirs (no package, always works):**

```bash
# Skills → Pi's global skills dir (auto-discovered)
agent-app skills --install ~/.pi/agent/skills
# Command → Pi's global prompts dir
cp harness-plugins/pi/prompts/agent-app.md ~/.pi/agent/prompts/
```

Then in Pi: `/agent-app build a CRM` (or `/skill:creator`). Use `.pi/skills` and `.pi/prompts` for a project-local, trusted-project install instead of the `~/.pi/agent/*` global dirs.

**As a versioned package** (bundles command + skills as one unit):

```bash
pi install ./harness-plugins/pi          # from a cloned repo (local path)
pi install git:github.com/CraftOS-dev/Agent-App   # once the pi manifest is at a discoverable root
```

The manifest's `skills` points at `../../skills` (the single source of truth at the repo root) so a local-path install from the cloned repo finds them with no copy step. If your Pi build rejects an out-of-root skills path, fall back to the `agent-app skills --install` route above — it targets Pi's native skills dir and is the mechanism the CLI's `skills` verb exists for.

## Configuration

- `AGENT_APP_CLI` — the build/evolve binary (default `agent-app`).
- `A2APP_CLI` — the operate binary (default `a2app`).

These are read by the CLIs the skills invoke; the plugin itself ships no code, so there is nothing to build or typecheck.
