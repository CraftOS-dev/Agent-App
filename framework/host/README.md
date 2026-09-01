# @a2app/host — optional reference host

A Host is optional supervisor software: **nothing here is required for framework compliance** — a bare agent plus a browser is a complete environment. This package is the reference host for users who want supervised launching and the safe-evolve machinery.

Responsibilities:

- **Launch contract**: run the manifest `pipeline` commands (`install`/`build`/`start`), poll `health`; adapter-sync at every launch (the only path that reaches apps users already have); ensure credentials at launch.
- **Safe-evolve**: dev copy on a hidden port with fresh migration-replayed DB; pre-promote backup; structural first-vs-update detection; restore with capture-first + auto-rollback.
- **Host features**: crash watchdog, build supervision/state machine, live build view, session management.
- **Host security obligations**: receipts, false-claim gate, approval UI, capability consent at install, credential hygiene.
- **Conformance (Host artifact class)**: launches via the pipeline block only; never edits agent-owned or system-owned files.

Design rule: split responsibilities per module, no god-objects.
