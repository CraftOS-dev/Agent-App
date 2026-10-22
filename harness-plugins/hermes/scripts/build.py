"""Stage the installable Hermes plugin into `dist/`, and optionally install it.

A Hermes user plugin is a directory under `$HERMES_HOME/plugins/` holding
`plugin.yaml` + `__init__.py`; the dashboard tab is its `dashboard/` folder.
This copies exactly the plugin's runtime files plus the repo-root `skills/`
(the six framework skills, so the installed plugin does not depend on the CLI
to find them) and a build stamp the manager shows in its footer. It also
stages `dist/webui/`, the tab as a hermes-webui extension.

    python harness-plugins/hermes/scripts/build.py             # stage dist/
    python harness-plugins/hermes/scripts/build.py --install   # stage, then copy to $HERMES_HOME/plugins/agent-app
    python harness-plugins/hermes/scripts/build.py --install --webui
        # also install the extension into hermes-webui's managed extension
        # directory ($HERMES_WEBUI_STATE_DIR, default $HERMES_HOME/webui)

Standard library only.
"""
from __future__ import annotations

import argparse
import datetime
import json
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
    "webui_backend.py",
    "README.md",
    "dashboard/manifest.json",
    "dashboard/plugin_api.py",
    "dashboard/manager.js",
    "dashboard/manager.css",
)

# The hermes-webui extension: its own files plus the dashboard's page, which
# both hosts run. Published path -> source, relative to the plugin.
WEBUI_FILES = {
    "manifest.json": "webui/manifest.json",
    "agent-apps.js": "webui/agent-apps.js",
    "agent-apps.css": "webui/agent-apps.css",
    "manager.js": "dashboard/manager.js",
    "manager.css": "dashboard/manager.css",
}
WEBUI_ID = "agent-app"
# Written at runtime by the plugin's backend; listed so the web UI's own
# Uninstall removes it with the rest.
WEBUI_RUNTIME_FILE = "runtime.json"


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


def normalize_modes(root: Path) -> None:
    """Directories 755, files 644. A source tree on a Windows drive mounted in
    WSL reports every file as 777, and Hermes runs this code: a copy that kept
    those modes would be writable by every local user."""
    if os.name == "nt":
        return
    for path in [root, *root.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)


def stage() -> None:
    shutil.rmtree(DIST, ignore_errors=True)
    for rel in RUNTIME_FILES:
        target = DIST / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PLUGIN / rel, target)
    shutil.copytree(REPO / "skills", DIST / "skills", copy_function=shutil.copyfile)
    for published, source in WEBUI_FILES.items():
        target = DIST / "webui" / published
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PLUGIN / source, target)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (DIST / "BUILD_STAMP").write_text(stamp + "\n", encoding="utf-8")


def install(home: Path) -> Path:
    target = home / "plugins" / NAME
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(DIST, target, copy_function=shutil.copyfile)
    normalize_modes(target)
    return target


def webui_state_dir(home: Path) -> Path:
    override = os.environ.get("HERMES_WEBUI_STATE_DIR", "").strip()
    return Path(override).expanduser() if override else home / "webui"


def install_webui(state_dir: Path) -> Path:
    """Install the extension into hermes-webui's managed extension directory
    and record it the way the web UI's gallery installer does, so Settings >
    Extensions lists it and can disable or uninstall it. Other installed
    extensions, and their records, are left as they are."""
    root = state_dir / "extensions"
    target = root / WEBUI_ID
    target.mkdir(parents=True, exist_ok=True)
    for published in WEBUI_FILES:
        shutil.copyfile(DIST / "webui" / published, target / published)
    normalize_modes(target)
    record_file = state_dir / "extension-install-manifest.json"
    record = {"version": 1, "installed": {}}
    if record_file.is_file():
        try:
            parsed = json.loads(record_file.read_text(encoding="utf-8"))
        except ValueError:
            sys.exit(f"{record_file} is not valid JSON; fix or remove it, then rerun")
        if isinstance(parsed, dict) and isinstance(parsed.get("installed"), dict):
            record = parsed
    version = json.loads((DIST / "webui" / "manifest.json").read_text(encoding="utf-8")).get("version", "0.0.0")
    record["installed"][WEBUI_ID] = {
        "version": version,
        "files": [*WEBUI_FILES, WEBUI_RUNTIME_FILE],
        "installed_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    tmp = record_file.with_name(f".{record_file.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, record_file)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--install", nargs="?", const="", metavar="HERMES_HOME",
                        help="also copy the staged plugin into <HERMES_HOME>/plugins/agent-app")
    parser.add_argument("--webui", nargs="?", const="", metavar="STATE_DIR",
                        help="also install the Agent Apps tab as a hermes-webui extension under "
                             "<STATE_DIR>/extensions (default: $HERMES_WEBUI_STATE_DIR, else <HERMES_HOME>/webui)")
    args = parser.parse_args()
    stage()
    print(f"hermes plugin staged: {DIST}")
    home = Path(args.install).expanduser() if args.install else hermes_home()
    if args.install is not None:
        target = install(home)
        print(f"installed: {target}")
        print("next: `hermes plugins enable agent-app`, then restart `hermes dashboard`")
    else:
        print(f"install: copy it to {hermes_home() / 'plugins' / NAME}, or rerun with --install")
    if args.webui is not None:
        target = install_webui(Path(args.webui).expanduser() if args.webui else webui_state_dir(home))
        print(f"hermes-webui extension installed: {target}")
        print('next: set HERMES_WEBUI_CSP_FRAME_EXTRA="http://127.0.0.1:* http://localhost:*" to embed apps, '
              "then restart hermes-webui (./ctl.sh restart)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
