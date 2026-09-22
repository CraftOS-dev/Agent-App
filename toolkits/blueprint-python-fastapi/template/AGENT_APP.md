# FastAPI Agent App

## Plan
A to-do app on FastAPI with a SQLite store and a native Python A2App adapter
(`a2app_adapter.py`). The adapter ports the pure guard rules to Python; parity
with every other stack is proven by the conformance suite, not by inspection.
Records persist in `data/db.sqlite` (stdlib `sqlite3` — no extra dependency).
Evolve the app by editing `schema.py` (Model) — never `a2app_adapter.py` or
`main.py` (system-owned).

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. They are declared in
`manifest.json`; each entity names its module in `schema.py`.
- **planning** — tasks and the work in front of you.

## Entities
- **tasks** — title (string, required), status (todo/doing/done), due (day key),
 notes (string), created (datetime, read-only).

## Operations
- **count-tasks** — count tasks. `readOnly`, `idempotent`.

## Conventions
- The adapter is the only agent surface; the guard validates the raw body before
 any coercion.
- Add an entity by extending `ENTITIES` in `schema.py`; describe/schemaVersion
 update automatically. The store is schema-derived and additive — no
 migrations directory on this stack.
- Operation runners read/write through the store API (`get_record` /
 `list_records` / `put_record` / `delete_record`); writes are durable when the
 call returns, and a record read out is a copy — `put_record()` it back after
 mutating.

## Checklist
Build and evolve tasks live in `reference/tasks.md` - one home. This section
points there.
