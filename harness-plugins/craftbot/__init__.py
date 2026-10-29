"""Agent App Framework actions for CraftBot.

CraftBot is Agent-App-native and registers agent tools as **actions** via the
`@action` decorator (importing this module registers them in CraftBot's
ActionRegistry). These actions build, operate, install and import Agent Apps by
shelling the framework CLIs, so anything an agent does over the A2App protocol,
CraftBot can do as an action. Loaded inside CraftBot, which provides `agent_core`
(the `@action` decorator). Set `A2APP_CLI` (operate, default `a2app`) and
`AGENT_APP_CLI` (build/evolve, default `agent-app`).

The marketplace and import actions keep CraftBot's own names and arguments
(`agent_app_marketplace_list`, `agent_app_marketplace_install`,
`agent_app_inspect`, `agent_app_import`), so CraftBot's skills and agents keep
working once CraftBot runs on this framework. Each runs the same `agent-app`
install pipeline as every other harness; nothing here re-implements it.
"""
import json
import os
import subprocess

from agent_core import action  # provided by CraftBot's runtime

CLI = os.environ.get("A2APP_CLI", "a2app")
# Build/evolve is a second binary; the operate client rejects build verbs by
# design (framework spec 5.1). Each action names the binary it runs: under the
# walk an operate argv's second element is a module the app chose, so a binary
# inferred from the argv would misroute an app with a module called `validate`.
FRAMEWORK_CLI = os.environ.get("AGENT_APP_CLI", "agent-app")

INSTALL_HINT = "Install with `npm i -g agent-app-framework`, or set A2APP_CLI / AGENT_APP_CLI."

_OUT = {
    "status": {"type": "string", "example": "success", "description": "'success' or 'error' (mirrors the CLI exit code)."},
    "output": {"type": "string", "description": "The CLI output verbatim (a guard rejection message is returned here)."},
    "exit_code": {"type": "integer", "description": "0 success · 1 rejected · 2 usage · 3 unreachable."},
}
_DIR = {"type": "string", "example": "./my-app", "description": "Agent App project directory."}
_ENTITY = {"type": "string", "example": "contacts", "description": "Entity / collection name."}
_SOURCE = {
    "type": "string",
    "example": "https://github.com/someone/my-agent-app",
    "description": (
        "A .zip path, a local folder path, a GitHub repository (github:<owner>/<repo>[@<ref>][/<path>] or its "
        "https://github.com/... URL), or any git host as git+<url>[#<ref>]."
    ),
}


def _exec(exe: str, argv: list) -> tuple:
    """Run one framework CLI with literal argv (no shell). Returns (exit code, stdout, stderr)."""
    cmd = ["node", exe, *argv] if exe.endswith((".js", ".mjs", ".cjs")) else [exe, *argv]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return 3, "", f"framework CLI not found (looked for {exe!r}). {INSTALL_HINT}"
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def _result(code: int, stdout: str, stderr: str) -> dict:
    output = (stdout + stderr).strip()
    return {"status": "success" if code == 0 else "error", "output": output or f"(exit {code})", "exit_code": code}


def _operate(argv: list) -> dict:
    return _result(*_exec(CLI, argv))


def _build(argv: list) -> dict:
    return _result(*_exec(FRAMEWORK_CLI, argv))


def _json(stdout: str):
    try:
        return json.loads(stdout)
    except ValueError:
        return None


def _why(doc, stdout: str, stderr: str, code: int) -> str:
    """What the CLI said went wrong: its result's `error`, else its diagnostics."""
    if isinstance(doc, dict) and isinstance(doc.get("error"), str):
        return doc["error"]
    return (stderr or stdout).strip() or f"(exit {code})"


