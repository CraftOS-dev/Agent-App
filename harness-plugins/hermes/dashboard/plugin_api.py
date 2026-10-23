"""The Agent Apps dashboard tab: its backend.

`hermes dashboard` imports this file once at startup and mounts `router` at
`/api/plugins/agent-app/`. The dashboard's own auth covers every route (the
page calls them through the SDK's `fetchJSON`, which attaches the session
token), and the dashboard serves the plugin only while it is enabled.

Endpoints, all JSON:

  GET  /meta                  blueprints, build stamp, where new apps go
  GET  /apps                  registered apps merged with builds in flight
  POST /build                 start a build: the creator kickoff, in the app's session
  GET  /session?app=<path>    an app's transcript, whether a turn is running, the last error
  POST /session/send          a message into an app's session
  POST /app/serve|stop|remove lifecycle, shelling `agent-app`

Each app has its own Hermes session, with a deterministic id. A turn is one
`hermes --cli chat -Q --resume <id> --query-file -` subprocess run in the
app's directory, the same way Hermes runs its own background workers (the
kanban dispatcher), so nothing here depends on agent internals and a turn
uses the user's configured model, tools and approval policy. Turns on one
session run one at a time, in order. The transcript is read back from the
session database.
"""
from __future__ import annotations

import collections
import functools
import hashlib
import importlib.util
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from urllib.parse import parse_qs

try:
    from fastapi import APIRouter, Body
    from fastapi.responses import JSONResponse
except ImportError:  # loaded by the hermes-webui backend (../webui_backend.py), which needs only dispatch()
    APIRouter = None


def _load_engine():
    # Hermes loads this file as a standalone module, not as part of the plugin
    # package, so the shared engine one directory up is loaded by path.
    name = "hermes_agent_app_engine"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent.parent / "engine.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


engine = _load_engine()

# Sessions started here are integrations, not chats the user opened, so they
# stay out of Hermes's session lists; they live in this tab.
SESSION_SOURCE = "tool"

# How long a build may run before the manager stops showing it as building.
BUILD_WAIT_S = 2 * 60 * 60

# Environment a turn must not inherit from the host process (the dashboard, or
# a web UI that hosts the tab): the gateway-session switches a desktop or
# Chat-tab session sets process-wide (they would route the turn's approvals to
# a gateway nobody watches), a session-less `/yolo` (it would auto-approve the
# turn's dangerous commands, which only the user's own config may do), the
# delegated-child and plugin-host markers, and a TUI preference. The
# per-session routing variables are scrubbed by prefix and, when Hermes is
# importable, from its own map of them, which is what the kanban dispatcher
# scrubs too.
_SCRUBBED_ENV = frozenset({
    "HERMES_TUI", "HERMES_GATEWAY_SESSION", "HERMES_EXEC_ASK", "HERMES_INTERACTIVE",
    "HERMES_YOLO_MODE", "HERMES_DELEGATED_CHILD_CONTEXT", "HERMES_PLUGIN_HOST_PROCESS",
})
_SCRUBBED_PREFIXES = ("HERMES_SESSION_", "HERMES_UI_SESSION_", "HERMES_CRON_", "HERMES_BROWSER_CONTROL_")

# How long a cancelled turn gets to exit on SIGTERM before it is killed.
CANCEL_GRACE_S = 5.0


def _session_scoped_vars() -> frozenset[str]:
    try:
        from gateway.session_context import _VAR_MAP

        return frozenset(_VAR_MAP)
    except Exception:
        return frozenset()


def turn_env(environ: dict[str, str] | None = None) -> dict[str, str]:
    """The environment a session turn runs with: the host's, minus anything
    that belongs to the host's own sessions or approval state."""
    source = os.environ if environ is None else environ
    drop = _SCRUBBED_ENV | _session_scoped_vars()
    return {k: v for k, v in source.items() if k not in drop and not k.startswith(_SCRUBBED_PREFIXES)}


def session_id_for(path: str) -> str:
    """The app's session id: stable for the app's life, unique per directory,
    and within the `[A-Za-z0-9_-]` set Hermes uses in file names."""
    base = re.sub(r"[^A-Za-z0-9_-]+", "-", os.path.basename(os.path.normpath(path))).strip("-")[:40] or "app"
    digest = hashlib.sha1(os.path.normcase(os.path.abspath(path)).encode("utf-8")).hexdigest()[:8]
    return f"agent-app-{base}-{digest}"


