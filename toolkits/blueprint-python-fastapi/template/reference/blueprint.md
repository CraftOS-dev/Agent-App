# Blueprint reference — python-fastapi

A FastAPI backend + a SQLite store, whose A2App adapter is a dependency-free,
in-process Python port of the served surface (identity, describe, guarded
records CRUD, operations with approval, tasks/events). Records persist in
SQLite via the stdlib `sqlite3` module. The pure rules match `@a2app/rules`
byte-for-byte on rejections — the conformance suite is the oracle.

Where the `creator`/`modify` skill says "per your stack", the answer is here. If
this file and the source disagree, the source wins.

## Read this first

The scaffold gives you a complete, agent-operable backend — the A2App adapter and
a working data model. A human View is out of scope for this stack:

- **entities** — the data model in `schema.py` (see **Schema** below);
- **custom operations** — declared in `schema.OPERATIONS` + `operations.json` and
  implemented in `schema.OPERATION_RUNNERS` (see **Operations**);
- **the View** — this stack serves the A2App API only; `main.py` (system-owned)
  exposes `/api/**` and `/.well-known/a2app.json`, so it cannot present a browser UI.

Use this stack when an agent is the operator. If you need a human web UI, choose
`blueprint-react-node` or `blueprint-pocketbase-react` — decide before building.

## File map — who owns what

Every file that ships on a fresh scaffold, in the order you meet them:

