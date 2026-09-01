# deepseek-harness (dsh) integration

Cordis plugin bundle with two halves: host (registers A2App tools on `ctx.tools`, supervises app backends via `ctx.jobs`, honors fail-closed `ctx.approval`) and client (`dsh.client` React slot panel iframing the app's local URL, modeled on `ui-cordis`). Skills into `~/.agents/skills/` are mandatory for headless/sdk/acp profiles. Plan: [research/harness-hermes-deepseek.md](../../research/harness-hermes-deepseek.md).
