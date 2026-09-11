# CraftBot actions

CraftBot is Agent-App-native and registers agent tools as **actions** via the `@action` decorator (from `agent_core`). This module defines 11 `@action`-decorated Python functions that build and operate Agent Apps by shelling the framework CLIs; importing it registers them in CraftBot's `ActionRegistry` under the `agent_app` action set.

- **Code:** [__init__.py](__init__.py) — `@action(name=, description=, input_schema=, output_schema=, action_sets=["agent_app"])` on `def fn(input_data: dict) -> dict`, each returning `{ status, output, exit_code }`.

Loaded inside CraftBot, which provides `agent_core`. Set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`); a `…/cli.js` entry is run with Node. No shell is used, so field values can't inject.
