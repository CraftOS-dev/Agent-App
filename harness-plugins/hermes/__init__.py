"""Agent App Framework plugin for Hermes: the agent side.

`register(ctx)` wires the framework into Hermes through its own plugin API:

  - the build, operate and package tools (`agent_app_*`, toolset
    `agent_app`), each shelling a real `agent-app` or `a2app` verb;
  - a `pre_tool_call` hook that sends the risky ones to Hermes's approval
    prompt (see approval_reason);
  - the six framework skills, as plugin skills (`agent-app:creator`, ...);
  - a system-prompt section that routes any app request to the owning skill,
    which is how the model finds plugin skills at all (Hermes keeps them out
    of the `<available_skills>` index);
  - the `/agent-app <request>` command, which hands the request to the agent:
    `ctx.inject_message` in the classic CLI, a `pre_gateway_dispatch` rewrite
    on messaging platforms;
  - `hermes agent-app <args...>`, a passthrough to both CLIs;
  - the `hermes` route in `$A2APP_HOME/harnesses.json`, so
    `agent-app <dir> bridge` can start Hermes when an app queues work;
  - inside hermes-webui only, the Agent Apps tab's loopback backend
    (`webui_backend.py`), since the web UI mounts no plugin API.

The Agent Apps dashboard tab lives beside this, in `dashboard/` (Hermes loads
dashboard plugins in the dashboard process, not through `register`), and its
hermes-webui extension in `webui/`.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys

from . import engine, webui_backend

logger = logging.getLogger(__name__)

# How `agent-app <dir> bridge` starts Hermes when an app queues work: one
# turn, run in the app's directory, then exit (`-Q` exits after answering
# even on a TTY; `--cli` keeps a `display.interface: tui` default from taking
# over a run nobody is watching). The prompt goes in on stdin, as the tab's
# own turns send theirs: an argument is capped by the OS (128 KiB on Linux,
# 32 KiB for a whole Windows command line) and a task's payload has no such
# bound. The framework has no built-in Hermes profile, so without this entry
# the bridge cannot see Hermes. Dangerous commands follow the user's
# `approvals.single_query_mode` (deny by default); this route grants nothing
# on their behalf.
HERMES_PROFILE = {
    "id": "hermes",
    "name": "Hermes",
    "routes": [{"mode": "headless", "command": "hermes", "args": ["--cli", "chat", "-Q", "--query-file", "-"], "input": "stdin"}],
}

# One line per skill for the routing section; the full descriptions are long
# and the section has a hard size limit.
_SKILL_ROLES = {
    "creator": "build a NEW app",
    "modify": "change an EXISTING app",
    "operator": "use, read, or run an app (no code changes)",
    "importer": "install from the marketplace, import a zip/folder/git source, adopt or convert existing software, export to share",
    "walk-verify": "independent verification, never by the builder",
    "connect": "a published app you do not own",
}

# The prefix a routed /agent-app request carries. A leading slash would send
# the injected text back through command dispatch.
ROUTED_PREFIX = "Agent App Framework request (/agent-app):"

USAGE = (
    "Usage: /agent-app <what you want>\n"
    'e.g. "/agent-app build a CRM", "/agent-app add a report to my expense app", '
    '"/agent-app operate atlas-erp"'
)

# Where a plugin command cannot start a turn (the TUI, and the dashboard
# chat): say what to do instead of failing silently.
NO_TURN_HERE = (
    "This interface does not let a plugin command start a turn. Send the request as a "
    'normal message instead, e.g. "build a CRM as an Agent App": the Agent App skills '
    "are loaded and the request is routed to the right one."
)

# `/agent-app ...` on a messaging platform. Telegram allows no hyphen in a
# command, and appends `@botname` in groups.
_GATEWAY_COMMAND = re.compile(r"^/agent[-_]app(?:@\S+)?(?:\s+(.*))?$", re.IGNORECASE | re.DOTALL)


def routed_prompt(request: str) -> str:
    return f"{ROUTED_PREFIX} {request}"


def guidance(skills: list[tuple[str, object, dict]], namespace: str, skills_home: str | None) -> str:
    """The system-prompt section that makes the framework reachable."""
    lines = [
        "## Agent App Framework",
        "",
        "An Agent App is a self-contained full-stack web app operated through its A2App adapter "
        "(the `a2app` CLI), never by driving its UI. Build and evolve go through the `agent-app` CLI. "
        "When a message asks to build, change, run, install, import, verify, or connect to an app (a message "
        f'beginning "{ROUTED_PREFIX}" came from the /agent-app command), load the matching framework '
        "skill with skill_view and follow it end to end:",
    ]
    for name, _path, meta in skills:
        role = _SKILL_ROLES.get(name) or str(meta.get("description", ""))[:120]
        lines.append(f"- `{namespace}:{name}`: {role}")
    lines += [
        "",
        "Do not build or operate an app from general knowledge outside these skills. "
        "`agent-app list` locates every known Agent App, and a command accepts a registered app id "
        "or name wherever it takes a directory. It also lists the apps on other machines this agent is "
        "connected to: address one by its URL (`a2app https://… …`, or the URL as a tool's `dir`), operate it "
        "through the connect and operator skills, and never modify it. The `agent_app_*` tools wrap the same CLIs.",
    ]
    if skills_home:
        lines.append(
            f"The skills' shared files (QUALITY.md, index.json) are in `{skills_home}`; read them "
            "with your file tools when a skill cites them."
        )
    return "\n".join(lines)


def agent_cwd() -> str | None:
    """The calling session's working directory, so a relative `dir` means what
    it means in the agent's terminal. A host running many sessions at once
    (the gateway, the TUI, a web UI) keeps each one's directory per session;
    TERMINAL_CWD in the environment is only right for a single-session CLI,
    so it is the fallback for a Hermes without `agent.runtime_cwd`. A remote
    terminal backend's path does not exist here, and is ignored."""
    try:
        from agent.runtime_cwd import resolve_agent_cwd

        cwd = str(resolve_agent_cwd())
    except Exception:
        cwd = os.environ.get("TERMINAL_CWD") or ""
    return cwd if cwd and os.path.isdir(cwd) else None


