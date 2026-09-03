# blueprint-base — stack-agnostic

The framework contract with **no runtime code**: what an agent uses to hand-assemble an Agent App in any stack. `agent-app <dir> scaffold --blueprint blueprint-base` writes the framework files, ready to fill in:

```
manifest.json          # id, name, versions, authMode, capabilities, and the pipeline launch block
operations.json        # declared operations
AGENT_APP.md           # the agent-facing index: Plan / Entities / Operations / Conventions / Checklist
reference/requirements.md  # the app's binding spec: Overview / Features / Data / Design / Operations / Quality of life
```

The adapter itself comes from [../../adapters/adapter-starter/](../../adapters/adapter-starter/) (in-process or middleware form) — this blueprint gives the framework files; the agent picks the stack, wires the adapter, and reaches conformance.
