"""Agent App Framework plugin for Hermes: the agent side.

`register(ctx)` wires the framework into Hermes through its own plugin API:

  - the build + operate tools (`agent_app_*`, toolset `agent_app`), each
    shelling a real `agent-app` or `a2app` verb;
  - the six framework skills, as plugin skills (`agent-app:creator`, ...);
  - a system-prompt section that routes any app request to the owning skill,
    which is how plugin skills are found at all (Hermes keeps them out of the
    `<available_skills>` index and gives them no slash commands);
  - the `/agent-app <request>` command, which hands the request to the agent:
    `ctx.inject_message` in the classic CLI, a `pre_gateway_dispatch` rewrite
    on messaging platforms;
  - `hermes agent-app <args...>`, a passthrough to both CLIs;
  - the `hermes` route in `$A2APP_HOME/harnesses.json`, so
    `agent-app <dir> bridge` can start Hermes when an app queues work.

The Agent Apps dashboard tab lives beside this, in `dashboard/` (Hermes loads
dashboard plugins in the dashboard process, not through `register`).
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys

from . import engine

logger = logging.getLogger(__name__)

# How `agent-app <dir> bridge` starts Hermes when an app queues work: one
# turn, run in the app's directory, then exit (`-Q` exits after answering
# even on a TTY; `--cli` keeps a `display.interface: tui` default from taking
# over a run nobody is watching). The framework has no built-in Hermes
# profile, so without this entry the bridge cannot see Hermes. Dangerous
# commands follow the user's `approvals.single_query_mode` (deny by default);
# this route grants nothing on their behalf.
HERMES_PROFILE = {
    "id": "hermes",
    "name": "Hermes",
    "routes": [{"mode": "headless", "command": "hermes", "args": ["--cli", "chat", "-Q", "-q", engine.PROMPT_PLACEHOLDER]}],
}

# One line per skill for the routing section; the full descriptions are long
# and the section has a hard size limit.
_SKILL_ROLES = {
    "creator": "build a NEW app",
    "modify": "change an EXISTING app",
    "operator": "use, read, or run an app (no code changes)",
    "importer": "adopt existing software",
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
        "When a message asks to build, change, run, import, verify, or connect to an app (a message "
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
        "or name wherever it takes a directory. The `agent_app_*` tools wrap the same CLIs.",
    ]
    if skills_home:
        lines.append(
            f"The skills' shared files (QUALITY.md, index.json) are in `{skills_home}`; read them "
            "with your file tools when a skill cites them."
        )
    return "\n".join(lines)


def _tool_handler(tool: engine.Tool):
    def handler(args: dict, **_kw) -> str:
        # A relative `dir` means what it means in the agent's terminal, whose
        # working directory Hermes exports as TERMINAL_CWD (a remote terminal
        # backend's path does not exist here, and is ignored).
        cwd = os.environ.get("TERMINAL_CWD") or None
        if cwd is not None and not os.path.isdir(cwd):
            cwd = None
        return tool.call(args if isinstance(args, dict) else {}, cwd=cwd).text()

    return handler


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
