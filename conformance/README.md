# Conformance

Runnable suites: language-agnostic YAML cases plus thin per-language harnesses. Suites assert outputs AND error behavior (`code`, all-violations), and every payload validates against `spec/v0_1/schema/`.

## A2App protocol classes

| Class | Covers |
|---|---|
| **A: Core** | discovery, describe, HTTP binding, guard, idempotency, read-back, receipts, security, IAM, errors — **required for a stable release**; skipping a class-A check fails class A |
| **B: CLI** | A + the `a2app` operate-client binding (exit codes, coercion, envelope passthrough) |
| **C: Bidirectional** | B (or A) + events, tasks (full lifecycle incl. cancel + sweeper redelivery), the CLI's listen primitive (`tasks next`: claims the next task; an idle queue is exit 0 with no task, never an error), verbs, context |

## Framework artifact classes

| Class | Must hold |
|---|---|
| **Agent App** | framework files valid; adapter passes class A; gate passes; canon verifies; walk-verify pass on record |
| **Toolkit** | scaffolds to a conforming Agent App; system files in canon; sync command provided |
| **Host** | launches via pipeline block only; adapter-sync every launch; host obligations; never edits agent- or system-owned files |
| **Agent** | none — deliberately. Any agent that reads files, runs a CLI, and speaks HTTP participates |

The suite is also how the TypeScript implementation proves parity, and how the safe-evolve lifecycle semantics are verified: the harness's **Safe-evolve** class drives the real `agent-app`/`a2app` CLIs over a scaffolded runnable blueprint — dev instance on a hidden port with a fresh replayed DB, live data untouched, operate traffic routed to the candidate, the validate→promote gate pass (including refusal after a post-validate edit), mandatory pre-promote backup, dev destruction on promote, and restore's capture-first contract (framework spec 7.2).
