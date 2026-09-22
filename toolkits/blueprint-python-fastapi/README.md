# blueprint-python-fastapi

A Python Agent App blueprint. `agent-app <dir> scaffold --blueprint blueprint-python-fastapi` scaffolds a FastAPI + SQLite app whose A2App adapter is a dependency-free, in-process port of the served surface (identity, describe, guarded records CRUD, operations with approval, tasks/events). Records persist in SQLite via the stdlib `sqlite3` module — the stack needs nothing beyond FastAPI itself. Not part of the pnpm workspace (Python).

Layout:

| Path | Ownership | Role |
|---|---|---|
| `main.py` | system-owned (hash-locked) | FastAPI wiring: translates HTTP ↔ the adapter's `dispatch()` |
| `a2app_adapter.py` | system-owned (hash-locked) | the served surface + pure rules (parity with `@a2app/rules`) + the SQLite store |
| `schema.py` | agent-owned | entities, operations, operation runners, seed — edit this to evolve the app |
| `scripts/promote_apply.py` | lifecycle | run by `agent-app promote` after the mandatory backup; refuses to orphan an entity that still holds data |
| `manifest.json`, `operations.json`, `AGENT_APP.md`, `reference/requirements.md` | framework files | identity, declared ops, plan, requirements |
| `.a2app/system-hashes.json` | ownership canon | which files are system-owned |

Run: `pip install -r requirements.txt` then `python main.py` (its `__main__` block binds uvicorn to the environment's `PORT`; records land in `data/db.sqlite`, or under `A2APP_DATA_DIR` when the framework launches it). The store interface is small — swap `SqliteStore` for another database without touching the served surface or the rules.
