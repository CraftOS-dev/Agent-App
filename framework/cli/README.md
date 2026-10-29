# 🤖 agent-app-framework

The **Agent App Framework** CLI. One package, two commands:

- **`agent-app`** — build, evolve, and manage Agent Apps (the framework).
- **`a2app`** — operate a running Agent App over the A2App protocol.

[![npm](https://img.shields.io/badge/npm-agent--app--framework-cb3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-app-framework)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/CraftOS-dev/Agent-App/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)

* * *

## 📦 Install

```bash
npm i -g agent-app-framework
```

Both `agent-app` and `a2app` are now on your PATH. (Node ≥ 20.)

* * *

## 🧭 `a2app` — operate a running app

`a2app` is a **walk**: you name a place in the app and invoke an operation where you land. Start at the app and follow what each screen offers.

```bash
a2app <app>                         # the app's modules (start here)
a2app <app> planning                # a module's entities and operations
a2app <app> planning cards          # one entity: its fields and operations
a2app <app> planning cards <id>     # one record, and what its state allows now
a2app <app> data cards create --title "Buy milk" --due tomorrow
a2app <app> --find invoice          # search names, get locations
```

`<app>` is a directory, a registered id/name, or an `http(s)` URL — a URL operates a **remote** app, with its identity verified and pinned and the credential taken from `A2APP_TOKEN` or the credential store, never from the app.

Reserved protocol segments (never module names): `data`, `identity`, `whoami`, `context`, `tasks`, `events`.

* * *

## 🛠️ `agent-app` — build, evolve, manage

| Command | Purpose |
|---|---|
| `agent-app <dir> scaffold [--blueprint <id>]` | Framework files + ownership canon, written deterministically |
| `agent-app <dir> validate` | The validation gate + security gate |
| `agent-app <dir> toolkit-sync` / `adapter-sync` | Re-vendor system files / deliver the adapter, re-record hashes |
| `agent-app <dir> serve` / `stop` | Launch via the manifest pipeline as a health-polled background process, and stop it |
| `agent-app <dir> dev` / `promote` / `backup` / `restore` | Safe-evolve: boot the candidate on a hidden port with a fresh migration-replayed DB → gate + verify → promote with a pre-promote backup |
| `agent-app list` | Every known Agent App with its port and live status, plus a live dev instance or bridge on the app's own row (`--json`, `--prune`) |
| `agent-app global` | The user's cross-app conventions (`GLOBAL_AGENT_APP.md`) |
| `agent-app skills [--install <dir>]` | List the framework skills, or install them into a harness |
| `agent-app <dir> bridge [status\|start\|stop]` | The app→agent direction: watch this app's task queue, claim what appears, and trigger an agent harness by the deepest route it offers — see [Bridge](#bridge-the-appagent-direction) |
| `agent-app catalogue [--search <words>] [--source <marketplace>]` | The marketplace's apps, each marked `compatible` (or not, and why) without downloading it — see [Install](#install-the-marketplace-and-packages) |
| `agent-app inspect <id> \| --from <source>` | What a package is and what installing it would do; installs nothing |
| `agent-app install <id> \| --from <source>` | Install from the marketplace, a zip, a folder, GitHub or any git host — one pipeline for every source |
| `agent-app <dir> export [--out <file.zip>]` | Write the app as a package zip that installs elsewhere |
| `agent-app <dir> import` | Install a folder in place, through the same pipeline |

* * *

## Install: the marketplace and packages

An app travels as a **package**: its directory tree, usually zipped, carrying the framework files and never its credentials, data, runtime state, dependencies or build output. Every source goes through one pipeline, so an app arrives the same way whichever harness installed it ([packaging spec](https://github.com/CraftOS-dev/Agent-App/blob/main/spec/v0_2/packaging.md)):

`acquire → inspect → sanitize → revendor → customize → place → register → dependencies → gate → serve → open`

```bash
agent-app catalogue --search kanban                 # what the marketplace offers, and whether it runs here
agent-app inspect kanban-board                       # stage it, say what it is; installs nothing
agent-app install kanban-board --set APP_TITLE=Team  # the marketplace (catalogued: nothing more owed)
agent-app install --from ./board.zip                 # a package zip (untrusted: walk-verify owed)
agent-app install --from ./board                     # a folder (copied; the folder is left as it was)
agent-app install --from github:owner/repo@main/apps/board
agent-app install --from https://github.com/owner/repo/tree/main/apps/board
agent-app install --from git+https://git.example.com/board.git#release
agent-app ./board import                             # this folder, in place
agent-app ./board export --out board.zip             # the other direction
```

Install flags: `--into <dir>` (absent or empty; default `$A2APP_HOME/apps/<name>`), `--name`, `--port`, `--blueprint <id>` (the local toolkit to re-vendor from), `--set KEY=VALUE` (repeatable), `--no-start` (install the files only; `serve --install` installs dependencies and launches later), `--open`, `--events` (one JSON line per step, then the result).

What install guarantees:

- **Nothing from the package runs before its dependencies step**, and what runs then is the *local* toolkit's pipeline: system files are replaced from a toolkit installed on this machine, chosen by the id the package records — never by a path it records, and never from inside the package.
- **A failed step leaves nothing behind**: no registry entry, no app folder, no staging; an in-place import puts the folder back exactly as it was. The one exception is the gate: an app that fails it stays installed so it can be fixed, and the result says so.
- **Archives are read defensively**: absolute paths, `..`, drives, links, encrypted entries and anything that would land outside the target are refused, and sizes are capped at 512 MiB while bytes arrive.
- **Provenance is recorded** in the app's `manifest.json` as `source`: where it came from, the ref, the archive's SHA-256 or the git commit, and when.

**Which marketplace.** `--source`, else `A2APP_MARKETPLACE`, else `marketplace` in `$A2APP_HOME/settings.json`, else `github:CraftOS-dev/agent-app-collection` — which alone falls back to `github:CraftOS-dev/living-ui-marketplace` when it cannot be read. Each is `github:<owner>/<repo>[@<ref>]` or a local directory holding `catalogue.json` and the app folders. `A2APP_MARKETPLACE_REF` sets the branch when the source names none.

**Test only:** `A2APP_TEST_GITHUB_BASE=http://127.0.0.1:<port>` serves both GitHub's raw files and its branch archives from one local server, with GitHub's own paths below it. It accepts only a loopback `http://` origin, so it can never point an install at another host.

* * *

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

**Is queued work being picked up?** `serve`, `bridge` and `list` tell you for a
running app: whether a bridge is running for it, and how many tasks wait in its
queue. When tasks wait and nothing will take them, they print the command that
starts a bridge — they never start one, since each task becomes an agent run.
The same facts are in their JSON as `agentWork` (`bridge`: `running` · `stale` ·
`none`, `bridgeTarget`, `tasksWaiting`, `queuesAgentWork`).

- A bridge runs until `bridge stop`. `agent-app <dir> stop` leaves it up, and it
  picks work up again when the app is served again.
- `bridge start` will not start a background bridge while a dev instance is up
  (it would take work from dev). Use `--once` or `--foreground` to try a change
  on dev.
- A running bridge that leaves work it takes waiting well past its poll
  interval, with nothing in hand, is reported as not picking work up (its pid
  may belong to another process after a reboot). Work for capabilities a
  `--capability` bridge skips is reported too.
- An app counts as queueing agent work once its queue holds a task, in any
  status; one that has never queued anything is not flagged. `list` reads only
  the waiting tasks, so it marks an app only while work waits or a bridge is
  recorded. The queue is read with the app's own credential, after the port has
  answered as that app. A harness polling the queue from elsewhere is not
  visible here.

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

- **One run per task.** A task is claimed before it is delivered, so two bridges — or a bridge and a harness running `tasks next` — can watch one queue and each task still runs once. Whoever claims first owns it; everyone else gets 409 and moves on. The one hole is the app's own safety net: a task handed over an HTTP route stays `working`, and a harness that never reports has it returned to the queue after 60s and delivered again. Suppressing that would strand every task a dead agent was holding, so it is allowed — but the bridge remembers what it handed over and **says so loudly** when one comes back, naming the fix (the harness must call `tasks progress`). A duplicate run nobody is told about is the failure worth preventing.
- **The claim stays alive.** The adapter sweeps a `working` task back to `submitted` after 60s without an update, so a dead agent's work is redelivered. A real run takes minutes, so the bridge sends progress heartbeats while a headless run is in flight. A heartbeat the app refuses means the claim was lost, and the run is killed rather than allowed to finish against a task somebody else now owns.
- **Tasks are closed only where that is knowable.** A headless run is over when the process exits, so the task is closed from its exit code — unless the harness already closed it itself, in which case the harness's own result stands, `input-required` included. An HTTP trigger is different: a 2xx is an *acknowledgement*, the run happens elsewhere, and the task is deliberately left open for the harness to close. A trigger that is *refused* does fail the task, because nothing started.
- **The agent acts as whoever asked.** The bridge holds the app's admin credential but never hands it on. For each task it asks the app for the task's own credential, which acts for the person who queued the task, holds what the capability declares, and stops working when the task ends (an hour at most). A headless run gets it as `A2APP_TOKEN`. An inbound or gateway route gets it as `credential.token` in the body, to run its agent with. A protocol 0.1 app issues none, and its harness uses the app's own credential as before.
- **The payload is data.** It is fenced with a per-delivery nonce (so a payload cannot close its own fence), labelled as data rather than instructions, capped with a pointer to `tasks get <id>` for the rest, and the harness is spawned with **no shell** and an argument array — a record titled `"; rm -rf ~` arrives as a title.
- **Nothing starts on its own.** A bridge is per-app and explicitly started. `--dry-run` shows the exact prompts a run would produce and claims nothing.
- **It is quiet enough to leave running.** A bridge writes to `.a2app/bridge.log`, which nothing rotates, so repetition is the enemy: a task filtered out by `--capability` is announced once rather than every poll, and an app that goes down is complained about once (with one line when it comes back) rather than every few seconds. `agent-app list` marks apps with a live bridge as `bridge:<harness>/<route>`, so "which of my apps can start agent runs?" is answerable without visiting each one.

* * *

## 📐 Contract

Both commands are machine-first and share one exit-code contract:

`0` success · `1` rejected (gate/guard) · `2` usage error · `3` app unreachable.

Results are machine-readable on stdout; diagnostics go to stderr. Hosts and agents branch on the exit code and parse stdout — never scrape prose. A flag given without a value is a usage error (exit `2`), never treated as `true`.

* * *

## 📖 Learn more

Full specification, protocol, and skills: [github.com/CraftOS-dev/Agent-App](https://github.com/CraftOS-dev/Agent-App).
