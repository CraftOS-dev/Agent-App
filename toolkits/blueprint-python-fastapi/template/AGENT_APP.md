# FastAPI Agent App

## Plan
A to-do app on FastAPI with a native Python A2App adapter (`a2app_adapter.py`).
The adapter ports the pure guard rules to Python; parity with every other stack
is proven by the conformance suite, not by inspection. Evolve the app by editing
`schema.py` (Model) — never `a2app_adapter.py` or `main.py` (system-owned).

## Entities
- **tasks** — title (string, required), status (todo/doing/done), due (day key),
 notes (string), created (datetime, read-only).

## Operations
- **count-tasks** — count tasks. `readOnly`, `idempotent`.

## Conventions
- The adapter is the only agent surface; the guard validates the raw body before
 any coercion.
- Add an entity by extending `ENTITIES` in `schema.py`; describe/schemaVersion
 update automatically.

## Checklist
- [x] tasks entity + guarded CRUD
- [x] Python rules parity self-test (`python a2app_adapter.py --selftest`)
- [ ] your next feature