def session_preamble(name: str, path: str) -> str:
    """Prepended to the first message of an app's session; later messages are
    the user's text alone."""
    return (
        f'You are working on the Agent App "{name}" at `{path}`. For a code or feature change load '
        "the **modify** skill; for using the app (data, tasks, reports) load the **operator** skill. "
        "Work through the `agent-app` and `a2app` CLIs, respect the ownership boundary, and never "
        "drive the app UI."
    )


def _is_batch(path: str) -> bool:
    return os.name == "nt" and path.lower().endswith((".cmd", ".bat"))


def _hermes_launchers() -> list[str]:
    """Where Hermes's installers put the `hermes` launcher, for a host whose
    PATH does not include it (a web UI started by a supervisor, say)."""
    out = [os.path.join(os.path.expanduser("~"), ".local", "bin", "hermes")]
    try:
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
        out += [str(home / "bin" / "hermes.exe"), str(home / "bin" / "hermes")]
    except Exception:
        pass
    return out


def hermes_argv() -> list[str]:
    """How to start Hermes. HERMES_BIN overrides, as it does for the kanban
    dispatcher. Otherwise, inside `hermes dashboard` this process IS Hermes,
    running in its own venv, so its interpreter runs the same install (and
    inherits the active profile's HERMES_HOME), and the module form never goes
    through a Windows batch shim. A host that imports Hermes into a bare
    interpreter (hermes-webui does) cannot start a child that way, so it uses
    the `hermes` launcher instead."""
    override = os.environ.get("HERMES_BIN", "").strip()
    if override:
        if override.lower().endswith(".py"):
            return [sys.executable, override]
        found = shutil.which(override) or override
        if not _is_batch(found):
            return [found]
    if sys.prefix != sys.base_prefix:
        return [sys.executable, "-m", "hermes_cli.main"]
    found = shutil.which("hermes") or next((p for p in _hermes_launchers() if os.path.isfile(p) and os.access(p, os.X_OK)), None)
    if found is not None and not _is_batch(found):
        return [found]
    return [sys.executable, "-m", "hermes_cli.main"]


def view_message(row: dict) -> dict:
    """Flatten a stored message to role, text, and tool names, so the page can
    render prose and tool activity separately."""
    role = row.get("role") if isinstance(row.get("role"), str) else ""
    content = row.get("content")
    texts: list[str] = []
    if isinstance(content, str):
        texts.append(content)
    elif isinstance(content, list):
        texts += [p["text"] for p in content if isinstance(p, dict) and isinstance(p.get("text"), str)]
    tools: list[str] = []
    for call in row.get("tool_calls") or []:
        if isinstance(call, dict):
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = fn.get("name") or call.get("name")
            if isinstance(name, str) and name:
                tools.append(name)
    if role == "tool" and isinstance(row.get("tool_name"), str) and row["tool_name"]:
        tools = [row["tool_name"]]
    return {"role": role, "text": "".join(texts), "tools": tools}


class HermesSessions:
    """App sessions in Hermes's session database (`hermes_state.SessionDB`,
    the active profile's state.db), opened per call as the dashboard does."""

    @staticmethod
    def _db():
        from hermes_state import SessionDB

        return SessionDB()

    def ensure(self, sid: str, title: str) -> None:
        db = self._db()
        try:
            if db.get_session(sid) is None:
                db.create_session(sid, source=SESSION_SOURCE)
                try:
                    db.set_session_title(sid, title)
                except Exception:  # a title clash must not stop the build
                    pass
        finally:
            db.close()

    def messages(self, sid: str) -> list[dict]:
        db = self._db()
        try:
            if db.get_session(sid) is None:
                return []
            # Compacted rows are display history; dropping them would make
            # earlier turns vanish once a long build compacts its context.
            return db.get_messages(sid, include_compacted=True)
        finally:
            db.close()

    def delete(self, sid: str) -> None:
        db = self._db()
        try:
            if db.get_session(sid) is not None:
                db.delete_session(sid)
        finally:
            db.close()


