"""Agent App Framework plugin for Hermes.

A native Hermes backend plugin (Hermes plugins are Python). It registers tools
that build and operate Agent Apps by shelling the framework CLIs, so anything an
agent does over the A2App protocol, Hermes can do through these tools. Drop this
directory into `~/.hermes/plugins/`; set `A2APP_CLI` (operate, default `a2app`) and `AGENT_APP_CLI`
(build/evolve, default `agent-app`) to override the binaries.

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
    "scaffold", "import", "validate", "toolkit-sync", "adapter-sync", "serve", "stop",
    "list", "global", "skills", "dev", "promote", "backup", "restore",
}
# The closed set of verbs that address every app rather than one, and so take no
# app argument. Closed is what makes _verb exact: it never has to inspect a
# positional to guess what it is.
REGISTRY_VERBS = {"list", "global", "skills"}


def _verb(argv: list[str]) -> str:
    """The verb in an app-first argv.

    Both CLIs are written `<binary> <app> <verb> [args]`, so the verb is the
    SECOND element — except for a registry verb, which takes no app and
    therefore stands alone in first position (framework spec 5.1).
    """
    if argv and argv[0] in REGISTRY_VERBS:
        return argv[0]
    return argv[1] if len(argv) > 1 else ""


def _run(argv: list[str]) -> str:
    # Run a JS entry (…/cli.js) with node; never use a shell, so field values
    # reach the CLI as literal arguments.
    exe = FRAMEWORK_CLI if _verb(argv) in FRAMEWORK_VERBS else CLI
    cmd = ["node", exe, *argv] if exe.endswith((".js", ".mjs", ".cjs")) else [exe, *argv]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        return f"framework CLI not found (looked for {exe!r}). Install it with `npm i -g agent-app`, or set A2APP_CLI / AGENT_APP_CLI to the binary paths."
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return out or f"(exit {proc.returncode})"


# --------------------------------------------------------------- handlers

def _describe(args: dict, **_kw) -> str:
    # Describe is navigational: the path names ONE place in the app.
    segments = [p for p in str(args.get("path", "")).split("/") if p]
    return _run([str(args["dir"]), *segments])


def _list(args: dict, **_kw) -> str:
    a = [str(args["dir"]), "data", str(args["entity"]), "list"]
    if args.get("filter"):
        a += ["--filter", str(args["filter"])]
    if args.get("sort"):
        a += ["--sort", str(args["sort"])]
    if args.get("limit") is not None:
        a += ["--limit", str(args["limit"])]
    return _run(a)


def _get(args: dict, **_kw) -> str:
    return _run([str(args["dir"]), "data", str(args["entity"]), "get", str(args["id"])])


def _create(args: dict, **_kw) -> str:
    import json
    return _run([str(args["dir"]), "data", str(args["entity"]), "create", "--json", json.dumps(args.get("fields") or {})])


def _update(args: dict, **_kw) -> str:
    import json
    return _run([str(args["dir"]), "data", str(args["entity"]), "update", str(args["id"]), "--json", json.dumps(args.get("fields") or {})])


def _delete(args: dict, **_kw) -> str:
    return _run([str(args["dir"]), "data", str(args["entity"]), "delete", str(args["id"])])


def _find(args: dict, **_kw) -> str:
    return _run([str(args["dir"]), "--find", str(args["term"])])


def _run_operation(args: dict, **_kw) -> str:
    a = [str(args["dir"]), *[p for p in str(args["path"]).split("/") if p], str(args["operation"])]
    for key, value in (args.get("fields") or {}).items():
        a += [f"--{key}", str(value)]
    if args.get("approve"):
        a += ["--approve", str(args["approve"])]
    return _run(a)


def _poll_tasks(args: dict, **_kw) -> str:
    if args.get("status"):
        return _run([str(args["dir"]), "tasks", "--status", str(args["status"])])
    return _run([str(args["dir"]), "tasks"])


def _build(args: dict, **_kw) -> str:
    a = [str(args["dir"]), "scaffold"]
    if args.get("blueprint"):
        a += ["--blueprint", str(args["blueprint"])]
    if args.get("name"):
        a += ["--name", str(args["name"])]
    return _run(a)


def _validate(args: dict, **_kw) -> str:
    return _run([str(args["dir"]), "validate", "--no-build"] if args.get("noBuild") else [str(args["dir"]), "validate"])


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
    (_schema("agent_app_describe",
             'Describe ONE place in an Agent App. `path` is empty for the root (its modules), "sales" for a '
             'module, "sales/invoices" for an entity, "sales/invoices/INV-1" for a record and the operations '
             "its state allows. Every response names the legal next moves. No call returns the whole model.",
             {"dir": _DIR, "path": _STR}, ["dir"]), _describe, "🔎"),
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
    # No agent_app_operations: no global operation list exists. An operation is
    # found on the screen it belongs to and invoked at the path identifying it.
    (_schema("agent_app_find",
             "Search entity, operation and module names across the app; returns their locations.",
             {"dir": _DIR, "term": _STR}, ["dir", "term"]), _find, "🔎"),
    (_schema("agent_app_run_operation",
             "Invoke a declared operation at the path that identifies it. A destructive op returns "
             "approval_required with a key; pass `approve` to execute.",
             {"dir": _DIR, "path": _STR, "operation": _STR, "fields": {"type": "object"}, "approve": _STR},
             ["dir", "path", "operation"]), _run_operation, "▶️"),
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