_cli_version_checked = False


def _cli_version_note() -> str | None:
    """Once per process, on the first tool call: a note when the installed CLI
    is not the release this plugin was tested with. Logged as well."""
    global _cli_version_checked
    if _cli_version_checked:
        return None
    _cli_version_checked = True
    note = engine.cli_version_warning()
    if note:
        logger.warning("agent-app: %s", note)
    return note


def _tool_handler(tool: engine.Tool):
    def handler(args: dict, **_kw) -> str:
        note = _cli_version_note()
        text = tool.call(args if isinstance(args, dict) else {}, cwd=agent_cwd()).text()
        return f"{note}\n\n{text}" if note else text

    return handler


# ── Calls that need the person's yes ─────────────────────────────────────────
#
# The `pre_tool_call` hook sends these to Hermes's own approval prompt, the gate
# its dangerous commands go through: the model cannot answer it, and where no
# person can (cron, a `-Q` run such as the tab's turns and bridge runs) Hermes
# refuses the call. Every other call runs as before.


def _confining_roots(base: str) -> list[str]:
    """Where a call may write, or run an app's code, without asking: the apps
    folder and the session's working directory. A filesystem root as the
    working directory confines nothing, so it does not count."""
    roots = [os.path.realpath(engine.apps_dir())]
    here = os.path.realpath(base)
    if os.path.dirname(here) != here:
        roots.append(here)
    return roots


def _inside(path: str, roots: list[str]) -> bool:
    for root in roots:
        try:
            if os.path.commonpath([os.path.normcase(path), os.path.normcase(root)]) == os.path.normcase(root):
                return True
        except ValueError:  # another drive
            continue
    return False


def _app_folder(value: str, base: str) -> str | None:
    """The folder an app's `dir` names: a path, else a registered app's id or
    name. None for an app on another machine, or a name nothing registered
    (the CLI refuses those itself)."""
    if value.startswith(("http://", "https://")):
        return None
    path = os.path.join(base, value)
    if os.path.isdir(path):
        return os.path.realpath(path)
    for app in engine.list_known_apps():
        if value in (app["id"], app["name"]):
            return os.path.realpath(app["path"])
    return None


def approval_reason(tool: str, args: dict, cwd: str | None) -> str | None:
    """Why a tool call needs the person's yes, or None when it does not:
      - installing or inspecting anything but an app from the default
        marketplace, since the CLI downloads it, installs its dependencies
        and starts it;
      - re-running an operation the app said needs approval, with its key;
      - writing, or running an app's code, outside the apps folder and the
        working directory: export's `out`, install's `into`, a new app's
        folder, and the app a serve or validate runs."""
    base = cwd or os.getcwd()
    roots = _confining_roots(base)
    where = " and ".join(f"`{root}`" for root in roots)

    def text(key: str) -> str | None:
        value = args.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else None

    reasons: list[str] = []

    def outside(key: str, what: str) -> None:
        value = text(key)
        if value is not None and not _inside(os.path.realpath(os.path.join(base, value)), roots):
            reasons.append(f"{what} `{value}`, outside {where}")

    if tool in ("agent_app_install", "agent_app_inspect"):
        installs = tool == "agent_app_install"
        effect = ("the CLI downloads it, installs its dependencies and can start it on this machine" if installs
                  else "the CLI downloads it to look inside; nothing from it runs")
        if text("from") is not None:
            reasons.append(f"{'install' if installs else 'inspect'} the app at `{text('from')}`, which is not from the marketplace: {effect}")
        elif text("source") is not None:
            reasons.append(f"{'install' if installs else 'inspect'} `{text('id') or ''}` from the marketplace `{text('source')}`, "
                           f"not the default one: {effect}")
        if installs:
            outside("into", "install into")
    elif tool == "agent_app_run_operation" and args.get("approve") is not None:
        fields = engine._json(args["fields"]) if isinstance(args.get("fields"), dict) and args["fields"] else ""
        reasons.append(f"run `{text('operation')}` at `{text('path') or ''}` in the app `{text('dir')}`, an operation the app "
                       f"holds for approval{f', with {fields[:300]}' if fields else ''}")
    elif tool == "agent_app_export":
        outside("out", "write the package to")
    elif tool == "agent_app_build":
        outside("dir", "create the app in")
    elif tool in ("agent_app_serve", "agent_app_validate"):
        value = text("dir")
        folder = _app_folder(value, base) if value is not None else None
        if folder is not None and not _inside(folder, roots):
            action = "start" if tool == "agent_app_serve" else "build and check"
            reasons.append(f"{action} the app at `{folder}`, which runs its code, outside {where}")
    return f"Agent App: {'; '.join(reasons)}" if reasons else None


