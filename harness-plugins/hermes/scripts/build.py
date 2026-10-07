"""Stage the installable Hermes plugin into `dist/`, and optionally install it.

A Hermes user plugin is a directory under `$HERMES_HOME/plugins/` holding
`plugin.yaml` + `__init__.py`; the dashboard tab is its `dashboard/` folder.
This copies exactly the plugin's runtime files plus the repo-root `skills/`
(the six framework skills, so the installed plugin does not depend on the CLI
to find them) and a build stamp the manager shows in its footer.

    python harness-plugins/hermes/scripts/build.py             # stage dist/
    python harness-plugins/hermes/scripts/build.py --install   # stage, then copy to $HERMES_HOME/plugins/agent-app

Standard library only.
"""
from __future__ import annotations

import argparse
import datetime
import os
import shutil
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
REPO = PLUGIN.parent.parent
DIST = PLUGIN / "dist"
NAME = "agent-app"

RUNTIME_FILES = (
    "plugin.yaml",
    "__init__.py",
    "engine.py",
    "README.md",
    "dashboard/manifest.json",
    "dashboard/plugin_api.py",
    "dashboard/manager.js",
    "dashboard/manager.css",
)


def hermes_home() -> Path:
    """Hermes's own resolution: HERMES_HOME, else %LOCALAPPDATA%\\hermes on
    native Windows, else ~/.hermes."""
    override = os.environ.get("HERMES_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if os.name == "nt" and local:
        return Path(local) / "hermes"
    return Path.home() / ".hermes"


def stage() -> None:
    shutil.rmtree(DIST, ignore_errors=True)
    for rel in RUNTIME_FILES:
        target = DIST / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PLUGIN / rel, target)
    shutil.copytree(REPO / "skills", DIST / "skills")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (DIST / "BUILD_STAMP").write_text(stamp + "\n", encoding="utf-8")


def install(home: Path) -> Path:
    target = home / "plugins" / NAME
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(DIST, target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--install", nargs="?", const="", metavar="HERMES_HOME",
                        help="also copy the staged plugin into <HERMES_HOME>/plugins/agent-app")
    args = parser.parse_args()
    stage()
    print(f"hermes plugin staged: {DIST}")
    if args.install is not None:
        target = install(Path(args.install).expanduser() if args.install else hermes_home())
        print(f"installed: {target}")
        print("next: `hermes plugins enable agent-app`, then restart `hermes dashboard`")
    else:
        print(f"install: copy it to {hermes_home() / 'plugins' / NAME}, or rerun with --install")
    return 0


if __name__ == "__main__":
    sys.exit(main())
