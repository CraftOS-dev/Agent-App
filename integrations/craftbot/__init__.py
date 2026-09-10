"""Agent App Framework actions for CraftBot.

CraftBot is Agent-App-native and registers agent tools as **actions** via the
`@action` decorator (importing this module registers them in CraftBot's
ActionRegistry). These actions build and operate Agent Apps by shelling the
framework CLIs, so anything an agent does over the A2App protocol, CraftBot can do
as an action. Loaded inside CraftBot, which provides `agent_core` (the
`@action` decorator). Set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI` (build/evolve, default `agent-app`).
"""
import json
import os
import subprocess

from agent_core import action  # provided by CraftBot's runtime

CLI = os.environ.get("A2APP_CLI", "a2app")
# Build/evolve is a second binary; the operate client rejects build verbs by
# design (framework spec 5.1), so each verb is routed to its owner.
FRAMEWORK_CLI = os.environ.get("AGENT_APP_CLI", "agent-app")
FRAMEWORK_VERBS = {
    "scaffold", "import", "validate", "toolkit-sync", "adapter-sync", "serve", "stop",
    "list", "global", "skills", "dev", "promote", "backup", "restore",
}
# The closed set of verbs that address every app rather than one, and so take no
# app argument. Closed is what makes _verb exact: it never has to inspect a
# positional to guess what it is.
REGISTRY_VERBS = {"list", "global", "skills"}


def _verb(argv: list) -> str:
    """The verb in an app-first argv.

    Both CLIs are written `<binary> <app> <verb> [args]`, so the verb is the
    SECOND element — except for a registry verb, which takes no app and
    therefore stands alone in first position (framework spec 5.1).
    """
    if argv and argv[0] in REGISTRY_VERBS:
        return argv[0]
    return argv[1] if len(argv) > 1 else ""


_OUT = {
    "status": {"type": "string", "example": "success", "description": "'success' or 'error' (mirrors the CLI exit code)."},
    "output": {"type": "string", "description": "The CLI output verbatim (a guard rejection message is returned here)."},
    "exit_code": {"type": "integer", "description": "0 success · 1 rejected · 2 usage · 3 unreachable."},
}
_DIR = {"type": "string", "example": "./my-app", "description": "Agent App project directory."}
_ENTITY = {"type": "string", "example": "contacts", "description": "Entity / collection name."}


def _run(argv: list) -> dict:
    exe = FRAMEWORK_CLI if _verb(argv) in FRAMEWORK_VERBS else CLI
    cmd = ["node", exe, *argv] if exe.endswith((".js", ".mjs", ".cjs")) else [exe, *argv]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        return {"status": "error", "output": f"framework CLI not found (looked for {exe!r}). Install with `npm i -g agent-app`, or set A2APP_CLI / AGENT_APP_CLI.", "exit_code": 3}
    output = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return {"status": "success" if proc.returncode == 0 else "error", "output": output or f"(exit {proc.returncode})", "exit_code": proc.returncode}


@action(
    name="agent_app_describe",
    description="Read an Agent App's entities, fields, and declared operations.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR}, output_schema=_OUT,
)
def agent_app_describe(input_data: dict) -> dict:
    return _run([str(input_data["dir"]), "data", "schema"])


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
    a = [str(input_data["dir"]), "data", str(input_data["entity"]), "list"]
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
    return _run([str(input_data["dir"]), "data", str(input_data["entity"]), "get", str(input_data["id"])])


@action(
    name="agent_app_create",
    description="Create a record; the app's guard validates it and rejections are returned verbatim.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "fields": {"type": "object", "description": "field → value map."}},
    output_schema=_OUT,
)
def agent_app_create(input_data: dict) -> dict:
    return _run([str(input_data["dir"]), "data", str(input_data["entity"]), "create", "--json", json.dumps(input_data.get("fields") or {})])


@action(
    name="agent_app_update",
    description="Update a record by id.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}, "fields": {"type": "object", "description": "field → value map."}},
    output_schema=_OUT,
)
def agent_app_update(input_data: dict) -> dict:
    return _run([str(input_data["dir"]), "data", str(input_data["entity"]), "update", str(input_data["id"]), "--json", json.dumps(input_data.get("fields") or {})])


@action(
    name="agent_app_delete",
    description="Delete a record by id.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}},
    output_schema=_OUT,
)
def agent_app_delete(input_data: dict) -> dict:
    return _run([str(input_data["dir"]), "data", str(input_data["entity"]), "delete", str(input_data["id"])])


@action(
    name="agent_app_find",
    description="List the app's declared operations.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR}, output_schema=_OUT,
)
def agent_app_find(input_data: dict) -> dict:
    return _run([str(input_data["dir"]), "--find", str(input_data["term"])])


@action(
    name="agent_app_run_operation",
    description="Invoke a declared operation. A destructive op returns approval_required with a key; pass 'approve' to execute.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "operation": {"type": "string", "description": "Operation name."}, "fields": {"type": "object", "description": "Operation arguments."}, "approve": {"type": "string", "description": "Approval key from a prior call."}},
    output_schema=_OUT,
)
def agent_app_run_operation(input_data: dict) -> dict:
    a = [str(input_data["dir"]), *[p for p in str(input_data["path"]).split("/") if p], str(input_data["operation"])]
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
        return _run([str(input_data["dir"]), "tasks", "--status", str(input_data["status"])])
    return _run([str(input_data["dir"]), "tasks"])


@action(
    name="agent_app_build",
    description="Scaffold a new Agent App from a blueprint (framework files + ownership canon).",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "blueprint": {"type": "string", "description": "Blueprint id, e.g. blueprint-react-node."}, "name": {"type": "string", "description": "App name."}},
    output_schema=_OUT,
)
def agent_app_build(input_data: dict) -> dict:
    a = [str(input_data["dir"]), "scaffold"]
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
    return _run([str(input_data["dir"]), "validate", "--no-build"] if no_build else [str(input_data["dir"]), "validate"])
