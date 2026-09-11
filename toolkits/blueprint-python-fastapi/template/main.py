"""FastAPI wiring (SYSTEM-OWNED — hash-locked in the ownership canon).

Mounts the A2App adapter (`a2app_adapter.py`) on FastAPI. The adapter owns the
protocol; this file only translates HTTP <-> the adapter's `dispatch()`. Run:
`uvicorn main:app --port $PORT`.
"""
import json
import os
import secrets
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from a2app_adapter import Adapter, Store
import schema

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "manifest.json").read_text())
PORT = int(os.environ.get("PORT", manifest.get("port", 8090)))


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
    store=Store(schema.SEED),
    token=_agent_token(),
    # Modules are declared in the manifest and are what describe's root level
    # lists; every entity and operation names one.
    modules=manifest.get("modules", []),
    allowed_origins=[f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"],
    operation_runners=schema.OPERATION_RUNNERS,
)

app = FastAPI(title=manifest["name"])


# A protocol write is tiny; anything larger is a mistake or an attack. Reading
# the body happens before the origin, credential and rate checks — the path does
# not even have to exist — so an unauthenticated caller must never be able to
# make the app buffer an arbitrary amount of memory. adapter-core caps at the
# same size for the same reason (adapters/adapter-core/src/http.ts).
MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024


async def _read_body(request: Request):
    """Parse the request body under a cap.

    Returns ``(body, None)``, or ``(None, reply)`` when the body is too large.
    Bytes are counted as they arrive rather than trusting Content-Length, so a
    client that lies about the length gains nothing.
    """
    size = 0
    chunks = []
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_REQUEST_BODY_BYTES:
            return None, (
                413,
                {
                    "a2app": True,
                    "ok": False,
                    "code": "payload_too_large",
                    "message": f"Request body exceeds the {MAX_REQUEST_BODY_BYTES}-byte limit.",
                    "limitBytes": MAX_REQUEST_BODY_BYTES,
                },
            )
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw.strip():
        return {}, None
    try:
        return json.loads(raw), None
    except ValueError:
        # Hand the guard something it can reject by its own rules, rather than
        # raising into a 500 that tells the caller nothing. Same envelope as
        # adapter-core's parser.
        return {"__unparsed__": raw.decode("utf8", "replace")}, None


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
async def a2app_route(path: str, request: Request):
    body = None
    if request.method in ("POST", "PATCH"):
        body, too_large = await _read_body(request)
        if too_large is not None:
            return JSONResponse(status_code=too_large[0], content=too_large[1])
    status, payload = adapter.dispatch(
        request.method, f"/api/{path}", dict(request.headers), body, dict(request.query_params)
    )
    return JSONResponse(status_code=status, content=payload)


@app.get("/.well-known/a2app.json")
async def wellknown():
    return JSONResponse(content=adapter.identity())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
