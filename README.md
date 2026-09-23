<div align="center">

# 🤖 Agent App

**Agent App is the application that AI agents build, evolve, and operate — a collaboration interface for humans and agents beyond chat, voice, and generative UI.**

[![npm](https://img.shields.io/badge/npm-agent--app--framework-cb3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-app-framework)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/CraftOS-dev/Agent-App?style=social)](https://github.com/CraftOS-dev/Agent-App/stargazers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-1f8383.svg)](CONTRIBUTING.md)

[📦 npm](https://www.npmjs.com/package/agent-app-framework) · [📖 Spec](spec/) · [🧩 Harness plugins](harness-plugins/) · [🤝 Contribute](CONTRIBUTING.md)

</div>

* * *

An **Agent App** is a complete, stateful application — its own frontend, backend, and database — that humans use **visually** and agents use **programmatically**. It removes the human developer from the loop and replaces human review with machine gates: the agent is the developer, the operator, and the maintainer, while you own the code, the data, and the features.

An Agent App is **tech-stack-agnostic** (any stack works, given a matching A2App adapter) and **harness-agnostic** (every agent harness can use it through a plugin or skills). This repository makes it a standard:

- the **Agent App Framework** — so anyone, and any agent, can build their own Agent App;
- the **A2App protocol** — bi-directional communication between an agent and an agentic app;
- the **A2App adapter** — connecting an Agent App to any tech stack.

```
app + A2App adapter + framework files = Agent App
```

Every Agent App follows **MVC-A**: Model, View, Controller, plus the **A**gent surface — the A2App adapter, the ONLY way an agent operates the app. Agents never scrape the View or drive its DOM to operate an app (UI driving is reserved for verification).

* * *

## 🚀 Get started

You talk to your agent harness; it builds and runs the app for you. Three steps:

**1. Install the CLI.**

```bash
npm i -g agent-app-framework
```

This gives you two commands: **`agent-app`** (build, evolve, manage) and **`a2app`** (operate).

**2. Connect it to your harness.** Install the framework **skills** into any harness — the universal route that works everywhere:

```bash
agent-app skills --install <your-harness-dir>
```

For a deeper, in-harness experience, install the **plugin** for your harness instead (see [harness-plugins/](harness-plugins/) for OpenClaw, Claude Code, Hermes, dsh, and more).

**3. Describe what you want.** Tell your harness the app you need — a CRM, a dashboard, an expense tracker, anything. It refines the requirement, builds a full application to the Agent App Building Standard, verifies it, and launches it. Keep talking to evolve it; changes are built and promoted safely, so your live data is never disrupted.

That's it. You now have custom software that both you and your agent can use.

* * *

## 🛠️ Driving it yourself

Everything the harness does runs through two commands, so you can drive the full loop by hand.

**Operate — `a2app`** is a walk: you name a place in the app and act where you land.

```bash
a2app <app>                         # the app's modules (start here)
a2app <app> planning cards          # one entity: its fields and operations
a2app <app> planning cards <id>     # one record, and what its state allows now
a2app <app> data cards create --title "Buy milk" --due tomorrow
a2app <app> --find invoice          # search names, get locations
```

`<app>` is a directory, a registered id/name, or an `http(s)` URL (a URL operates a remote app, with its identity verified and pinned).

**Build & evolve — `agent-app`:**

```bash
agent-app <dir> scaffold            # framework files + ownership canon
agent-app <dir> validate            # the validation + security gate
agent-app <dir> serve               # launch via the manifest pipeline
agent-app <dir> dev / promote       # safe-evolve: build on a hidden port, gate, promote with backup
agent-app list                      # every app with its port and live status
```

Both commands are machine-first: exit codes `0` success · `1` rejected · `2` usage · `3` unreachable, with machine-readable stdout.

* * *

## ✨ Two defining properties

- **Tech-stack agnostic** — no fixed backend, frontend, database, or language. Any app in any stack is an Agent App when the adapter and framework files are present.
- **Agent agnostic** — made for every harness. Context comes by *pull* (files + protocol endpoints), knowledge by *skills* (plain markdown), quality by a *CLI gate* any agent can run. No host required: a bare agent plus a browser is a complete environment.

* * *

## 🧩 A2App in the protocol stack

| Protocol | Answers |
|---|---|
| MCP | How do agents get tools? |
| A2A | How do agents talk to agents? |
| AG-UI / A2UI | How do agent runs stream into UIs / how is declarative UI generated? |
| **A2App** | **How do agents safely operate full stateful applications?** |

Three pillars: **Describe** (the app publishes its own data model, operations, and conventions — generated live so it cannot drift, answered one level at a time so cost follows the task, not the app size) · **Guard** (the app validates every write before the backend touches it; no silent 200s) · **Receipt** (what the user is told is generated from the stored record, never composed by the model). Under hard budgets: every describe response ≤ 2,000 chars at any app size, a correct write in ≤ 2 round trips, every violation reported in one response.

* * *

## 📂 Repository layout

| Directory | Contents |
|---|---|
| [spec/](spec/) | Versioned spec home: normative JSON Schemas (framework files + protocol payloads) |
| [conformance/](conformance/) | Runnable suites — A2App classes A/B/C; artifact classes Agent App / Toolkit / Host |
| [framework/](framework/) | TypeScript reference implementation: the `agent-app` + `a2app` CLIs + optional reference host |
| [adapters/](adapters/) | A2App adapter layers: shared pure rules, starter, sidecar form |
| [toolkits/](toolkits/) | Blueprints & kits — **NOT part of the framework** (optional accelerators) |
| [harness-plugins/](harness-plugins/) | Per-harness plugins (plugins are Hosts in spec terms) |
| [skills/](skills/) | Framework skills (creator, modify, importer, operator, walk-verify, connect) |
| [sdks/](sdks/) | Protocol client SDKs (TypeScript first, Python next) |
| [apps/](apps/) | Runnable example Agent Apps |

* * *

## 🔧 Build from source

```bash
pnpm install && pnpm -r build && pnpm -r test
```

The normative contracts are the JSON Schemas in [spec/](spec/); the [conformance/](conformance/) suite is how an implementation proves it conforms. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

* * *

## 📜 License

[MIT](LICENSE)
