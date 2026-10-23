"""The Agent Apps tab's backend inside hermes-webui.

hermes-webui hosts the tab as an extension (webui/), a script in its main
page, and never mounts a plugin's API. So when this plugin loads inside the
hermes-webui server process, it serves the dashboard's routes itself, on a
loopback port, through the same Manager the dashboard uses
(`dashboard/plugin_api.dispatch`), and tells the extension where in
`runtime.json`, written into the extension's own directory. The web UI serves
that file like the extension's scripts, so the backend is exactly as protected
as the web UI itself.

Every request must carry the token from that file, come from the web UI's own
origin (or carry no Origin, a local tool), and name a loopback Host (a DNS
rebinding page names its own). Nothing here starts outside the web UI server:
Hermes loads the plugin in every process, including the `hermes` turns this
backend starts, and those inherit the web UI's environment.

Standard library only: it runs in whatever interpreter the web UI runs.
"""
from __future__ import annotations

import hmac
import importlib.util
import json
import logging
import os
import secrets
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

PLUGIN_ROOT = Path(__file__).resolve().parent
EXTENSION_ID = "agent-app"
API_PREFIX = "/api/plugins/agent-app"
RUNTIME_FILE = "runtime.json"
MAX_BODY = 1 << 20
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")

# The running backend, kept in sys.modules so a second load of the plugin in
# the same process (a fresh copy of this module) finds it instead of starting
# another; and one lock for all copies, so two loads cannot both start one.
_HOLDER = "agent_app_webui_backend_running"
_LOCK = sys.modules.setdefault("agent_app_webui_backend_lock", types.ModuleType("agent_app_webui_backend_lock")).__dict__.setdefault("lock", threading.Lock())


def in_webui_server(argv: list[str] | None = None) -> bool:
    """True in the hermes-webui server process, which runs `server.py` from its
    checkout (through runpy, with that argv). AGENT_APP_WEBUI_BACKEND=0 opts out."""
    if os.environ.get("AGENT_APP_WEBUI_BACKEND", "").strip() == "0":
        return False
    argv = sys.argv if argv is None else argv
    if not argv or not argv[0]:
        return False
    script = Path(argv[0])
    try:
        return script.name == "server.py" and (script.resolve().parent / "api" / "extensions.py").is_file()
    except OSError:
        return False


def extension_root() -> Path:
    """The web UI's extension directory, resolved as the web UI resolves it:
    HERMES_WEBUI_EXTENSION_DIR, else its managed STATE_DIR/extensions, where
    STATE_DIR is HERMES_WEBUI_STATE_DIR, else $HERMES_HOME/webui. From the
    environment only: importing the web UI's own modules from a plugin can
    deadlock against the web UI's imports (see maybe_start)."""
    raw = os.environ.get("HERMES_WEBUI_EXTENSION_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    state = os.environ.get("HERMES_WEBUI_STATE_DIR", "").strip()
    if state:
        return Path(state).expanduser() / "extensions"
    home = os.environ.get("HERMES_HOME", "").strip()
    return (Path(home).expanduser() if home else Path.home() / ".hermes") / "webui" / "extensions"


def extension_dir() -> Path | None:
    """This plugin's installed extension, or None when it is not installed."""
    directory = extension_root() / EXTENSION_ID
    return directory if (directory / "manifest.json").is_file() else None


def allowed_origins(environ: dict[str, str] | None = None) -> frozenset[str]:
    """The web UI's own origins (its loopback host names on its port), plus
    AGENT_APP_WEBUI_ORIGINS for a web UI reached some other way."""
    env = os.environ if environ is None else environ
    port = env.get("HERMES_WEBUI_PORT", "").strip() or "8787"
    extra = env.get("AGENT_APP_WEBUI_ORIGINS", "").replace(",", " ").split()
    return frozenset({f"http://{host}:{port}" for host in LOOPBACK_HOSTS} | {o.rstrip("/") for o in extra})


def _data_dir() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()) / "plugin-data" / "agent-app"
    except Exception:
        return Path.home() / ".hermes" / "plugin-data" / "agent-app"


