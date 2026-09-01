# Hermes plugin

A real Hermes plugin. Hermes plugins are **Python**: a `plugin.yaml` manifest plus an `__init__.py` with `register(ctx)` that calls `ctx.register_tool(...)`. This plugin registers 11 tools that build and operate Agent Apps by shelling the `a2app` CLI.

- **Manifest:** [plugin.yaml](plugin.yaml) — `kind: backend`, `provides_tools: [...]`.
- **Code:** [__init__.py](__init__.py) — `register(ctx)` → `ctx.register_tool(name=, toolset="agent_app", schema=, handler=, emoji=)`; handlers return the CLI output (a guard rejection is returned to the model, not swallowed).

Drop this directory into `~/.hermes/plugins/`. Set `A2APP_CLI` to point at the `a2app` binary (default `a2app`); a `…/cli.js` entry is run with Node. No shell is used, so field values can't inject.

**Verified:** the plugin registers 11 tools and its handlers drive the real CLI — `agent_app_build` scaffolds an app and `agent_app_validate` runs the real gate (framework files + Python self-test + ownership all pass).
