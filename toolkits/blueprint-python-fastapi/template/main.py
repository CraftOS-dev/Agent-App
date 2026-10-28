"""FastAPI wiring (SYSTEM-OWNED — hash-locked in the ownership canon).

Mounts the A2App adapter (`a2app_adapter.py`) on FastAPI. The adapter owns the
protocol; this file only translates HTTP <-> the adapter's `dispatch()`, and
serves the framework's account page (`a2app-account.html`). Run:
`python main.py` — the `__main__` block below binds uvicorn to the environment's
`PORT` (what `agent-app <dir> serve` sets), so the start command needs no shell
variable and is portable across POSIX shells and cmd.exe.

The launch contract (`serve` and `dev` both set these; defaults cover a direct
`python main.py`):
  A2APP_DATA_DIR  where records live (SQLite at <dir>/db.sqlite). `serve`
                  passes the toolkit's declared lifecycle dataDir ("data" —
                  what backup/restore/promote protect); `dev` passes a fresh
                  per-boot directory, which is how a dev instance runs against
                  a disposable database that re-seeds from empty.
"""
import json
import os
import secrets
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import RedirectResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from a2app_adapter import ACCOUNT_URL, Adapter, SqliteStore, js_trim, network_policy, static_reply, to_json
import schema

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "manifest.json").read_text())
PORT = int(os.environ.get("PORT", manifest.get("port", 8090)))

# Where to listen, and the address people and agents use (A2APP_HOST,
# A2APP_PUBLIC_URL). A combination that would send the agent token across a
# network in clear is refused here, before anything is opened.
try:
    HOST, PUBLIC_URL = network_policy(os.environ.get("A2APP_HOST"), os.environ.get("A2APP_PUBLIC_URL"))
except ValueError as e:
    sys.exit(str(e))
DATA_DIR = Path(os.environ.get("A2APP_DATA_DIR", HERE / "data")).resolve()


def _agent_token() -> str:
    f = HERE / ".agent-token"
    if f.exists():
        return f.read_text().strip()
    token = "a2app_" + secrets.token_hex(24)
    f.write_text(token + "\n")
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass
    return token