def _write_private(file: Path, text: str) -> None:
    """Write via a temp file and a rename, readable only by this user."""
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_name(f".{file.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, file)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def load_token(data_dir: Path) -> str:
    """A token kept across restarts, so an open page's copy stays good."""
    file = data_dir / "webui-backend.token"
    try:
        token = file.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    _write_private(file, token + "\n")
    return token


def _load_plugin_api():
    name = "hermes_agent_app_plugin_api"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def _host_name(header: str) -> str:
    host = header.strip().lower()
    if host.startswith("["):
        return host.split("]", 1)[0] + "]"
    return host.rsplit(":", 1)[0]


def make_handler(dispatch, token: str, origins: frozenset[str]):
    """A request handler serving `dispatch(method, path, query, body)` under
    API_PREFIX, behind the token, origin, and Host checks."""
    expected = ("Bearer " + token).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        server_version = "agent-app-webui"

        def log_message(self, fmt: str, *args: Any) -> None:
            logger.debug("agent-app webui backend: " + fmt, *args)

        def _origin(self) -> tuple[bool, str | None]:
            origin = self.headers.get("Origin")
            if origin is None:
                return True, None
            return origin in origins, origin

        def _host_ok(self) -> bool:
            return _host_name(self.headers.get("Host") or "") in LOOPBACK_HOSTS

        def _cors(self, origin: str | None) -> None:
            if origin is not None:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _send(self, status: int, payload: dict, origin: str | None = None) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self._cors(origin)
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self) -> None:  # noqa: N802 (http.server naming)
            ok, origin = self._origin()
            if not (ok and origin is not None and self._host_ok()):
                self._send(403, {"ok": False, "message": "forbidden"})
                return
            self.send_response(204)
            self._cors(origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            self._handle("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._handle("POST")

        def _handle(self, method: str) -> None:
            ok, origin = self._origin()
            if not ok or not self._host_ok():
                self._send(403, {"ok": False, "message": "forbidden"})
                return
            given = (self.headers.get("Authorization") or "").encode("utf-8", "surrogateescape")
            if not hmac.compare_digest(given, expected):
                self._send(401, {"ok": False, "message": "missing or wrong token"}, origin)
                return
            parts = urlsplit(self.path)
            if not parts.path.startswith(API_PREFIX + "/"):
                self._send(404, {"ok": False, "message": "unknown endpoint"}, origin)
                return
            body: Any = None
            if method == "POST":
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    length = -1
                if length < 0 or length > MAX_BODY:
                    self._send(413, {"ok": False, "message": "request body too large"}, origin)
                    return
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else {}
                except ValueError:
                    self._send(400, {"ok": False, "message": "the body is not JSON"}, origin)
                    return
            status, payload = dispatch(method, parts.path[len(API_PREFIX):], parts.query, body)
            self._send(status, payload, origin)

    return Handler


class Backend:
    """One loopback server for the tab, on a daemon thread."""

    def __init__(self, dispatch, token: str, origins: frozenset[str], port: int = 0) -> None:
        handler = make_handler(dispatch, token, origins)
        try:
            self.server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        except OSError:
            if port == 0:
                raise
            logger.warning("agent-app: port %s is taken; the hermes-webui backend uses a free one", port)
            self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.token = token
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, name="agent-app:webui-backend", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def maybe_start() -> dict | None:
    """Start the backend when this process is the hermes-webui server and the
    extension is installed; publish where it listens. Returns what was
    published, or None when there is nothing to do here.

    Never call this from `register()` itself: the web UI loads plugins midway
    through its own imports, and Hermes waits at most 10s for `register()`.
    This imports (the dashboard module, FastAPI when present), and an import
    that needs a module the web UI is still importing would wait on the web
    UI while the web UI waits on the plugin. `start_in_background` runs it
    off the load path."""
    if not in_webui_server():
        return None
    with _LOCK:
        running = sys.modules.get(_HOLDER)
        if running is not None:
            return running.info
        return _start()


def start_in_background(on_started=None) -> threading.Thread | None:
    """maybe_start() on its own thread, when this is the web UI server."""
    if not in_webui_server():
        return None

    def run() -> None:
        try:
            info = maybe_start()
        except Exception as exc:  # the tab is optional; the plugin's other surfaces are not
            logger.warning("agent-app: the hermes-webui tab backend did not start: %s", exc)
            return
        if info is not None and on_started is not None:
            on_started(info)

    thread = threading.Thread(target=run, name="agent-app:webui-backend-start", daemon=True)
    thread.start()
    return thread


def _start() -> dict | None:
    directory = extension_dir()
    if directory is None:
        logger.info("agent-app: the Agent Apps extension is not installed in hermes-webui; no tab backend")
        return None
    api = _load_plugin_api()
    manager = api.MANAGER
    try:
        port = int(os.environ.get("AGENT_APP_WEBUI_BACKEND_PORT", "").strip() or 0)
    except ValueError:
        port = 0
    backend = Backend(
        lambda method, path, query, body: api.dispatch(manager, method, path, query, body),
        load_token(_data_dir()),
        allowed_origins(),
        port,
    )
    info = {"base": backend.base, "token": backend.token}
    _write_private(directory / RUNTIME_FILE, json.dumps(info) + "\n")
    holder = types.ModuleType(_HOLDER)
    holder.info = {"base": backend.base, "runtime": str(directory / RUNTIME_FILE)}
    holder.backend = backend
    sys.modules[_HOLDER] = holder
    return holder.info
