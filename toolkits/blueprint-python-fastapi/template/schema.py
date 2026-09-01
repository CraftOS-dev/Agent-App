"""The app's data model + operations (AGENT-OWNED — edit this to evolve the app).

Fields use the A2App protocol type vocabulary. `describe` and `schemaVersion`
are DERIVED from this by the adapter, so an agent always sees the live model.
"""

ENTITIES = {
    "tasks": {
        "fields": [
            {"name": "title", "type": "string", "required": True, "max": 200},
            {"name": "status", "type": "enum", "values": ["todo", "doing", "done"]},
            {"name": "due", "type": "string", "max": 10, "dayKey": True},
            {"name": "notes", "type": "string", "max": 2000},
            {"name": "created", "type": "datetime", "readOnly": True},
        ],
    },
}

OPERATIONS = [
    {"name": "count-tasks", "description": "Count the tasks.", "destructive": False, "readOnly": True, "idempotent": True},
]


# Operation runners: (args, ctx, store) -> JSON-able result. The adapter calls
# these for a declared operation; a destructive op is gated by approval first.
def _count_tasks(args, ctx, store):
    return {"count": len(store.rows.get("tasks", {}))}


OPERATION_RUNNERS = {
    "count-tasks": _count_tasks,
}

SEED = {
    "tasks": [{"id": "task_welcome", "title": "Welcome — edit or delete me", "status": "todo", "created": "2026-01-01T00:00:00Z"}],
}
