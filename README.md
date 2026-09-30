<div align="center">

<img src="assets/agent-app-logo.png" alt="Agent App logo" width="160">

# Agent App

**Agent App is the application that AI agents build, evolve, and operate. A collaboration space for humans and agents beyond chat, voice, and generative UI.**

[![npm](https://img.shields.io/badge/npm-agent--app--framework-cb3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-app-framework)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/CraftOS-dev/Agent-App?style=social)](https://github.com/CraftOS-dev/Agent-App/stargazers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-1f8383.svg)](CONTRIBUTING.md)

[📦 npm](https://www.npmjs.com/package/agent-app-framework) · [📖 Spec](spec/) · [🧩 Harness plugins](harness-plugins/) · [🤝 Contribute](CONTRIBUTING.md)

<img src="assets/agent-app-showcase.gif" alt="Agent Apps built with the framework">

</div>

* * *

An **Agent App** is a complete, stateful application. It has its own frontend, backend, and database that humans use **visually** and agents use **programmatically** using CLI-walk. The agent is the developer, the operator, and the software vendor, while you own the code, the data, and the features.

<p align="center"><img src="assets/agent-app-flow.gif" alt="You use the Agent App in the browser; your agent uses it through the A2App adapter"></p>

An Agent App is **tech-stack-agnostic** (any stack works, given a matching A2App adapter) and **harness-agnostic** (every agent harness can use it through a plugin or skills). This repository makes it a standard:

- the **Agent App Framework**: provides tools for any agent harnesses to build their own Agent App
- the **A2App protocol**: bi-directional communication protocol between an agent and an agentic app
- the **A2App adapter**: connecting an Agent App to any tech stack

```
app + A2App adapter = Agent App
```

* * *

## 🚀 Get started

Three steps:

**1. Install the CLI.**

```bash
npm i -g agent-app-framework
```

This gives you and your AI agent two commands: **`agent-app`** (build, evolve, manage) and **`a2app`** (operate).

**2. Connect it to your harness.** Install the framework **skills** into any harness — the universal route that works everywhere:

```bash
agent-app skills --install <your-harness-dir>
```

For a deeper, in-harness experience, install the **plugin** for your harness instead (see [harness-plugins/](harness-plugins/) for OpenClaw, Claude Code, Hermes, dsh, and more).

**3. Describe what you want.** Tell your harness the app you need: a CRM, a dashboard, an expense tracker, anything. It refines the requirement, builds a full application to the Agent App Building Standard, verifies it, and launches it. Your need changes? Just tell the agent to evolve the agent app.

That's it! You now have custom software that both you and your agent can use.
**Happy collaboration!**

* * *

## 🛠️ Driving it with AI agent

Everything the harness does runs through two commands (You can drive the full loop by hand, but it is recommended to let your agent runs it).

**Operate — `a2app`** is a walk: you name a place in the app and act where you land.

```bash
a2app <app>                         # the app's modules (start here)
a2app <app> planning cards          # one entity: its fields and operations
a2app <app> planning cards <id>     # one record, and what its state allows now
a2app <app> data cards create --title "Buy milk" --due tomorrow
a2app <app> --find invoice          # search names, get locations
a2app <app> tasks next --wait 60000 # block until the app has work, claim it, print it
```

`<app>` is a directory, a registered id/name, or an `http(s)` URL (a URL operates a remote app, with its identity verified and pinned).

**Build & evolve — `agent-app`:**

```bash
agent-app <dir> scaffold            # framework files + ownership canon
agent-app <dir> validate            # the validation + security gate
agent-app <dir> serve               # launch via the manifest pipeline
agent-app <dir> dev / promote       # safe-evolve: build on a hidden port, gate, promote with backup
agent-app <dir> bridge start        # watch the app's task queue and trigger your harness
agent-app list                      # every app with its port and live status
```

* * *

## 🧩 A2App in the protocol stack

A2App is how your agent communicates with an Agent App. Agent Apps are built to include a CLI, which is the primary way an agent uses them. The agent then performs a CLI-walk to navigate and use the Agent App.

<p align="center"><img src="assets/a2app-protocol.gif" alt="A2App checks every command; risky changes wait for your OK"></p>

What is the difference between MCP, A2A, A2UI, and A2App? Each protocol has its own job, we listed the difference here:

| Protocol | What it does |
|---|---|
| [MCP](https://modelcontextprotocol.io) | Connects AI apps to outside tools and data |
| [A2A](https://a2a-protocol.org) | Lets AI agents talk to each other |
| [A2UI](https://a2ui.org) | Lets agents describe interfaces that apps render natively |
| **A2App** | **Lets agents control a large-scale app** |

* * *

## 🔧 Build from source

```bash
pnpm install && pnpm -r build && pnpm -r test
```

The normative contracts are the JSON Schemas in [spec/](spec/); the [conformance/](conformance/) suite is how an implementation proves it conforms. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

* * *

## 📜 License

[MIT](LICENSE)