def _installed(code: int, stdout: str, stderr: str) -> dict:
    """An install's outcome in CraftBot's shape: the project, and what is still owed."""
    doc = _json(stdout)
    out = {"status": "success" if code == 0 else "error", "exit_code": code, "result": doc}
    if not isinstance(doc, dict):
        out["message"] = _why(doc, stdout, stderr, code)
        return out
    if doc.get("dir"):
        out.update({"project_id": doc.get("id"), "project_path": doc.get("dir"), "url": doc.get("url"), "trust": doc.get("trust")})
    nexts = [str(n) for n in doc.get("next") or []]
    if code == 0:
        where = f" at {doc['url']}" if doc.get("url") else ""
        out["message"] = f"Installed \"{doc.get('name')}\"{where}." + ("" if not nexts else " Still to do: " + "; ".join(nexts))
    elif doc.get("dir"):
        out["message"] = f"Installed at {doc['dir']}, but it does not pass its gate; it stays registered to be fixed. " + "; ".join(nexts)
    elif doc.get("routes"):
        # Not a package: say where it goes instead of forcing it.
        out["message"] = (
            f"{doc.get('reason') or _why(doc, stdout, stderr, code)} It is a {doc.get('kind')} source: "
            f"load the importer skill to {' or '.join(doc['routes'])} it."
        )
    else:
        out["message"] = f"{doc.get('step') or 'install'}: {_why(doc, stdout, stderr, code)}"
    return out


@action(
    name="agent_app_describe",
    description="Read an Agent App's entities, fields, and declared operations.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR}, output_schema=_OUT,
)
def agent_app_describe(input_data: dict) -> dict:
    return _operate([str(input_data["dir"]), "data", "schema"])


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
    return _operate(a)


@action(
    name="agent_app_get",
    description="Fetch one record by id.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}},
    output_schema=_OUT,
)
def agent_app_get(input_data: dict) -> dict:
    return _operate([str(input_data["dir"]), "data", str(input_data["entity"]), "get", str(input_data["id"])])


@action(
    name="agent_app_create",
    description="Create a record; the app's guard validates it and rejections are returned verbatim.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "fields": {"type": "object", "description": "field → value map."}},
    output_schema=_OUT,
)
def agent_app_create(input_data: dict) -> dict:
    return _operate([str(input_data["dir"]), "data", str(input_data["entity"]), "create", "--json", json.dumps(input_data.get("fields") or {})])


@action(
    name="agent_app_update",
    description="Update a record by id.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}, "fields": {"type": "object", "description": "field → value map."}},
    output_schema=_OUT,
)
def agent_app_update(input_data: dict) -> dict:
    return _operate([str(input_data["dir"]), "data", str(input_data["entity"]), "update", str(input_data["id"]), "--json", json.dumps(input_data.get("fields") or {})])


@action(
    name="agent_app_delete",
    description="Delete a record by id.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={"dir": _DIR, "entity": _ENTITY, "id": {"type": "string", "description": "Record id."}},
    output_schema=_OUT,
)
def agent_app_delete(input_data: dict) -> dict:
    return _operate([str(input_data["dir"]), "data", str(input_data["entity"]), "delete", str(input_data["id"])])


@action(
    name="agent_app_find",
    description="Search entity, operation and module names across the app and return their locations.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR, "term": {"type": "string", "example": "invoice", "description": "The name, or part of one, to search for."}},
    output_schema=_OUT,
)
def agent_app_find(input_data: dict) -> dict:
    return _operate([str(input_data["dir"]), "--find", str(input_data["term"])])


@action(
    name="agent_app_run_operation",
    description=(
        "Invoke a declared operation at the path that identifies it. A destructive op returns "
        "approval_required with a key; pass 'approve' to execute."
    ),
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={
        "dir": _DIR,
        "path": {
            "type": "string", "example": "sales/invoices/INV-1",
            "description": "The module, entity and record the operation was found under, or just the module for a module-level operation.",
        },
        "operation": {"type": "string", "description": "Operation name."},
        "fields": {"type": "object", "description": "Operation arguments."},
        "approve": {"type": "string", "description": "Approval key from a prior call."},
    },
    output_schema=_OUT,
)
def agent_app_run_operation(input_data: dict) -> dict:
    a = [str(input_data["dir"]), *[p for p in str(input_data.get("path") or "").split("/") if p], str(input_data["operation"])]
    for key, value in (input_data.get("fields") or {}).items():
        a += [f"--{key}", str(value)]
    if input_data.get("approve"):
        a += ["--approve", str(input_data["approve"])]
    return _operate(a)


@action(
    name="agent_app_poll_tasks",
    description="Poll the app-to-agent task queue (default status: submitted).",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR, "status": {"type": "string", "description": "Status filter, e.g. submitted."}},
    output_schema=_OUT,
)
def agent_app_poll_tasks(input_data: dict) -> dict:
    if input_data.get("status"):
        return _operate([str(input_data["dir"]), "tasks", "--status", str(input_data["status"])])
    return _operate([str(input_data["dir"]), "tasks"])