def _stop_tree(proc: subprocess.Popen, grace: float = CANCEL_GRACE_S) -> None:
    """Stop a turn and everything it started. On POSIX the turn leads its own
    process group: SIGTERM, then SIGKILL if the group outlives `grace`. Windows
    has no graceful stop for a windowless tree, so it is killed outright."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except OSError:
        proc.terminate()
        return

    def escalate() -> None:
        try:
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()

    threading.Thread(target=escalate, name=f"agent-app:kill:{proc.pid}", daemon=True).start()


class _Session:
    def __init__(self) -> None:
        self.queue: collections.deque = collections.deque()
        self.proc: subprocess.Popen | None = None
        self.working = False
        self.error: str | None = None


class TurnRunner:
    """Runs Hermes turns as subprocesses, one at a time per session, in the
    order they were sent. Each run's output is appended to
    `<data_dir>/logs/<session>.log`; a failed run's tail is kept as the
    session's last error, so the page can say why nothing happened (no model
    configured, no credentials, ...)."""

    def __init__(self, data_dir: Path, argv: Callable[[], list[str]] = hermes_argv) -> None:
        self._logs = data_dir / "logs"
        self._argv = argv
        self._lock = threading.Lock()
        self._sessions: dict[str, _Session] = {}

    def _state(self, sid: str) -> _Session:
        state = self._sessions.get(sid)
        if state is None:
            state = self._sessions[sid] = _Session()
        return state

    def submit(self, sid: str, message: str, cwd: str, on_done: Callable[[bool], None] | None = None) -> None:
        with self._lock:
            state = self._state(sid)
            state.queue.append((message, cwd, on_done))
            if state.working:
                return
            state.working = True
        threading.Thread(target=self._drain, args=(sid, state), name=f"agent-app:{sid}", daemon=True).start()

    def busy(self, sid: str) -> bool:
        with self._lock:
            state = self._sessions.get(sid)
            return state is not None and state.working

    def error(self, sid: str) -> str | None:
        with self._lock:
            state = self._sessions.get(sid)
            return state.error if state is not None else None

    def cancel(self, sid: str, wait: float = 0.0) -> None:
        """Drop queued turns and stop the running one (with its children).
        With `wait`, block up to that many seconds for it to exit, so the
        caller can safely remove what the turn was working on."""
        with self._lock:
            state = self._sessions.pop(sid, None)
            if state is None:
                return
            state.queue.clear()
            proc = state.proc
        if proc is None or proc.poll() is not None:
            return
        _stop_tree(proc)
        if wait > 0:
            try:
                proc.wait(timeout=wait)
            except subprocess.TimeoutExpired:
                pass

    def _owns(self, sid: str, state: _Session) -> bool:
        # A cancel pops the state, and a later submit may install a new one:
        # a drain thread works only for the state it was started for, or two
        # threads would run turns on one session at once.
        return self._sessions.get(sid) is state

    def _drain(self, sid: str, state: _Session) -> None:
        while True:
            with self._lock:
                if not self._owns(sid, state):
                    return  # cancelled
                if not state.queue:
                    state.working = False
                    state.proc = None
                    return
                message, cwd, on_done = state.queue.popleft()
            ok = self._turn(sid, state, message, cwd)
            if on_done is not None:
                try:
                    on_done(ok)
                except Exception:
                    pass

    def _turn(self, sid: str, state: _Session, message: str, cwd: str) -> bool:
        self._logs.mkdir(parents=True, exist_ok=True)
        log_path = self._logs / f"{sid}.log"
        cmd = [
            *self._argv(),
            "--cli",
            "chat",
            "-Q",
            "--resume", sid,
            "--source", SESSION_SOURCE,
            "--in", cwd,
            # The message goes in on stdin: arbitrary text, never re-parsed.
            "--query-file", "-",
        ]
        env = turn_env()
        windows = os.name == "nt"
        with open(log_path, "ab") as log:
            start = log.tell()
            log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')}  cwd={cwd}\n".encode("utf-8"))
            log.flush()
            try:
                proc = subprocess.Popen(
                    cmd,
                    cwd=cwd,
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=not windows,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if windows else 0,
                )
            except OSError as exc:
                with self._lock:
                    state.error = f"could not start Hermes ({' '.join(cmd[:3])}): {exc}"
                return False
            with self._lock:
                state.proc = proc
                cancelled = not self._owns(sid, state)
            if cancelled:  # cancelled while it was starting, before it could be found
                _stop_tree(proc)
            try:
                proc.communicate(input=message.encode("utf-8"))
            except OSError:
                proc.wait()
            code = proc.returncode
        if code == 0:
            with self._lock:
                state.error = None
            return True
        with open(log_path, "rb") as log:
            log.seek(start)
            tail = log.read().decode("utf-8", errors="replace").strip().splitlines()
        detail = "\n".join(line for line in tail[-12:] if not line.startswith("=== "))
        with self._lock:
            state.error = f"the turn exited with code {code}" + (f":\n{detail}" if detail else "")
        return False


class Manager:
    """The tab's state: builds in flight plus each app's session."""

    def __init__(self, runner: TurnRunner, sessions: Any) -> None:
        self.runner = runner
        self.sessions = sessions
        self.builds: dict[str, dict] = {}
        # Sessions this process has seeded with the preamble, so a send right
        # after a build (before its first turn is stored) does not prepend it.
        self.seeded: set[str] = set()
        self._lock = threading.Lock()

    @classmethod
    def default(cls) -> "Manager":
        try:
            from hermes_constants import get_hermes_home

            data_dir = Path(get_hermes_home()) / "plugin-data" / "agent-app"
        except Exception:
            data_dir = engine.apps_dir().parent / "hermes-plugin"
        return cls(TurnRunner(data_dir), HermesSessions())

    def meta(self) -> dict:
        return {"ok": True, "blueprints": list(engine.FRAMEWORK_BLUEPRINTS), "build": engine.build_stamp(), "appsDir": str(engine.apps_dir())}

    def rows(self) -> list[dict]:
        """Registered apps merged with builds not yet in the registry. A build
        retires once its app is seen running."""
        apps = engine.list_known_apps()
        now = time.time()
        with self._lock:
            for app in apps:
                if app.get("status") == "running":
                    self.builds.pop(app["path"], None)
            for build in self.builds.values():
                if not build["ended"] and now - build["started"] > BUILD_WAIT_S:
                    build["ended"] = True
            builds = {path: dict(b) for path, b in self.builds.items()}
        out = []
        for app in apps:
            build = builds.get(app["path"])
            out.append({**app, "building": build is not None and not build["ended"], "buildEnded": bool(build and build["ended"])})
        known = {app["path"] for app in apps}
        for path, build in builds.items():
            if path in known:
                continue
            out.append({
                "id": os.path.basename(path), "name": build["name"], "path": path, "url": None,
                "status": "stopped", "building": not build["ended"], "buildEnded": build["ended"],
            })
        return out

    def start_build(self, body: dict) -> tuple[int, dict]:
        name = str(body.get("name") or "").strip()
        slug = engine.slugify(name)
        if not slug:
            return 400, {"ok": False, "message": "Give the app a name."}
        directory = str(engine.apps_dir() / slug)
        kick = engine.build_kickoff_prompt({
            "action": "build", "name": name, "requirement": body.get("requirement"),
            "blueprint": body.get("blueprint"), "port": body.get("port"),
        })
        if kick["kind"] == "error":
            return 400, {"ok": False, "message": kick["message"]}
        sid = session_id_for(directory)
        entry = {"name": name, "dir": directory, "ended": False, "started": time.time()}
        # Checked and claimed in one step: two quick submits of one name must
        # not both start a build of the same directory.
        with self._lock:
            if directory in self.builds:
                return 400, {"ok": False, "message": f'"{name}" is already being built.'}
            if os.path.exists(directory):
                return 400, {"ok": False, "message": f'An app directory named "{slug}" already exists.'}
            self.builds[directory] = entry
            self.seeded.add(sid)
        try:
            engine.apps_dir().mkdir(parents=True, exist_ok=True)
            self.sessions.ensure(sid, f"Agent App: {name}")
        except Exception:
            with self._lock:
                self.builds.pop(directory, None)
                self.seeded.discard(sid)
            raise
        prompt = f"{kick['prompt']}\n\nCreate the app at `{directory}`: pass that directory to every agent-app command."

        def done(_ok: bool) -> None:
            with self._lock:
                entry["ended"] = True

        self.runner.submit(sid, prompt, str(engine.apps_dir()), on_done=done)
        return 200, {"ok": True, "path": directory}

    def send(self, body: dict) -> tuple[int, dict]:
        path = str(body.get("path") or "")
        text = str(body.get("text") or "").strip()
        if not path:
            return 400, {"ok": False, "message": "no app selected"}
        if not text:
            return 400, {"ok": False, "message": "empty message"}
        sid = session_id_for(path)
        name = str(body.get("name") or os.path.basename(path))
        with self._lock:
            seeded = sid in self.seeded
        if not seeded and not self.sessions.messages(sid):
            text = f"{session_preamble(name, path)}\n\n{text}"
        self.sessions.ensure(sid, f"Agent App: {name}")
        with self._lock:
            self.seeded.add(sid)
        # Before a build's scaffold step the app directory may not exist yet.
        self.runner.submit(sid, text, path if os.path.isdir(path) else str(engine.apps_dir()))
        return 200, {"ok": True}

    def transcript(self, path: str) -> dict:
        sid = session_id_for(path)
        messages = [m for m in map(view_message, self.sessions.messages(sid)) if m["text"] or m["tools"]]
        return {"ok": True, "messages": messages[-200:], "busy": self.runner.busy(sid), "error": self.runner.error(sid)}

    def lifecycle(self, verb: str, path: str) -> tuple[int, dict]:
        registered = any(app["path"] == path for app in engine.list_known_apps())
        if verb in ("serve", "stop"):
            if not registered:
                return 404, {"ok": False, "message": "unknown app"}
            result = engine.run_framework([path, verb])
            return (200 if result.ok else 500), {"ok": result.ok, "message": "" if result.ok else (result.stderr or result.stdout).strip()}
        with self._lock:
            building = path in self.builds
        if not registered and not building:
            return 404, {"ok": False, "message": "unknown app"}
        sid = session_id_for(path)
        # The agent stops first: a turn still running would go on writing to,
        # serving, or re-registering the app while it is being removed.
        self.runner.cancel(sid, wait=2 * CANCEL_GRACE_S)
        if registered:
            engine.run_framework([path, "stop"])
            # `remove --yes` backs the app's data up outside the app before deleting it.
            result = engine.run_framework([path, "remove", "--yes"])
            if not result.ok:
                return 500, {"ok": False, "message": (result.stderr or result.stdout).strip()}
        elif os.path.isdir(path) and Path(path).resolve().parent == engine.apps_dir().resolve():
            # A build stopped before it registered the app. What it left is a
            # partial scaffold in the directory this manager chose for it, and
            # leaving it would refuse a rebuild under the same name.
            shutil.rmtree(path, ignore_errors=True)
        with self._lock:
            self.builds.pop(path, None)
            self.seeded.discard(sid)
        try:
            self.sessions.delete(sid)
        except Exception:
            pass  # no session to delete
        return 200, {"ok": True}


def _reply(status: int, payload: dict) -> JSONResponse:
    return JSONResponse(status_code=status, content=payload)


def _guarded(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Report a failure as the page's JSON shape, never as a bare 500 page."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            return _reply(500, {"ok": False, "message": str(exc) or exc.__class__.__name__})

    return wrapper


def build_router(manager: Manager) -> APIRouter:
    # Plain `def` routes: FastAPI runs them on its thread pool, so the CLI
    # calls they make never block the dashboard's event loop.
    r = APIRouter()

    @r.get("/meta")
    @_guarded
    def meta() -> Any:
        return manager.meta()

    @r.get("/apps")
    @_guarded
    def apps() -> Any:
        return {"ok": True, "rows": manager.rows()}

    @r.get("/session")
    @_guarded
    def session(app: str = "") -> Any:
        return manager.transcript(app)

    @r.post("/build")
    @_guarded
    def build(body: dict | None = Body(default=None)) -> Any:
        return _reply(*manager.start_build(body or {}))

    @r.post("/session/send")
    @_guarded
    def send(body: dict | None = Body(default=None)) -> Any:
        return _reply(*manager.send(body or {}))

    @r.post("/app/{verb}")
    @_guarded
    def app_action(verb: str, body: dict | None = Body(default=None)) -> Any:
        if verb not in ("serve", "stop", "remove"):
            return _reply(404, {"ok": False, "message": "unknown endpoint"})
        return _reply(*manager.lifecycle(verb, str((body or {}).get("path") or "")))

    return r


def dispatch(manager: Manager, method: str, path: str, query: str = "", body: Any = None) -> tuple[int, dict]:
    """The same routes as `build_router`, for a host with no FastAPI app to
    mount a router on (the hermes-webui backend). `path` is relative to
    `/api/plugins/agent-app`."""
    body = body if isinstance(body, dict) else {}
    try:
        if method == "GET" and path == "/meta":
            return 200, manager.meta()
        if method == "GET" and path == "/apps":
            return 200, {"ok": True, "rows": manager.rows()}
        if method == "GET" and path == "/session":
            app = (parse_qs(query).get("app") or [""])[0]
            return 200, manager.transcript(app)
        if method == "POST" and path == "/build":
            return manager.start_build(body)
        if method == "POST" and path == "/session/send":
            return manager.send(body)
        if method == "POST" and path.startswith("/app/"):
            verb = path[len("/app/"):]
            if verb not in ("serve", "stop", "remove"):
                return 404, {"ok": False, "message": "unknown endpoint"}
            return manager.lifecycle(verb, str(body.get("path") or ""))
        return 404, {"ok": False, "message": "unknown endpoint"}
    except Exception as exc:
        return 500, {"ok": False, "message": str(exc) or exc.__class__.__name__}


# One manager per process: the dashboard mounts `router`, and the hermes-webui
# backend dispatches to the same MANAGER.
MANAGER = Manager.default()
router = build_router(MANAGER) if APIRouter is not None else None
