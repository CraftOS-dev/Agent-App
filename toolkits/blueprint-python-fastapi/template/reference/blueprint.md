# Blueprint reference — python-fastapi

A FastAPI backend whose A2App adapter is a dependency-free, in-process Python
port of the served surface (identity, describe, guarded records CRUD, operations
with approval, tasks/events). The pure rules match `@a2app/rules` byte-for-byte
on rejections — the conformance suite is the oracle.

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
| `a2app_adapter.py` | SYSTEM (hash-locked) | the adapter — served surface (identity, describe, guarded CRUD, operations, tasks/events) + the pure rules (guard, predicates, fingerprint) + `--selftest`. Never edit. |
| `data/` | runtime | the live store (git-ignored, created on first boot). Never commit. |

SYSTEM files are hashed in `.a2app/system-hashes.json`; the gate fails the build
if one changes.

## Mental model

- The **adapter is the only agent surface.** `main.py` reads HTTP and calls
  `adapter.dispatch()`; the adapter owns the protocol.
- **`schema.py` is the single source of truth for the model.** You never
  hand-write `describe` — the adapter derives it (and `schemaVersion`) from
  `ENTITIES`/`OPERATIONS`. Change the schema, and every A2App screen updates.
- **The model is declarative and additive.** There are no migration files on this
  stack. Add a field to `ENTITIES` and it is simply available. Do not look for a
  `migrations/` directory.

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

**Seeding:** `SEED` is applied when the store is built fresh. Seeded data
survives a fresh build; runtime test data does not.

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
    task = store.rows.get("tasks", {}).get(args.get("task"))
    if task is None:
        return {"ok": False, "reason": "no such task"}
    task["status"] = "done"
    store.persist()
    return {"ok": True, "task": task["id"], "status": task["status"]}

OPERATION_RUNNERS = {"count-tasks": _count_tasks, "complete-task": _complete_task}
```

- **Runner signature:** `(args, ctx, store) -> json-able dict`. `store.rows` is
  the live data (`store.rows["<entity>"][id]`); call `store.persist()` after any
  mutation.
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
| `GET /api/collections/<entity>/records?filter=…&sort=…&page=…&perPage=…` | list |
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

**This blueprint supports them.** `a2app_adapter.py` carries the primitive:

```python
adapter.trigger("invoice.needs_review", {"invoice": rec["id"]}, capability="review")
```

`trigger(etype, payload, capability=None)` emits the event and, when a
capability is named, puts a task on the app's queue; it returns
`{"eventId": ..., "taskId": ...}`. Without a capability it only announces
something — nothing is queued and no agent is handed it.

- **Send ids, not prose or copies.** The agent re-reads the record itself, so a
  copy is stale by the time it is read, and prose in a payload is an instruction
  the app does not get to give: on the agent's side it is fenced and labelled as
  data.
- There is **no declarative trigger manifest**, and none is coming — what the
  agent does is the agent's decision, which is what keeps a compromised app from
  steering it. Do not invent a manifest format.
- Prefer plain code for plain events. A task is for work a person would
  otherwise have to think about, and it must be idempotent: a task can be
  redelivered if an agent dies holding it.

The queue only moves when something is listening: `agent-app <dir> bridge start`,
or a harness polling `a2app <dir> tasks next --wait`.

## Build, run, gate

`manifest.json`'s `pipeline` drives everything; the app runs as `python main.py`,
whose `__main__` block binds uvicorn to the environment's `PORT`. Never start a
server by hand. (The start command reads `PORT` from the environment rather than
interpolating `${PORT}` in the shell, so it is portable to cmd.exe on Windows.)

```bash
agent-app <dir> dev        # boot the candidate on a hidden port; the store is in-memory, so every boot is a fresh seed
agent-app <dir> validate   # framework files → build → python syntax + adapter self-test → operations resolve → ownership canon → describe budget (on dev)
agent-app <dir> serve      # launch LIVE as a managed, health-polled background process; prints the URL
```

**Stack limitation — no persistence, no promote.** This blueprint's `Store` is
in-memory: records vanish at process exit, `lifecycle.dataDir` is never
written, and the toolkit declares no `lifecycle.promote` — so `promote`,
`backup` and `restore` refuse on this stack. Record it in the spec as a known
limitation; an app that needs durable data belongs on a persistent blueprint.

Toolkit gate steps (from `a2app.toolkit.json`): **"python syntax + adapter
self-test"** (`python -m py_compile … && python a2app_adapter.py --selftest`) and
**"operations resolve"**. `lifecycle.dataDir` is `data/`.

## Footguns for this stack

- **Two files, one truth.** Every operation lives in BOTH `schema.OPERATIONS` and
  `operations.json`, agreeing on name/module/params/flags. The gate fails a
  mismatch.
- **`store.persist()` or it never happened.** A runner that mutates `store.rows`
  without persisting returns success while storing nothing.
- **Schema is declarative; the UI seam is closed.** Evolve the model by editing
  `ENTITIES` — there is no `migrations/` directory to look for. `main.py` serves
  only the API, so this stack cannot present a browser UI; build one on
  `blueprint-react-node` or `blueprint-pocketbase-react` instead. See **Read this
  first** above.
- **Empty-store first responses.** A fresh app has no records — describe and any
  load path must succeed against an empty store.
