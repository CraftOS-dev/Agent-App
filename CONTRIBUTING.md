# Contributing

Thanks for your interest. This repo is the reference implementation of the Agent
App Framework and the A2App protocol (v0.1). It is a spec-first, pnpm TypeScript
monorepo; the [conformance suite](conformance/) is the source of truth for
behavior, not code review.

## Prerequisites
- Node ≥ 20, pnpm 9 (`corepack enable`)
- Python ≥ 3.9 (only for the Python SDK)

## Set up & verify (from source)
```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test            # runs the conformance suite (classes A/B/C + Toolkit)
```
Run the conformance suite alone: `pnpm --filter @a2app/conformance test`.

## Try it
```bash
# scaffold and gate an app from a blueprint:
node framework/cli/dist/cli.js create ./my-app --blueprint blueprint-react-node
node framework/cli/dist/cli.js validate ./my-app --no-build
# a live example app + boot test:
pnpm --filter @a2app/playground test
```
See [docs/getting-started.md](docs/getting-started.md) and
[docs/architecture.md](docs/architecture.md).

## Ground rules
- **Spec + schema move together.** The JSON Schemas in `spec/v0_1/schema/` are the
  machine contract and win over prose. Change both, and add a conformance check.
- **A change is proven by the conformance suite**, not by assertion. New protocol
  behavior needs a suite entry; new framework behavior needs a test.
- **Respect the layering.** `@a2app/rules` is pure (no I/O). Adapters implement a
  `Binding`; they never fork the rules. Toolkits are NOT part of the framework —
  nothing in `framework/` may require one. Hosts are optional.
- **No secrets** in code, manifests, skills, toolkits, or examples. Credentials
  are runtime artifacts, never committed.
- Keep every package green: `pnpm -r build && pnpm -r typecheck && pnpm -r test`.

## PRs
Small, focused PRs with tests. Describe the behavior change and point at the
conformance/test coverage that proves it. CI (build · typecheck · test ·
conformance · Python · npm pack) must be green.