@action(
    name="agent_app_build",
    description="Scaffold a new Agent App on a blueprint (framework files + ownership canon). The blueprint is required.",
    mode="CLI", action_sets=["agent_app"], parallelizable=False,
    input_schema={
        "dir": _DIR,
        "blueprint": {"type": "string", "description": "Blueprint id, e.g. blueprint-react-node (`agent-app blueprints` lists them)."},
        "name": {"type": "string", "description": "App name."},
        "authMode": {"type": "string", "enum": ["none", "multi-user"], "description": "multi-user when more than one person will use the app."},
    },
    output_schema=_OUT,
)
def agent_app_build(input_data: dict) -> dict:
    a = [str(input_data["dir"]), "scaffold"]
    if input_data.get("blueprint"):
        a += ["--blueprint", str(input_data["blueprint"])]
    if input_data.get("name"):
        a += ["--name", str(input_data["name"])]
    if input_data.get("authMode"):
        a += ["--auth-mode", str(input_data["authMode"])]
    return _build(a)


@action(
    name="agent_app_validate",
    description="Run the validation + security gate on an Agent App.",
    mode="CLI", action_sets=["agent_app"],
    input_schema={"dir": _DIR, "no_build": {"type": "string", "description": "Set to 'true' to skip the build step."}},
    output_schema=_OUT,
)
def agent_app_validate(input_data: dict) -> dict:
    no_build = str(input_data.get("no_build", "")).lower() in ("true", "1", "yes")
    return _build([str(input_data["dir"]), "validate", "--no-build"] if no_build else [str(input_data["dir"]), "validate"])


# ── The marketplace and import, under CraftBot's own action names ──


@action(
    name="agent_app_marketplace_list",
    description=(
        "List the Agent App marketplace catalogue: pre-built apps the user can install by id, each marked "
        "`compatible` (true, false with a `reason`, or null when it lists no requirement). Use when the user asks "
        "what apps are available or wants to install something by name: list first to resolve the id, never guess one."
    ),
    mode="CLI", action_sets=["agent_app"],
    input_schema={},
    output_schema={
        "status": {"type": "string", "example": "success", "description": "'success' or 'error'."},
        "apps": {
            "type": "array",
            "example": [{"id": "kanban-board", "name": "Kanban Board", "description": "Tasks in columns", "compatible": True}],
            "description": "Catalogue entries (id, name, description, tags, version, customizable, compatible, reason).",
        },
        "message": {"type": "string", "description": "Summary line, or why the marketplace could not be read."},
        "exit_code": _OUT["exit_code"],
    },
)
def agent_app_marketplace_list(input_data: dict) -> dict:
    code, stdout, stderr = _exec(FRAMEWORK_CLI, ["catalogue"])
    doc = _json(stdout)
    if code != 0 or not isinstance(doc, dict):
        return {"status": "error", "apps": [], "message": f"Could not read the marketplace: {_why(doc, stdout, stderr, code)}", "exit_code": code}
    apps = doc.get("apps") or []
    where = (doc.get("source") or {}).get("location", "the marketplace")
    return {
        "status": "success",
        "apps": apps,
        "message": f'{len(apps)} marketplace app(s) in {where}. Install with agent_app_marketplace_install(app_id="<id>").',
        "exit_code": 0,
    }


