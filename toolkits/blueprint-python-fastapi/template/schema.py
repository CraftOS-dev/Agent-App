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
            # The queue task an agent is (or was last) working on for this
            # record. The runner sets it, so a View added later can follow it
            # and show the work until it is done.
            {"name": "agentTask", "type": "string", "max": 64, "readOnly": True},
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
    {
        "name": "request-triage",
        "description": "Ask an agent to work out what this task actually needs.",
        "destructive": False,
        "module": "planning",
        "entity": "tasks",
        "appliesWhen": {"field": "status", "ne": "done"},
        "params": {"task": {"type": "ref", "entity": "tasks", "required": True}},
    },
]

# The event types this app may emit (the app->agent direction). Declaring a
# type is what lets `store.trigger` fire it — an undeclared type is refused —
# so this list is the fixed set of things the app can ever ask an agent to
# react to, decided here by its author rather than at the moment of firing.
#
# Leave it empty until a feature genuinely needs agent judgment. Plain events
# want plain code; a task is for work a person would otherwise have to think
# about.
EVENTS = [{"type": "task.needs_triage"}]


# Operation runners: (args, ctx, store) -> JSON-able result. The adapter calls
# these for a declared operation; a destructive op is gated by approval first.
# `store` is the live SQLite-backed store — read with store.get_record /
# store.list_records, write with store.put_record / store.delete_record.
# Writes are durable when the call returns. A record read from the store is a
# COPY: mutate it, then put_record() it back, or the change never happened.
# store.trigger(type, payload, capability=None) emits a declared event (see
# `request-triage` below).
def _count_tasks(args, ctx, store):
    return {"count": store.list_records("tasks", {})["totalItems"]}


def _complete_task(args, ctx, store):
    task = store.get_record("tasks", args.get("task"))
    if task is None:
        return {"ok": False, "reason": "no such task"}
    task["status"] = "done"
    store.put_record("tasks", task)
    return {"ok": True, "task": task["id"], "status": task["status"]}


# The app->agent direction, in full. `store.trigger` emits a DECLARED event and,
# because a capability is named, queues a task on the app's own queue. From
# there an agent takes it — either because a harness is polling
# (`a2app <app> tasks next --wait`) or because `agent-app <app> bridge` is
# running and triggers one.
#
# Send IDS, not prose. The agent re-reads the record itself, so what goes in the
# payload is what it needs to find the work — never instructions, and never a
# copy of the data, which would be stale by the time it is read. Nothing here
# can widen what the agent may do: the payload is data on the other side, and
# the capability names the kind of work, not a command to run.
#
# Identical triggers dedupe to ONE task, even after it has finished, so asking
# again with the same payload would hand back the old failure. Naming the
# previous task makes each request a new occurrence.
def _request_triage(args, ctx, store):
    task = store.get_record("tasks", args.get("task"))
    if task is None:
        return {"ok": False, "reason": "no such task"}
    payload = {"task": task["id"]}
    if task.get("agentTask"):
        payload["previous"] = task["agentTask"]
    fired = store.trigger("task.needs_triage", payload, capability="triage")
    task["agentTask"] = fired["taskId"]
    store.put_record("tasks", task)
    return {"ok": True, "task": task["id"], "queued": fired["taskId"]}


OPERATION_RUNNERS = {
    "count-tasks": _count_tasks,
    "complete-task": _complete_task,
    "request-triage": _request_triage,
}

SEED = {
    "tasks": [{"id": "task_welcome", "title": "Welcome — edit or delete me", "status": "todo", "created": "2026-01-01T00:00:00Z"}],
}