| Path | Owner | What it is |
|---|---|---|
| `schema.py` | **YOURS** | the data model + operations: `ENTITIES`, `OPERATIONS`, `OPERATION_RUNNERS`, `SEED`. Edit this to evolve the app; `describe`/`schemaVersion` derive from it. |
| `operations.json` | **YOURS** | the operation declarations `describe` and approval read (name, module, typed params, entity, appliesWhen, flags). Mirror of `schema.OPERATIONS`. |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | ignores `data/`, credentials, framework state, `__pycache__`. Extend as needed. |
| `requirements.txt` | build | Python dependencies. Add your HTTP client (e.g. `httpx`) here when you call external APIs. |
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]`, `authMode`, `pipeline` (install/build/start/health). |
| `main.py` | SYSTEM (hash-locked) | FastAPI wiring: reads the HTTP request under a size cap and hands it to `adapter.dispatch()`; serves `/api/**` and `/.well-known/a2app.json` only. Never edit. |
| `a2app_adapter.py` | SYSTEM (hash-locked) | the adapter — served surface (identity, describe, guarded CRUD, operations, tasks/events) + the pure rules (guard, predicates, fingerprint) + the SQLite store + `--selftest`. Never edit. |
| `scripts/promote_apply.py` | lifecycle | run by `agent-app promote`: applies to live after a mandatory backup; refuses to orphan an entity that still holds data. Leave it alone. |
| `data/` | runtime | the live SQLite database (`db.sqlite`, git-ignored, created on first boot). Never edit by hand; never commit. |

SYSTEM files are hashed in `.a2app/system-hashes.json`; the gate fails the build
if one changes.

## Mental model

- The **adapter is the only agent surface.** `main.py` reads HTTP and calls
  `adapter.dispatch()`; the adapter owns the protocol.
- **`schema.py` is the single source of truth for the model.** You never
  hand-write `describe` — the adapter derives it (and `schemaVersion`) from
  `ENTITIES`/`OPERATIONS`. Change the schema, and every A2App screen updates.
- **The model is declarative and additive.** Records are JSON rows in one
  SQLite table keyed (entity, id); there are no migration files on this stack.
  Add a field to `ENTITIES` and it is simply available; existing rows keep
  their stored values. Do not look for a `migrations/` directory.

## Schema — entities & fields

Edit `schema.py`. Three module-level names drive the app:

```python
ENTITIES = {
    "<entity>": {
        "module": "<module-from-manifest>",   # REQUIRED — every entity names its module
        "summary": "one line shown beside it on the module screen",
        "fields": [
            {"name": "title", "type": "string", "required": True, "max": 200},
            {"name": "status", "type": "enum", "values": ["todo", "doing", "done"]},
            {"name": "due", "type": "string", "max": 10, "dayKey": True},   # "YYYY-MM-DD"
            {"name": "created", "type": "datetime", "readOnly": True},       # server-set
        ],
    },
}

SEED = {"<entity>": [{"id": "…", "title": "…", "created": "2026-01-01T00:00:00Z"}]}
```

**Field types** (the A2App protocol vocabulary): `string` · `number` · `boolean`
· `datetime` · `enum` (+ `values`) · `ref` (+ `entity`) · `list<enum>` ·
`list<ref>` · `json` · `binary`. Field flags: `required`, `readOnly`
(server-managed), `max`, and `dayKey: True` for a whole-day text field advertised
as `YYYY-MM-DD`.

**Seeding:** `SEED` is applied only when a boot CREATES the database file
(first live boot; every `dev` boot, since dev runs against a fresh per-boot
data directory). An existing database is never re-seeded — that would
resurrect seed records the user deleted.

## Operations — anything beyond plain CRUD

Plain CRUD needs no operation — the records API covers it. Declare an operation
in **two places that must agree**, then implement it:

1. `schema.OPERATIONS` — and the identical row in `operations.json`.
2. `schema.OPERATION_RUNNERS` — a `name -> function` map.

```python
OPERATIONS = [
    {"name": "count-tasks", "description": "Count the tasks.",
     "readOnly": True, "idempotent": True, "module": "planning", "params": {}},
    {"name": "complete-task", "description": "Mark one task done.",
     "module": "planning", "entity": "tasks",
     "appliesWhen": {"field": "status", "ne": "done"},
     "params": {"task": {"type": "ref", "entity": "tasks", "required": True}}},
]

def _complete_task(args, ctx, store):
    task = store.get_record("tasks", args.get("task"))
    if task is None:
        return {"ok": False, "reason": "no such task"}
    task["status"] = "done"
    store.put_record("tasks", task)
    return {"ok": True, "task": task["id"], "status": task["status"]}

OPERATION_RUNNERS = {"count-tasks": _count_tasks, "complete-task": _complete_task}
```

- **Runner signature:** `(args, ctx, store) -> json-able dict`. `store` is the
  live SQLite-backed store — read with `store.get_record(entity, id)` /
  `store.list_records(entity, query)`, write with `store.put_record(entity,
  record)` / `store.delete_record(entity, id)`. Writes are durable when the
  call returns. A record read from the store is a COPY: mutate it, then
  `put_record()` it back, or the change never happened.
- **`params` is REQUIRED and typed** (same vocabulary as fields); use `{}` for
  none. The record screen renders it as the signature — args described only in
  prose can neither be shown nor checked.
- **`entity`** attaches the op to a record screen; **`appliesWhen`** decides
  availability on a record and the adapter derives the blocked reason from it.
  Comparisons only — `eq`, `ne`, `in`, `notIn`, `isBlank`, composed with
  `all`/`any`/`not`. Never a natural-language rule.
- **Flags:** `destructive: True` (requires human approval), `readOnly: True`
  (no side effects), `idempotent: True` (safe to repeat).
- The gate step **"operations resolve"** fails the build if any op in
  `OPERATIONS` has no entry in `OPERATION_RUNNERS`.

## The records API (what the adapter serves)

The adapter serves the A2App records REST under `/api/`, dispatched from
`main.py`'s catch-all:

| Call | Meaning |
|---|---|
| `GET /api/collections/<entity>/records?filter=…&sort=…&page=…&perPage=…` | list (single-clause filter: `field = "v"` · `field != "v"` · `field ~ "v"`; anything richer is refused `invalid_filter`, never ignored) |
| `POST /api/collections/<entity>/records` (JSON body) | create (guard validates the raw body) |
| `PATCH /api/collections/<entity>/records/<id>` | update |
| `DELETE /api/collections/<entity>/records/<id>` | delete |
| `GET /api/_a2app` and `/api/_a2app/describe/**` | identity + describe |

Agent writes carry the agent token; same-origin browser writes are trusted by
the adapter's origin rule (`allowed_origins` in `main.py`).

## External data (third-party APIs)

Call the internet from the **backend only**. Your backend seam is the
**operation runner** — runners execute in-process and may make outbound HTTP
(e.g. `httpx`/`urllib`). Put third-party calls and secret-bearing requests there;
model an initial sync as a runner that fills the store when it is empty. Add the
HTTP client to `requirements.txt`.

## App→agent (tasks/events)

The adapter exposes the A2App **tasks/events** surface (an app→agent queue) —
this is the one blueprint that ships the primitive (`a2app_adapter.py` has a
`trigger()` method). There is **no declarative trigger manifest** in v0.1: prefer
plain code for plain events, and consult `a2app_adapter.py` directly if a feature
genuinely needs to enqueue agent work. Do not invent a manifest format.

## Build, run, gate

`manifest.json`'s `pipeline` drives everything; the app runs as `python main.py`,
whose `__main__` block binds uvicorn to the environment's `PORT`. Never start a
server by hand. (The start command reads `PORT` from the environment rather than
interpolating `${PORT}` in the shell, so it is portable to cmd.exe on Windows.)

```bash
agent-app <dir> dev        # boot the candidate on a hidden port: fresh per-boot SQLite store re-seeded from empty, prints the dev URL
agent-app <dir> validate   # framework files → build → python syntax + adapter self-test → operations resolve → ownership canon → describe budget (on dev)
agent-app <dir> serve      # launch LIVE as a managed, health-polled background process; prints the URL
agent-app <dir> promote    # requires the gate pass; backup, scripts/promote_apply.py, destroys the dev instance
```

**Environments (one tree, redirected inputs).** `main.py` reads `PORT` and
`A2APP_DATA_DIR` from the framework. The dev instance runs against a
disposable per-boot SQLite database (a fresh directory means a fresh file
means a fresh seed); the LIVE database lives in `data/db.sqlite` — what
`backup`, `restore` and the mandatory pre-promote backup protect.

Toolkit gate steps (from `a2app.toolkit.json`): **"python syntax + adapter
self-test"** (`python -m py_compile … && python a2app_adapter.py --selftest` —
the selftest covers the rules parity AND the SQLite store: durability across a
reopen, seed-once, idempotency keys, the filter grammar) and **"operations
resolve"**. `lifecycle.dataDir` is `data/`; `lifecycle.promote` is
`python scripts/promote_apply.py`.

## Footguns for this stack

- **Two files, one truth.** Every operation lives in BOTH `schema.OPERATIONS` and
  `operations.json`, agreeing on name/module/params/flags. The gate fails a
  mismatch.
- **`put_record()` or it never happened.** A record read from the store is a
  copy; a runner that mutates it without `store.put_record()` returns success
  while storing nothing.
- **Schema is declarative; the UI seam is closed.** Evolve the model by editing
  `ENTITIES` — there is no `migrations/` directory to look for. `main.py` serves
  only the API, so this stack cannot present a browser UI; build one on
  `blueprint-react-node` or `blueprint-pocketbase-react` instead. See **Read this
  first** above.
- **Empty-store first responses.** A fresh app has no records — describe and any
  load path must succeed against an empty store.
