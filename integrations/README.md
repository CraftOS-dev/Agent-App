# Harness Integrations

Per-harness **plugins** for deep integration: embedded display of Agent Apps inside the harness UI, registered agent tools wrapping the `a2app` CLI, harness CLI subcommands, and deterministic deploy/load/validate. Harnesses without a plugin use [../skills/](../skills/) (universal fallback — app opens in the browser).

Both distributions are generated from one source; manifests carry no secrets.

| Directory | Harness | Integration surface |
|---|---|---|
| [integration-starter/](integration-starter/) | — | Copy-to-create template for a new harness plugin |
| [craftbot/](craftbot/) | [CraftBot](https://github.com/CraftOS-dev/CraftBot) | Tools wrapping the `a2app` CLI + skills + embedded app display in CraftBot's iframe pool |
| [openclaw/](openclaw/) | openclaw | Plugin (`openclaw.plugin.json`): tools + CLI subcommands + Control-UI tab (sandboxed iframe) + supervising service |
| [hermes/](hermes/) | hermes-agent | Plugin (`plugin.yaml` + `register(ctx)`): tools + dashboard tab + desktop preview pane + cron |
| [dsh/](dsh/) | deepseek-harness | Cordis bundle, host+client halves: `ctx.tools`/`ctx.jobs` + React slot panel; skills mandatory for headless profiles |

Constraints all plugins honor: deploy/load/validate idempotent (harnesses retry); app backends tolerate workspace-write OS sandboxing and loopback-only serving; embedded display goes through the harness's authenticated proxied routes where required.