adapter = Adapter(
    app_id=manifest["id"],
    app_name=manifest["name"],
    entities=schema.ENTITIES,
    operations=schema.OPERATIONS,
    # Durable store: records and the adapter's own state (credentials,
    # accounts, tasks, events, approvals, idempotency keys, the audit log) in
    # SQLite inside the lifecycle dataDir. Seeded only when this boot CREATED
    # the database file.
    store=SqliteStore(str(DATA_DIR / "db.sqlite"), schema.SEED),
    token=_agent_token(),
    # Modules are declared in the manifest and are what describe's root level
    # lists; every entity and operation names one.
    modules=manifest.get("modules", []),
    allowed_origins=[f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"],
    public_url=PUBLIC_URL,
    operation_runners=schema.OPERATION_RUNNERS,
    # The event types this app may emit. A runner's `store.trigger` refuses a
    # type that is not declared here, so the set of things the app can ever ask
    # an agent to react to is fixed by its author in `schema.py`.
    events=schema.EVENTS,
    # `none`, or `multi-user`: accounts, sign-in and per-person records.
    auth_mode=manifest.get("authMode", "none"),
    # What each capability's agent may do (spec/v0_2/auth.md §6.2).
    capabilities=getattr(schema, "CAPABILITIES", {}),
    # What each person may do (spec/v0_2/auth.md §3), when the schema says;
    # every agent acting for them is limited to the same.
    permissions_of=getattr(schema, "permissions_of", None),
)

# The framework's account page: sign in, accept an invite, people (owner), the
# agents acting for you, approving an agent's sign-in. The same file in every
# blueprint, read once at boot like the rest of this process's code.
ACCOUNT_PAGE_FILE = HERE / "a2app-account.html"
ACCOUNT_PAGE = ACCOUNT_PAGE_FILE.read_bytes()
ACCOUNT_PAGE_MODIFIED = ACCOUNT_PAGE_FILE.stat().st_mtime

# A protocol write is tiny; anything larger is a mistake or an attack. Reading
# the body happens before the origin, credential and rate checks — the path does
# not even have to exist — so an unauthenticated caller must never be able to
# make the app buffer an arbitrary amount of memory. Past the cap the rest is
# drained, unkept, so the 413 reaches a client still uploading — up to a hard
# ceiling, past which the upload is abusive and reading stops. adapter-core
# caps the same way (adapters/adapter-core/src/http.ts).
MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
HARD_READ_CEILING_BYTES = MAX_REQUEST_BODY_BYTES * 4


def _json(status: int, payload, headers=None) -> Response:
    # JSON as JSON.stringify writes it: a value with no JSON form (a number
    # that is not finite) is null rather than a 500.
    return Response(to_json(payload).encode("utf-8"), status_code=status, headers=headers, media_type="application/json")


async def _read_body(receive):
    """The request body, read under the cap: ``(bytes, too_large)``. Bytes are
    counted as they arrive rather than trusting Content-Length, so a client
    that lies about the length gains nothing."""
    chunks, total, over = [], 0, False
    while True:
        message = await receive()
        if message["type"] != "http.request":
            break
        chunk = message.get("body", b"")
        total += len(chunk)
        if not over and total > MAX_REQUEST_BODY_BYTES:
            over = True
            chunks.clear()  # stop keeping bytes
        if over and total > HARD_READ_CEILING_BYTES:
            break
        if not over:
            chunks.append(chunk)
        if not message.get("more_body", False):
            break
    return b"".join(chunks), over


def _not_json(name: str):
    raise ValueError(f"{name} is not JSON")


def _parse_body(raw: bytes):
    """The parsed body; None when there is none. A body that is not JSON is
    handed to the guard as ``{"__unparsed__": text}``, so the adapter's own
    rules refuse it (400 unknown_field) rather than a 500 here. Same envelope
    as adapter-core's parser, which also knows no NaN or Infinity."""
    text = raw.decode("utf-8", "replace")
    if js_trim(text) == "":
        return None
    try:
        return json.loads(text, parse_constant=_not_json)
    except (ValueError, RecursionError):
        return {"__unparsed__": text}


def _replay(body: bytes, receive):
    """A receive channel that hands the already-read body to the next app."""
    sent = False

    async def replayed():
        nonlocal sent
        if sent:
            return await receive()
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return replayed


class A2AppMiddleware:
    """Every request meets the adapter first, as adapter-core's middleware
    does: its body is read under the cap, its Host is checked whatever the
    path, and the adapter answers everything in its namespaces. Any other path
    falls through to this app's own routes below.

    The adapter is handed the path as sent, still percent-encoded: it decodes
    each segment after splitting, so an escaped `/` stays inside a record id.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw, too_large = await _read_body(receive)
        if too_large:
            # Close the connection after answering: the client may still be
            # uploading the rejected body, and there is no point reading it.
            refusal = {
                "a2app": True, "ok": False, "code": "payload_too_large",
                "message": f"Request body exceeds the {MAX_REQUEST_BODY_BYTES}-byte limit.",
                "limitBytes": MAX_REQUEST_BODY_BYTES,
            }
            await _json(413, refusal, {"connection": "close"})(scope, receive, send)
            return
        request = Request(scope)
        path = (scope.get("raw_path") or scope["path"].encode()).decode("latin-1")
        # Off the event loop: a sign-in spends a few hundred milliseconds hashing
        # a password, and the app keeps answering everyone else meanwhile (the
        # adapter serializes access to its own state).
        reply = await run_in_threadpool(
            adapter.dispatch, scope["method"], path, dict(request.headers), _parse_body(raw), dict(request.query_params)
        )
        if reply is None:
            await self.app(scope, _replay(raw, receive), send)
            return
        status, payload, headers = reply
        await _json(status, payload, headers)(scope, receive, send)


# No generated docs: /docs, /redoc and /openapi.json would publish the route
# list to anyone who asked. No slash redirects: the adapter strips a trailing
# slash itself, as adapter-core does, rather than answering 307.
app = FastAPI(title=manifest["name"], docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
app.add_middleware(A2AppMiddleware)

# Every standard method, so a route decides for itself rather than Starlette
# answering 405 outside the a2app envelope.
ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


@app.api_route(ACCOUNT_URL, methods=ALL_METHODS)
async def account_page(request: Request):
    # Served like a static file, with validators: a reload re-checks, and an
    # unchanged page costs a bodyless 304.
    status, headers, body = static_reply(
        request.method, dict(request.headers), ACCOUNT_PAGE, ACCOUNT_PAGE_MODIFIED, "text/html; charset=utf-8"
    )
    return Response(body, status_code=status, headers=headers)


@app.api_route("/", methods=ALL_METHODS)
async def home(request: Request):
    # This stack has no View of its own, so a person who lands on the app (the
    # account page sends them to "/" after signing in) reaches the account page.
    if request.method not in ("GET", "HEAD"):
        status, headers, body = static_reply(request.method, {}, b"", 0, "")
        return Response(body, status_code=status, headers=headers)
    return RedirectResponse(ACCOUNT_URL, status_code=302)


@app.exception_handler(StarletteHTTPException)
async def route_miss(request: Request, exc: StarletteHTTPException):
    # A path no route serves answers in the a2app envelope, as the reference's
    # static fallthrough does.
    if exc.status_code == 404:
        return _json(404, {"a2app": True, "ok": False, "code": "not_found", "message": "No such route."})
    if exc.status_code == 405:
        refusal = {"a2app": True, "ok": False, "code": "method_not_allowed", "message": f"{request.method} is not allowed here."}
        return _json(405, refusal, exc.headers)
    return await http_exception_handler(request, exc)


@app.exception_handler(Exception)
async def server_error(request: Request, exc: Exception):
    # A fault outside the adapter (which answers its own) is still a
    # machine-readable reply, never a framework error page.
    return _json(500, {"a2app": True, "ok": False, "code": "adapter_error", "message": str(exc)})


if __name__ == "__main__":
    import uvicorn

    # Bind the address network_policy resolved (loopback unless the owner
    # deliberately exposed the app).
    uvicorn.run(app, host=HOST, port=PORT)
