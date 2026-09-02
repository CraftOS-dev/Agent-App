# blueprint-python-fastapi

A Python Agent App blueprint. `agent-app create --blueprint blueprint-python-fastapi` scaffolds a FastAPI app whose A2App adapter is a dependency-free, in-process port of the served surface (identity, describe, guarded records CRUD, operations with approval, tasks/events). Not part of the pnpm workspace (Python).

Layout:

| Path | Ownership | Role |
|---|---|---|
| `main.py` | system-owned (hash-locked) | FastAPI wiring: translates HTTP ↔ the adapter's `dispatch()` |
| `a2app_adapter.py` | system-owned (hash-locked) | the served surface + pure rules (parity with `@a2app/rules`) |
| `schema.py` | agent-owned | entities, operations, operation runners, seed — edit this to evolve the app |
| `manifest.json`, `operations.json`, `AGENT_APP.md`, `reference/requirements.md` | framework files | identity, declared ops, plan, requirements |
| `.a2app/system-hashes.json` | ownership canon | which files are system-owned |

Run: `pip install -r requirements.txt` then `uvicorn main:app --port $PORT`. The in-memory store is a starter — swap `Store` for a database without touching the served surface or the rules.
