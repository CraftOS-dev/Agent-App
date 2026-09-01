"""Agent App Framework actions for CraftBot.

CraftBot is Agent-App-native and registers agent tools as **actions** via the
`@action` decorator (importing this module registers them in CraftBot's
ActionRegistry). These actions build and operate Agent Apps by shelling the
`a2app` CLI, so anything an agent does over the A2App protocol, CraftBot can do
as an action. Loaded inside CraftBot, which provides `agent_core` (the
`@action` decorator). Set `A2APP_CLI` to override the binary (default: `a2app`).
"""
import json
import os
import subprocess

from agent_core import action  # provided by CraftBot's runtime

CLI = os.environ.get("A2APP_CLI", "a2app")

_OUT = {
    "status": {"type": "string", "example": "success", "description": "'success' or 'error' (mirrors the CLI exit code)."},
    "output": {"type": "string", "description": "The CLI output verbatim (a guard rejection message is returned here)."},
    "exit_code": {"type": "integer", "description": "0 success · 1 rejected · 2 usage · 3 unreachable."},
}
_DIR = {"type": "string", "example": "./my-app", "description": "Agent App project directory."}
_ENTITY = {"type": "string", "example": "contacts", "description": "Entity / collection name."}


def _run(argv: list) -> dict:
    cmd = ["node", CLI, *argv] if CLI.endswith((".js", ".mjs", ".cjs")) else [CLI, *argv]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        return {"status": "error", "output": f"a2app CLI not found (looked for {CLI!r}).", "exit_code": 3}
    output = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return {"status": "success" if proc.returncode == 0 else "error", "output": output or f"(exit {proc.returncode})", "exit_code": proc.returncode}


@action(
    name="agent_app_describe",
    description="Read an Agent App's entities, fields, and declared operations.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR}, output_schema=_OUT,
)
def agent_app_describe(input_data: dict) -> dict:
    return _run(["data", str(input_data["dir"]), "schema"])


@action(
    name="agent_app_list",
    description="List records of an entity (optional filter/sort/limit).",
    mode="CLI", action_sets=["agent_app"],
    input_schema={
        "dir": _DIR, "entity": _ENTITY,
        "filter": {"type": "string", "description": "Filter expression (backend grammar)."},
        "sort": {"type": "string", "description": "Sort field, prefix '-' for descending."},
        "limit": {"type": "integer", "description": "Max rows."},
    },
    output_schema=_OUT,
)
def agent_app_list(input_data: dict) -> dict:
    a = ["data", str(input_data["dir"]), str(input_data["entity"]), "list"]
    if input_data.get("filter"):
        a += ["--filter", str(input_data["filter"])]
    if input_data.get("sort"):
        a += ["--sort", str(input_data["sort"])]
    if input_data.get("limit") is not None:
        a += ["--limit", str(input_data["limit"])]
    return _run(a)


@action(
    name="agent_app_get",
    description="Fetch one record by id.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}},
    output_schema=_OUT,
)
def agent_app_get(input_data: dict) -> dict:
    return _run(["data", str(input_data["dir"]), str(input_data["entity"]), "get", str(input_data["id"])])


@action(
    name="agent_app_create",
    description="Create a record; the app's guard validates it and rejections are returned verbatim.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "fields": {"type": "object", "description": "field → value map."}},
    output_schema=_OUT,
)
def agent_app_create(input_data: dict) -> dict:
    return _run(["data", str(input_data["dir"]), str(input_data["entity"]), "create", "--json", json.dumps(input_data.get("fields") or {})])


@action(
    name="agent_app_update",
    description="Update a record by id.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}, "fields": {"type": "object", "description": "field → value map."}},
    output_schema=_OUT,
)
def agent_app_update(input_data: dict) -> dict:
    return _run(["data", str(input_data["dir"]), str(input_data["entity"]), "update", str(input_data["id"]), "--json", json.dumps(input_data.get("fields") or {})])


@action(
    name="agent_app_delete",
    description="Delete a record by id.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}},
    output_schema=_OUT,
)
def agent_app_delete(input_data: dict) -> dict:
    return _run(["data", str(input_data["dir"]), str(input_data["entity"]), "delete", str(input_data["id"])])


@action(
    name="agent_app_operations",
    description="List the app's declared operations.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR}, output_schema=_OUT,
)
def agent_app_operations(input_data: dict) -> dict:
    return _run(["ops", str(input_data["dir"])])


@action(
    name="agent_app_run_operation",
    description="Invoke a declared operation. A destructive op returns approval_required with a key; pass 'approve' to execute.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "operation": {"type": "string", "description": "Operation name."}, "fields": {"type": "object", "description": "Operation arguments."}, "approve": {"type": "string", "description": "Approval key from a prior call."}},
    output_schema=_OUT,
)
def agent_app_run_operation(input_data: dict) -> dict:
    a = ["run", str(input_data["dir"]), str(input_data["operation"])]
    for key, value in (input_data.get("fields") or {}).items():
        a += [f"--{key}", str(value)]
    if input_data.get("approve"):
        a += ["--approve", str(input_data["approve"])]
    return _run(a)


@action(
    name="agent_app_poll_tasks",
    description="Poll the app-to-agent task queue (default status: submitted).",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR, "status": {"type": "string", "description": "Status filter, e.g. submitted."}},
    output_schema=_OUT,
)
def agent_app_poll_tasks(input_data: dict) -> dict:
    if input_data.get("status"):
        return _run(["tasks", str(input_data["dir"]), "--status", str(input_data["status"])])
    return _run(["tasks", str(input_data["dir"])])


@action(
    name="agent_app_build",
    description="Scaffold a new Agent App from a blueprint (framework files + ownership canon).",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "blueprint": {"type": "string", "description": "Blueprint id, e.g. blueprint-react-node."}, "name": {"type": "string", "description": "App name."}},
    output_schema=_OUT,
)
def agent_app_build(input_data: dict) -> dict:
    a = ["create", str(input_data["dir"])]
    if input_data.get("blueprint"):
        a += ["--blueprint", str(input_data["blueprint"])]
    if input_data.get("name"):
        a += ["--name", str(input_data["name"])]
    return _run(a)


@action(
    name="agent_app_validate",
    description="Run the validation + security gate on an Agent App.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR, "no_build": {"type": "string", "description": "Set to 'true' to skip the build step."}},
    output_schema=_OUT,
)
def agent_app_validate(input_data: dict) -> dict:
    no_build = str(input_data.get("no_build", "")).lower() in ("true", "1", "yes")
    return _run(["validate", str(input_data["dir"]), "--no-build"] if no_build else ["validate", str(input_data["dir"])])
