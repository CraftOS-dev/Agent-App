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
| `agent-app list` | Every known Agent App with its port and live status (`--json`, `--prune`) |
| `agent-app global` | The user's cross-app conventions (`GLOBAL_AGENT_APP.md`) |
| `agent-app skills [--install <dir>]` | List the framework skills, or install them into a harness |

* * *

## 📐 Contract

Both commands are machine-first and share one exit-code contract:

`0` success · `1` rejected (gate/guard) · `2` usage error · `3` app unreachable.

Results are machine-readable on stdout; diagnostics go to stderr. Hosts and agents branch on the exit code and parse stdout — never scrape prose. A flag given without a value is a usage error (exit `2`), never treated as `true`.

* * *

## 📖 Learn more

Full specification, protocol, and skills: [github.com/CraftOS-dev/Agent-App](https://github.com/CraftOS-dev/Agent-App).
