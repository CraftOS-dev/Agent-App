# Framework reference implementation (TypeScript)

Implements the Agent App Framework: the framework CLI (enforcement) and an optional reference host. Skills (knowledge) live in [../skills/](../skills/). Toolkits are deliberately NOT here — see [../toolkits/](../toolkits/).

| Package | npm name | Purpose |
|---|---|---|
| [cli/](cli/) | `a2app` | The framework CLI: `create`, `validate`, `toolkit-sync`, `adapter-sync`, `data`, `walk-verify`, plus safe-evolve verbs `dev`/`promote`/`backup`/`restore`. Exit codes 0/1/2/3, machine-readable stdout. |
| [host/](host/) | `@a2app/host` | Optional reference host: launches apps via the manifest `pipeline` block, polls health, runs adapter-sync at every launch, and may add host features (watchdog, build supervision, receipts voice). **A bare agent plus a browser is a complete environment — nothing here is required for compliance.** |

Conformance is proven by the suite ([../conformance/](../conformance/)), never by code review.
