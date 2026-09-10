# Framework reference implementation (TypeScript)

Implements the Agent App Framework: the framework CLI (enforcement) and an optional reference host. Skills (knowledge) live in [../skills/](../skills/). Toolkits are deliberately NOT here — see [../toolkits/](../toolkits/).

| Package | npm name | Purpose |
|---|---|---|
| [cli/](cli/) | `agent-app` | Two binaries, one package (spec 5.1). `agent-app`: `scaffold`, `validate`, `toolkit-sync`, `adapter-sync`, `serve`/`stop`, `list`, `global`, `skills`, plus safe-evolve `dev`/`promote`/`backup`/`restore` (walk-verify is a skill run by a verifier agent, not a command). `a2app`: the operate client — a WALK (`a2app <app> [<path…>] [<operation>]`), plus the reserved segments `identity`, `data`, `whoami`, `context`, `tasks`, `events`. No `ops`/`run`: an operation is found on the screen it belongs to and invoked there. Exit codes 0/1/2/3, machine-readable stdout. |
| [host/](host/) | `@a2app/host` | Optional reference host: launches apps via the manifest `pipeline` block, polls health, runs adapter-sync at every launch, and may add host features (watchdog, build supervision, receipts voice). **A bare agent plus a browser is a complete environment — nothing here is required for compliance.** |

Conformance is proven by the suite ([../conformance/](../conformance/)), never by code review.
