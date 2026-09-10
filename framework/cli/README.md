# `a2app` — the framework CLI

The pinned command set of the two framework binaries — `agent-app` (build/evolve/manage) and `a2app` (the A2App operate client) (skills automate; gates guarantee — the pipeline holds even if a skill is ignored):

| Command | Purpose |
|---|---|
| `scaffold <dir> [--blueprint <id>]` | scaffold: framework files + ownership canon written deterministically |
| `validate <dir>` | validation gate + security gate |
| `toolkit-sync <dir>` / `adapter-sync <dir>` | re-vendor system files / deliver the adapter, re-canonize hashes |
| `data <dir> <verb> …` | the A2App client (schema, record CRUD, ops, task/event polling) |
| `serve <dir>` / `stop <dir>` | launch the app via its manifest pipeline as a managed, health-polled background process, and stop it |
| `list` | every known Agent App with its port and live-probed status (`running`/`stopped`/`missing`); `--json`, `--prune` |
| `global` | the user's cross-app conventions (`GLOBAL_AGENT_APP.md`), seeded on first use |
| `dev` / `promote` / `backup` / `restore` | safe-evolve environments: dev copy with fresh migration-replayed DB → gate + verify in dev → pre-promote backup → promote (walk-verify itself is a skill run by a verifier agent, not a command) |

Contract: exit codes `0` success, `1` rejected, `2` usage error, `3` unreachable; machine-readable stdout (hosts and agents branch on exit code and parse stdout, never scrape prose); error envelopes printed verbatim; relative dates and labels resolved client-side (multi-match fails with candidates, never picks); a flag without a value is exit 2, never `true`.

Every verb resolves relative dates and labels client-side and prints structured results, so an agent — or a host — drives the full build/evolve/operate loop through this one command set.
