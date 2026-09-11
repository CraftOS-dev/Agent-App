# Agent App

**Agent App is the application that AI agents build, evolve, and operate — a collaboration interface for humans and agents beyond chat, voice, and generative UI.**

An **Agent App** is a complete, stateful application — its own frontend, backend, and database — that humans use **visually** and agents use **programmatically**, primarily via CLI. The framework solves one problem: **how can AI agents build and run their own software?** It removes the human developer from the loop and replaces human review with machine gates, so the agent is the developer, the operator, and the maintainer — and the user owns the code, the data, and the features.

That unified interface is the Agent App: visual for humans, programmatic for agents — and CLI-first, which costs fewer tokens and is faster than any other way of controlling an application. An Agent App is **tech-stack-agnostic** (any stack works, as long as a matching A2App adapter exists) and **harness-agnostic** (every agent harness can use it through the right plugin or skill).

Agent App is the future of software: built, evolved, and operated by humans and agents together. This repository makes it a standard:

- the **Agent App Framework** — so anyone, and any agent, can build their own Agent App: MVC-A architecture, framework files, CLI, skills, validation gate, walk-verify, lifecycle, hosting, security;
- the **A2App protocol** — bi-directional communication between agent and agentic app;
- the **A2App adapter** — connecting Agent Apps to any tech stack.

```
app + A2App adapter + framework files = Agent App
```

