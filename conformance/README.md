# Conformance

Runnable suites: language-agnostic YAML cases plus thin per-language harnesses. Suites assert outputs AND error behavior (`code`, all-violations), and every payload validates against `spec/v0_1/schema/`.

## A2App protocol classes

| Class | Covers |
|---|---|
| **A: Core** | discovery, describe, HTTP binding, guard, idempotency, read-back, receipts, security, IAM, errors — **required for a stable release**; skipping a class-A check fails class A |
| **B: CLI** | A + the CLI binding (exit codes, coercion, envelope passthrough) |
| **C: Bidirectional** | B (or A) + events, tasks (full lifecycle incl. cancel + sweeper redelivery), verbs, context |

## Framework artifact classes

| Class | Must hold |
|---|---|
| **Agent App** | framework files valid; adapter passes class A; gate passes; canon verifies; walk-verify pass on record |
| **Toolkit** | scaffolds to a conforming Agent App; system files in canon; sync command provided |
| **Host** | launches via pipeline block only; adapter-sync every launch; host obligations; never edits agent- or system-owned files |
| **Agent** | none — deliberately. Any agent that reads files, runs a CLI, and speaks HTTP participates |

The suite is also how the TypeScript implementation proves parity, and how the safe-evolve lifecycle semantics (fresh-DB replay, pre-promote backup, restore rollback) are verified.
