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
| `dev` / `promote` / `backup` / `restore` | safe-evolve environments: `dev` boots the candidate on a hidden port with a fresh migration-replayed DB (operate commands auto-target it) → gate + verify against it → `promote` requires the recorded gate pass, takes the pre-promote backup, applies to live, destroys the dev instance (walk-verify itself is a skill run by a verifier agent, not a command) |
| `bridge <dir> [status\|start\|stop]` | the app→agent direction: watch this app's task queue, claim what appears, and trigger an agent harness by the deepest route it offers — see [Bridge](#bridge-the-appagent-direction) |

## Bridge: the app→agent direction

A2App gives an app a queue it can put work in (`tasks`, `events`). Nothing in the protocol makes an agent turn up to take it, because *triggering* is the one part that depends on the harness rather than on the app. `bridge` is that part — a per-app, opt-in background service on the machine where the harness lives.

It picks a route by walking a ladder, deepest integration first, and reports which rung it landed on:

| Rung | Route | When it is used |
|---|---|---|
| 1 | `inbound` | the harness already serves an HTTP endpoint that starts a run — deepest, and rare |
| 2 | `headless` | the harness has a one-shot headless CLI (`claude -p`, `codex exec`, `gemini -p`, `aider --message`). Universal, and the **default**: the built-ins below describe it, so most machines land here with nothing configured |
| 3 | `gateway` | the harness is triggered through a local gateway that is not up yet; the bridge starts it and posts to it |
| 4 | `subscribe` | the harness cannot be triggered, only poll. `bridge start` then hands over the listen command instead of daemonizing: `a2app <app> tasks next --wait 60000` |
| 5 | — | none of the above is available. Bi-directional operation is **not supported here**, and `bridge start` says so and names what would change it — it never starts and silently delivers nothing |

```bash
agent-app <dir> bridge                      # which rung, what is running, how much is waiting
agent-app <dir> bridge start                # background service (pid + log in .a2app/)
agent-app <dir> bridge start --once         # drain what is claimable now and exit (cron, CI)
agent-app <dir> bridge start --dry-run      # print the prompt a task would produce; run nothing
agent-app <dir> bridge start --foreground   # run the loop here; Ctrl-C stops after the current task
agent-app <dir> bridge stop
```

Flags: `--harness <id>`, `--interval <ms>` (default 5000), `--task-timeout <ms>` (default 15 min), `--capability <name>` (repeatable — deliver only these).

**Harness profiles** live in `$A2APP_HOME/harnesses.json` (`~/.a2app/harnesses.json`). `claude`, `codex`, `gemini` and `aider` are built in; an entry with the same `id` replaces a built-in outright rather than merging into it, so what the file says is what runs.

```jsonc
{
  "version": 1,
  "default": "claude",
  "harnesses": [
    { "id": "myharness", "routes": [
      { "mode": "inbound", "url": "http://127.0.0.1:7000/run", "health": "http://127.0.0.1:7000/up", "tokenEnv": "MYHARNESS_TOKEN" },
      { "mode": "headless", "command": "myharness", "args": ["run", "--prompt", "{prompt}"], "timeoutMs": 900000 }
    ] }
  ]
}
```

A profile lists whichever routes its harness offers, in any order; the ladder decides which one is used. `tokenEnv` names the environment variable holding a token — never the token itself, which would be a credential at rest in a hand-edited file.

A `gateway` route needs `health` as well as `start`: without it there is no way to tell a gateway that is already up from one that needs starting, and starting a second copy of a running one is how ports get fought over. A gateway is a service, so it outlives the pass that started it and later runs reuse it — `bridge stop` takes down only a gateway owned by a long-running `bridge start`, and `--once` says the pid of any gateway it had to start.

**What the bridge guarantees.**

- **One run per task.** A task is claimed before it is delivered, so two bridges — or a bridge and a harness running `tasks next` — can watch one queue and each task still runs once. Whoever claims first owns it; everyone else gets 409 and moves on.
- **The claim stays alive.** The adapter sweeps a `working` task back to `submitted` after 60s without an update, so a dead agent's work is redelivered. A real run takes minutes, so the bridge sends progress heartbeats while a headless run is in flight. A heartbeat the app refuses means the claim was lost, and the run is killed rather than allowed to finish against a task somebody else now owns.
- **Tasks are closed only where that is knowable.** A headless run is over when the process exits, so the task is closed from its exit code — unless the harness already closed it itself, in which case the harness's own result stands, `input-required` included. An HTTP trigger is different: a 2xx is an *acknowledgement*, the run happens elsewhere, and the task is deliberately left open for the harness to close. A trigger that is *refused* does fail the task, because nothing started.
- **The payload is data.** It is fenced with a per-delivery nonce (so a payload cannot close its own fence), labelled as data rather than instructions, capped with a pointer to `tasks get <id>` for the rest, and the harness is spawned with **no shell** and an argument array — a record titled `"; rm -rf ~` arrives as a title.
- **Nothing starts on its own.** A bridge is per-app and explicitly started. `--dry-run` shows the exact prompts a run would produce and claims nothing.

Contract: exit codes `0` success, `1` rejected, `2` usage error, `3` unreachable; machine-readable stdout (hosts and agents branch on exit code and parse stdout, never scrape prose); error envelopes printed verbatim; relative dates and labels resolved client-side (multi-match fails with candidates, never picks); a flag without a value is exit 2, never `true`.

Every verb resolves relative dates and labels client-side and prints structured results, so an agent — or a host — drives the full build/evolve/operate loop through this one command set.
