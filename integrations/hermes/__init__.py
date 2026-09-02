"""Agent App Framework plugin for Hermes.

A native Hermes backend plugin (Hermes plugins are Python). It registers tools
that build and operate Agent Apps by shelling the framework CLIs, so anything an
agent does over the A2App protocol, Hermes can do through these tools. Drop this
directory into `~/.hermes/plugins/`; set `A2APP_CLI` to override the binary
(default: `a2app`).

Every tool shells the real CLI and returns its output verbatim — a guard
rejection (invalid enum, relative date, …) is useful data, so it is returned to
the model rather than swallowed.
"""
import os
import subprocess

CLI = os.environ.get("A2APP_CLI", "a2app")
# Build/evolve is a second binary; the operate client rejects build verbs by
# design (framework spec 5.1), so each verb is routed to its owner.
FRAMEWORK_CLI = os.environ.get("AGENT_APP_CLI", "agent-app")
FRAMEWORK_VERBS = {
    "create", "validate", "toolkit-sync", "adapter-sync", "serve", "stop",
    "list", "global", "skills", "dev", "promote", "backup", "restore", "walk-verify",
}



def _run(argv: list[str]) -> str:
    exe = argv[:]
    # Run a JS entry (…/cli.js) with node; never use a shell, so field values
    # reach the CLI as literal arguments.
    exe = FRAMEWORK_CLI if (argv and argv[0] in FRAMEWORK_VERBS) else CLI
    cmd = ["node", exe, *argv] if exe.endswith((".js", ".mjs", ".cjs")) else [exe, *argv]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        return f"a2app CLI not found (looked for {CLI!r}). Install it or set A2APP_CLI to its path."
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return out or f"(exit {proc.returncode})"


# --------------------------------------------------------------- handlers

def _describe(args: dict, **_kw) -> str:
    return _run(["data", str(args["dir"]), "schema"])


def _list(args: dict, **_kw) -> str:
    a = ["data", str(args["dir"]), str(args["entity"]), "list"]
    if args.get("filter"):
        a += ["--filter", str(args["filter"])]
    if args.get("sort"):
        a += ["--sort", str(args["sort"])]
    if args.get("limit") is not None:
        a += ["--limit", str(args["limit"])]
    return _run(a)


def _get(args: dict, **_kw) -> str:
    return _run(["data", str(args["dir"]), str(args["entity"]), "get", str(args["id"])])


def _create(args: dict, **_kw) -> str:
    import json
    return _run(["data", str(args["dir"]), str(args["entity"]), "create", "--json", json.dumps(args.get("fields") or {})])


def _update(args: dict, **_kw) -> str:
    import json
    return _run(["data", str(args["dir"]), str(args["entity"]), "update", str(args["id"]), "--json", json.dumps(args.get("fields") or {})])


def _delete(args: dict, **_kw) -> str:
    return _run(["data", str(args["dir"]), str(args["entity"]), "delete", str(args["id"])])


def _operations(args: dict, **_kw) -> str:
    return _run(["ops", str(args["dir"])])


def _run_operation(args: dict, **_kw) -> str:
    a = ["run", str(args["dir"]), str(args["operation"])]
    for key, value in (args.get("fields") or {}).items():
        a += [f"--{key}", str(value)]
    if args.get("approve"):
        a += ["--approve", str(args["approve"])]
    return _run(a)


def _poll_tasks(args: dict, **_kw) -> str:
    if args.get("status"):
        return _run(["tasks", str(args["dir"]), "--status", str(args["status"])])
    return _run(["tasks", str(args["dir"])])


def _build(args: dict, **_kw) -> str:
    a = ["create", str(args["dir"])]
    if args.get("blueprint"):
        a += ["--blueprint", str(args["blueprint"])]
    if args.get("name"):
        a += ["--name", str(args["name"])]
    return _run(a)


def _validate(args: dict, **_kw) -> str:
    return _run(["validate", str(args["dir"]), "--no-build"] if args.get("noBuild") else ["validate", str(args["dir"])])


# --------------------------------------------------------------- schemas

_STR = {"type": "string"}
_DIR = {"type": "string", "description": "Agent App project directory"}
_ENTITY = {"type": "string", "description": "entity / collection name"}


def _schema(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required},
    }


_TOOLS = [
    (_schema("agent_app_describe", "Read an Agent App's entities, fields, and declared operations.",
             {"dir": _DIR}, ["dir"]), _describe, "🔎"),
    (_schema("agent_app_list", "List records of an entity (optional filter/sort/limit).",
             {"dir": _DIR, "entity": _ENTITY, "filter": _STR, "sort": _STR, "limit": {"type": "integer"}}, ["dir", "entity"]), _list, "📋"),
    (_schema("agent_app_get", "Fetch one record by id.",
             {"dir": _DIR, "entity": _ENTITY, "id": _STR}, ["dir", "entity", "id"]), _get, "🔍"),
    (_schema("agent_app_create", "Create a record; the app's guard validates it and rejections are returned verbatim.",
             {"dir": _DIR, "entity": _ENTITY, "fields": {"type": "object"}}, ["dir", "entity", "fields"]), _create, "➕"),
    (_schema("agent_app_update", "Update a record by id.",
             {"dir": _DIR, "entity": _ENTITY, "id": _STR, "fields": {"type": "object"}}, ["dir", "entity", "id", "fields"]), _update, "✏️"),
    (_schema("agent_app_delete", "Delete a record by id.",
             {"dir": _DIR, "entity": _ENTITY, "id": _STR}, ["dir", "entity", "id"]), _delete, "🗑️"),
    (_schema("agent_app_operations", "List the app's declared operations.",
             {"dir": _DIR}, ["dir"]), _operations, "⚙️"),
    (_schema("agent_app_run_operation", "Invoke a declared operation. A destructive op returns approval_required with a key; pass `approve` to execute.",
             {"dir": _DIR, "operation": _STR, "fields": {"type": "object"}, "approve": _STR}, ["dir", "operation"]), _run_operation, "▶️"),
    (_schema("agent_app_poll_tasks", "Poll the app-to-agent task queue (default status: submitted).",
             {"dir": _DIR, "status": _STR}, ["dir"]), _poll_tasks, "📥"),
    (_schema("agent_app_build", "Scaffold a new Agent App from a blueprint.",
             {"dir": _DIR, "blueprint": _STR, "name": _STR}, ["dir"]), _build, "🏗️"),
    (_schema("agent_app_validate", "Run the validation + security gate.",
             {"dir": _DIR, "noBuild": {"type": "boolean"}}, ["dir"]), _validate, "✅"),
]


def register(ctx) -> None:
    """Called once by the Hermes plugin loader."""
    for schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=schema["name"],
            toolset="agent_app",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )
