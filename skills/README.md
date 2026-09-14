# Framework skills

Framework knowledge artifacts: plain, **self-contained** markdown any agent can
read. Skills carry procedure and discipline; the `agent-app validate` gate guarantees quality even
if a skill is ignored. Loaded per run, only for the run that needs them; never
bound to a session or project.

## Contract

- **Layout**: `skills/<name>/SKILL.md` (+ optional reference files); `skills/index.json`
  lists every skill (`name`, `activity`, `description`, path, optional
  `stack`/`toolkit` tags) so selection is deterministic — no host, no injection.
- **Frontmatter**: `name` (matches the directory), `activity` (one of: creator,
  modify, importer, operator, walk-verify, connect), `description` (one line: when
  to load), optional `stack`/`toolkit` tags. The frontmatter is
  agentskills.io-compatible, so harnesses that load the common `SKILL.md` format
  (OpenClaw, Hermes, dsh, Claude Code, and others) consume these unmodified.
- **Self-contained**: a skill states its rules directly and points only to files an
  operating agent actually has — the app's own `AGENT_APP.md`,
  `reference/requirements.md`, and (for stack specifics) `reference/blueprint.md`,
  which the blueprint ships into the app at scaffold. A skill never cites an
  external framework spec it cannot open.

## Getting them

These ship inside the `agent-app` package (one package, two binaries: `agent-app` to build/evolve, `a2app` to operate), so `npm i -g agent-app` installs the skills too:

```bash
agent-app skills                      # list them
agent-app skills --path               # where they are
agent-app skills --install .claude/skills   # into a harness that loads SKILL.md
```

Claude Code users can instead install the plugin (`.claude-plugin/marketplace.json`
at the repo root), which carries these six directly.

## The six activities

| Skill | Activity |
|---|---|
| `creator/` | build a new Agent App |
| `modify/` | evolve an existing one (safe-evolve: dev → gate → walk-verify → promote) |
| `importer/` | install / import / adopt / convert an existing app |
| `operator/` | read state, operate, diagnose — no code changes |
| `walk-verify/` | independently verify a running app against its requirements (verdicts: pass / defects / incomplete / blocked; never the builder) |
| `connect/` | connect to a published Agent App (reserved until deployed mode) |

## Stack specifics

These six are **stack-agnostic**: they carry the method and discipline. Stack-specific
execution knowledge (the file map of what's yours vs. system-owned, the
schema/migration API, how operations are implemented, the UI kit, external calls,
and the gate) lives in each blueprint's **`reference/blueprint.md`**. The blueprint
ships it in its template and `scaffold` copies it into the app, so an operating
agent always has it on disk beside `reference/requirements.md`. These skills
direct the agent to read it wherever stack specifics apply — so the contract never
has to be reverse-engineered from source.
