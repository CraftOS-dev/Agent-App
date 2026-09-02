# Framework skills

Framework knowledge artifacts: plain, **self-contained** markdown any agent can
read. Skills carry procedure and discipline; the CLI gate guarantees quality even
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
  operating agent actually has — the app's own `AGENT_APP.md` and
  `reference/requirements.md`, and (for stack specifics) the skill variant its
  blueprint ships. A skill never cites an external framework spec it cannot open.

## Getting them

These ship inside the `agent-app` package, so installing the CLI installs the skills:

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

## Stack variants

These six are **stack-agnostic**: they carry the method and discipline. Stack-specific
execution knowledge (migration API, hook rules, UI-kit specifics) lives in a
**skill variant a blueprint ships** with its toolkit, tagged with its `stack`. The
base skill directs the agent to load that variant where stack specifics apply.