def _on_pre_tool_call(tool_name=None, args=None, **_kw):
    if not isinstance(tool_name, str) or not tool_name.startswith("agent_app_"):
        return None
    try:
        reason = approval_reason(tool_name, args if isinstance(args, dict) else {}, agent_cwd())
    except Exception:
        # A check that failed must not wave the call through.
        logger.exception("agent-app: checking %s failed", tool_name)
        reason = f"Agent App: {tool_name} could not be checked, so it needs your approval"
    return {"action": "approve", "message": reason} if reason else None


def _cli_setup(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "argv",
        nargs=argparse.REMAINDER,
        metavar="ARGS",
        help="arguments for agent-app (build/evolve verbs) or a2app (operate); routed by verb",
    )


def _cli_run(args: argparse.Namespace) -> int:
    argv = list(getattr(args, "argv", None) or [])
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        sys.stderr.write(
            "usage: hermes agent-app <app> [<path...>] [<operation>] | <dir> <verb> | list\n"
            "Build/evolve verbs run agent-app; everything else runs a2app.\n"
        )
        return 2
    return engine.run_passthrough(engine.bin_for(argv), argv)


def _on_pre_gateway_dispatch(event=None, **_kw):
    text = getattr(event, "text", None)
    if not isinstance(text, str):
        return None
    match = _GATEWAY_COMMAND.match(text.strip())
    if match is None:
        return None
    request = (match.group(1) or "").strip()
    if not request:
        return None  # a bare command reaches its handler, which replies with usage
    return {"action": "rewrite", "text": routed_prompt(request)}


def register(ctx) -> None:
    """Called once by the Hermes plugin loader."""
    namespace = getattr(getattr(ctx, "manifest", None), "name", None) or "agent-app"

    registration = engine.register_harness_profile(HERMES_PROFILE)
    if registration["status"] == "registered":
        logger.info("agent-app: %s", registration["detail"])
    elif registration["status"] == "refused":
        logger.warning("agent-app: %s", registration["detail"])

    for tool in engine.a2app_tools():
        ctx.register_tool(
            name=tool.name,
            toolset="agent_app",
            schema=tool.schema(),
            handler=_tool_handler(tool),
            emoji=tool.emoji,
        )
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)

    skills_home = engine.skills_dir()
    skills = engine.framework_skills(skills_home) if skills_home is not None else []
    for name, path, meta in skills:
        try:
            ctx.register_skill(name, path, description=meta["description"], frontmatter=meta)
        except (ValueError, OSError) as exc:
            logger.warning("agent-app: skill %s not registered: %s", name, exc)
    if not skills:
        logger.warning(
            "agent-app: the framework skills were not found (no staged skills/ and `agent-app skills --path` "
            "gave none). %s",
            engine.INSTALL_HINT,
        )

    ctx.register_system_prompt_section(
        "agent-app",
        guidance(skills, namespace, str(skills_home) if skills_home is not None else None),
    )

    def slash(raw_args: str):
        request = (raw_args or "").strip()
        if not request:
            return USAGE
        if ctx.inject_message(routed_prompt(request)):
            return None
        return NO_TURN_HERE

    ctx.register_command(
        "agent-app",
        handler=slash,
        description="Build, evolve, or operate an Agent App: routes the request to the right framework skill.",
        args_hint="<what you want>",
        argument_mode="text",
    )
    ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)

    ctx.register_cli_command(
        name="agent-app",
        help="Run the Agent App Framework CLIs (build/evolve/operate an Agent App)",
        setup_fn=_cli_setup,
        handler_fn=_cli_run,
        description="Passthrough to agent-app (build/evolve verbs) and a2app (operate), routed by verb.",
    )

    # Inside hermes-webui, which never mounts a plugin API, the Agent Apps
    # extension needs this plugin to serve the tab's routes itself. Started
    # on its own thread, never here: see webui_backend.maybe_start.
    webui_backend.start_in_background(
        lambda info: logger.info("agent-app: Agent Apps backend for hermes-webui at %s", info["base"])
    )
