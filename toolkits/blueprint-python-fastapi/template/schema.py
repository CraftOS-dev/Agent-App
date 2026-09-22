"""The app's data model + operations (AGENT-OWNED — edit this to evolve the app).

Fields use the A2App protocol type vocabulary. `describe` and `schemaVersion`
are DERIVED from this by the adapter, so an agent always sees the live model.

MODULES COME FIRST. Every entity names the module it lives in, and every
operation names the module it appears under; modules themselves are declared in
`manifest.json`. That is what gives describe a root screen to serve and keeps
discovery bounded however large the app grows — an entity or operation outside
every module has no screen and cannot be reached by walking.
"""

ENTITIES = {
    "tasks": {
        "module": "planning",
        "summary": "what needs doing, and what is done",
        "fields": [
            {"name": "title", "type": "string", "required": True, "max": 200},
            {"name": "status", "type": "enum", "values": ["todo", "doing", "done"]},
            {"name": "due", "type": "string", "max": 10, "dayKey": True},
            {"name": "notes", "type": "string", "max": 2000},
            {"name": "created", "type": "datetime", "readOnly": True},
        ],
    },
}

# `params` is REQUIRED and typed — the record screen renders it as the
# operation's signature, so arguments described only in prose can neither be
# shown nor checked. Declare {} for an operation that takes none.
#
# `entity` attaches an operation to a record screen; `appliesWhen` decides
# whether it is available on a given record, and the adapter derives the
# "blocked" reason from it. Comparisons only — never a natural-language rule.
OPERATIONS = [
    {
        "name": "count-tasks",
        "description": "Count the tasks.",
        "destructive": False,
        "readOnly": True,
        "idempotent": True,
        "module": "planning",
        "params": {},
    },
    {
        "name": "complete-task",
        "description": "Mark one task done.",
        "destructive": False,
        "module": "planning",
        "entity": "tasks",
        "appliesWhen": {"field": "status", "ne": "done"},
        "params": {"task": {"type": "ref", "entity": "tasks", "required": True}},
    },
]


# Operation runners: (args, ctx, store) -> JSON-able result. The adapter calls
# these for a declared operation; a destructive op is gated by approval first.
# `store` is the live SQLite-backed store — read with store.get_record /
# store.list_records, write with store.put_record / store.delete_record.
# Writes are durable when the call returns. A record read from the store is a
# COPY: mutate it, then put_record() it back, or the change never happened.
def _count_tasks(args, ctx, store):
    return {"count": store.list_records("tasks", {})["totalItems"]}


def _complete_task(args, ctx, store):
    task = store.get_record("tasks", args.get("task"))
    if task is None:
        return {"ok": False, "reason": "no such task"}
    task["status"] = "done"
    store.put_record("tasks", task)
    return {"ok": True, "task": task["id"], "status": task["status"]}


OPERATION_RUNNERS = {
    "count-tasks": _count_tasks,
    "complete-task": _complete_task,
}

SEED = {
    "tasks": [{"id": "task_welcome", "title": "Welcome — edit or delete me", "status": "todo", "created": "2026-01-01T00:00:00Z"}],
}