@action(
    name="agent_app_marketplace_install",
    description=(
        "Install a pre-built app from the marketplace by id (resolve ids with agent_app_marketplace_list): "
        "downloads it, re-vendors it from the toolkit installed here, registers it, installs its dependencies, "
        "gates and serves it. A marketplace app is catalogued, so no walk-verify is needed; still ask the person "
        "before granting any trigger or bridge it asks for."
    ),
    mode="CLI", action_sets=["agent_app"], parallelizable=False, irreversible=True,
    input_schema={
        "app_id": {"type": "string", "example": "kanban-board", "description": "The app id from the marketplace catalogue."},
        "name": {"type": "string", "example": "My Kanban", "description": "Optional display name (defaults to the catalogue name)."},
        "description": {
            "type": "string", "example": "Team task board",
            "description": "Accepted for compatibility; the app's description comes from its catalogue entry.",
        },
        "custom_fields": {
            "type": "object", "example": {"APP_TITLE": "My Board"},
            "description": "The entry's customizable fields, KEY → value (agent_app_marketplace_list shows them).",
        },
    },
    output_schema={
        "status": {"type": "string", "example": "success", "description": "'success' or 'error'."},
        "message": {"type": "string", "description": "Outcome with the app URL on success, and anything still to do."},
        "project_id": {"type": "string", "description": "The new app's id on success."},
        "project_path": {"type": "string", "description": "The new app's folder."},
        "url": {"type": "string", "description": "Where it serves."},
        "exit_code": _OUT["exit_code"],
    },
)
def agent_app_marketplace_install(input_data: dict) -> dict:
    app_id = str(input_data.get("app_id") or "").strip()
    if not app_id:
        return {"status": "error", "message": "app_id is required (see agent_app_marketplace_list).", "exit_code": 2}
    argv = ["install", app_id]
    if input_data.get("name"):
        argv += ["--name", str(input_data["name"])]
    for key, value in (input_data.get("custom_fields") or {}).items():
        argv += ["--set", f"{key}={value}"]
    return _installed(*_exec(FRAMEWORK_CLI, argv))


@action(
    name="agent_app_inspect",
    description=(
        "Find out what a source is and what installing it would do, installing nothing: whether it is an Agent App "
        "package (installable, and why not), a CraftBot Living UI app or foreign code (then `routes` says convert or "
        "adopt: the importer skill's), the commands its toolkit will run, and what install removes. Show the person "
        "what it will run and remove before agent_app_import."
    ),
    mode="CLI", action_sets=["agent_app"],
    input_schema={"source": _SOURCE},
    output_schema={
        "status": {"type": "string", "example": "success", "description": "'success' or 'error'."},
        "report": {"type": "object", "description": "The inspect report: kind, installable, reason, routes, pipeline, strips, warnings."},
        "message": {"type": "string", "description": "One line: what it is, and whether it installs."},
        "exit_code": _OUT["exit_code"],
    },
)
def agent_app_inspect(input_data: dict) -> dict:
    source = str(input_data.get("source") or "").strip()
    if not source:
        return {"status": "error", "message": "source is required", "exit_code": 2}
    code, stdout, stderr = _exec(FRAMEWORK_CLI, ["inspect", "--from", source])
    doc = _json(stdout)
    if code != 0 or not isinstance(doc, dict):
        return {"status": "error", "report": None, "message": _why(doc, stdout, stderr, code), "exit_code": code}
    if doc.get("installable"):
        message = f"An Agent App package ({doc.get('kind')}): installable with agent_app_import."
    else:
        message = f"Not installable: {doc.get('reason')}" + (f" Routes: {', '.join(doc['routes'])}." if doc.get("routes") else "")
    return {"status": "success", "report": doc, "message": message, "exit_code": 0}


@action(
    name="agent_app_import",
    description=(
        "Import an Agent App package from a .zip, a local folder, GitHub or any git host, through the install "
        "pipeline: shipped credentials, data and runtime state are dropped, system files are re-vendored from the "
        "toolkit installed here, and it gets a fresh identity and port. It is untrusted, so a separate agent "
        "walk-verifies it before it is used for real work. A source that is not a package (a Living UI app, a "
        "foreign repo) is refused with the routes to take instead: convert or adopt, with the importer skill."
    ),
    mode="CLI", action_sets=["agent_app"], parallelizable=False, irreversible=True,
    input_schema={
        "source": _SOURCE,
        "name": {"type": "string", "example": "My Imported App", "description": "Optional display name (defaults to the app's name)."},
    },
    output_schema={
        "status": {"type": "string", "example": "success", "description": "'success' or 'error'."},
        "project_id": {"type": "string", "description": "The new app's id."},
        "project_path": {"type": "string", "description": "The new app's folder."},
        "message": {"type": "string", "description": "Outcome and what happens next (the walk-verify still owed)."},
        "exit_code": _OUT["exit_code"],
    },
)
def agent_app_import(input_data: dict) -> dict:
    source = str(input_data.get("source") or "").strip()
    if not source:
        return {"status": "error", "message": "source is required", "exit_code": 2}
    argv = ["install", "--from", source]
    if input_data.get("name"):
        argv += ["--name", str(input_data["name"])]
    return _installed(*_exec(FRAMEWORK_CLI, argv))