Every Agent App follows **MVC-A**: Model, View, Controller, plus the **A**gent surface — the A2App adapter, which is the ONLY agent surface. Agents never scrape the View or drive its DOM to operate an app (UI driving is reserved for verification). The framework files are the contract: `manifest.json` (identity + the `pipeline` launch block), `operations.json`, `reference/requirements.md` (the app's binding spec), `AGENT_APP.md` (the agent-facing index), and the ownership canon (hash-locked system files).

## Getting Started (For agent)

## Install (locally, from this repo)

Do this to install the agent app framework and a2app CLI

```
pnpm install

pnpm -r build
```

### Building an Agent App with an agent harness

Read skills/creator/SKILL.md to build an agent app from fresh

### Importing an existing Agent App

Read skills/importer/SKILL.md to import and validate an existing Agent App

### Turning third-party code into an Agent App

Read skills/importer/SKILL.md to import and transform 3rd part code into an Agent App

### Evolving an Agent App

Read skills/creator/SKILL.md to evolve an agent app

### An agent harness using an Agent App

Read skills/creator/SKILL.md to use an agent app using a2app CLI.

## Two defining properties

- **Tech-stack agnostic** — no fixed backend, frontend, database, or language. Any app in any stack is an Agent App when the adapter and framework files are present. A host launches any stack through the manifest `pipeline` block alone.
- **Agent agnostic** — made for ALL agents (CraftBot, Claude Code, Codex, OpenClaw, Hermes, …). Context is gained by *pull* (files + protocol endpoints), knowledge by *skills* (plain markdown + `skills/index.json`), quality by a *CLI gate* any agent can run. No host required: a bare agent plus a browser is a complete environment.

## A2App in the protocol stack

| Protocol | Answers |
|---|---|
| MCP | How do agents get tools? |
| A2A | How do agents talk to agents? |
| AG-UI / A2UI | How do agent runs stream into UIs / how is declarative UI generated? |
| **A2App** | **How do agents safely operate full stateful applications?** |

Three pillars: **Describe** (the app publishes its own data model, operations, conventions — generated live so it cannot drift, and answered one level at a time so cost follows the task, not the app) · **Guard** (the app validates every write before backend coercion; no silent 200s) · **Receipt** (what the user is told is generated from the stored record, never composed by the model). With hard budgets: every describe response ≤ 2,000 chars at any app size, a correct write in ≤ 2 round trips, every violation reported in one response.

## What an agent does

```bash
# operate (A2App protocol, CLI-primary — HTTP is the required fallback)
a2app <dir>                     # arrive: the app’s modules
a2app <dir> planning cards      # one entity: its fields and the operations on it
a2app <dir> planning cards <id> # one record, and what its current state allows
a2app <dir> data cards create --title "Buy milk" --due tomorrow
# build / evolve (framework CLI)
agent-app <dir> scaffold [--blueprint <id>] # scaffold: framework files + ownership canon
agent-app <dir> validate # the validation + security gate
agent-app <dir> dev / promote / backup / restore # safe-evolve: dev copy, gate, backup, promote
# walk-verify is a skill, not a command: a verifier agent (never the builder) drives the UI vs requirements.md
```

## Scenarios

### Building an Agent App with an agent harness

You use any agent harness — OpenClaw, Hermes, Claude Code, Codex, and many more — and you want custom software your harness can also use: a company dashboard, a CRM, an ERP, any app. You install one of two integrations:

1. **The Agent App Framework plugin.** It includes the skills that guide the agent through building, and additionally displays the Agent App **inside the harness's own interface**. The plugin carries deterministic logic to deploy, load, and validate the app. It is the deepest integration, but must be built per harness. You chat your requirements with the harness, and once the app is built, you use it right inside the harness.
2. **The Agent App Framework Skills.** The universal route for any harness we have no plugin for: markdown files and scripts covering everything the plugin does. The app is displayed in the web browser instead. You chat your requirements with the harness just the same.

Before building, the agent refines your requirement into a better one and may ask you questions to perfect it. Then, following the plugin's pipeline or the skill, it copies over a toolkit — blueprint/boilerplate code in the chosen tech stack — to kick-start the build. While building, the agent follows the pipeline or skill to produce a full application to a defined standard: it reviews and verifies that the app is usable, follows UI/UX practice, is production-grade, and is secure, per the **Agent App Building Standard**. Once done, the harness launches the app — in the web browser when no plugin is used — and informs you.

### Importing an existing Agent App

Import any existing Agent App into your harness — for example from the [marketplace](https://github.com/CraftOS-dev/living-ui-marketplace), or from any codebase that carries a correct A2App adapter.

### Evolving an Agent App

An Agent App is never finished. Keep talking to your harness to change the app as your requirements change; the harness follows the evolve skill or the framework pipeline, then relaunches the app. Evolution is safe by construction: changes are built and verified in a dev environment and promoted with a backup, so the live database and your users' work are never disrupted (safe-evolve).

### Turning third-party code into an Agent App

Have existing software with no A2App adapter yet? The harness uses the pipeline/skill to read the codebase, understand it, and create its A2App adapter — so the app can be launched and used as an Agent App.

### A human using an Agent App

Humans use an Agent App like any other software: visually. You can also talk to the agent and assign it tasks, automating work with the harness driving the app on your behalf — human and agent working together on the same app. And an Agent App works perfectly well with no harness at all.

### An agent harness using an Agent App

Agents use the app programmatically via the A2App protocol, while continuing to talk to you in their own chat session — not one built into the app. Agents are given the guide, skills, and context to operate any Agent App, above all by walking its self-description through the `a2app` operate client, starting at `a2app <dir>`.

*More scenarios will be added as the ecosystem grows.*

## Repository layout

| Directory | Contents |
|---|---|
| [spec/](spec/) | Versioned spec home: normative JSON Schemas (framework files + protocol payloads) |
| [conformance/](conformance/) | Runnable suites — A2App classes A/B/C; artifact classes Agent App / Toolkit / Host |
| [framework/](framework/) | TypeScript reference implementation: the `agent-app` + `a2app` CLIs + optional reference host |
| [adapters/](adapters/) | A2App adapter layers: shared pure rules, starter, sidecar form |
| [toolkits/](toolkits/) | Blueprints & kits — **NOT part of the framework** (optional accelerators) |
| [harness-plugins/](harness-plugins/) | Per-harness plugins (plugins are Hosts in spec terms) — CraftBot, OpenClaw, Hermes, dsh |
| [skills/](skills/) | Framework skills per the pinned skill contract (creator, modify, importer, operator, walk-verify, connect) |
| [sdks/](sdks/) | Protocol client SDKs (TypeScript first, Python next) |
| [apps/](apps/) | The runnable playground Agent App |

## Getting started

> **v0.1 is not yet published to npm/PyPI.** Once published, `npm i -g agent-app` installs one package carrying both binaries. From source: `pnpm install && pnpm -r build && pnpm -r test`, then invoke the entries directly — `node framework/cli/dist/agent-app.js …` and `node framework/cli/dist/a2app.js …`.

The normative machine contracts are the JSON Schemas in [spec/](spec/), and the [conformance/](conformance/) suite is how an implementation proves it conforms. Each area documents itself: [framework/](framework/) (the `agent-app` and `a2app` CLIs), [adapters/](adapters/) (the A2App adapter layers), [toolkits/](toolkits/) (blueprints), [skills/](skills/) (the agent-facing method), and [apps/playground/](apps/playground/) (a runnable example app). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

> **Security:** v0.1 is **loopback-trust only** — do not expose an Agent App to a network.

## Status

**v0.1 — foundation.** Moving toward 1.0-stable. The TypeScript reference implementation ships both CLIs, adapters, SDK, and conformance suite; stack choices in the blueprints are incidental and normative for nothing.

## License

[MIT](LICENSE)
