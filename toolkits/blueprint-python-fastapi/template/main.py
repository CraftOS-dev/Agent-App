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


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
async def a2app_route(path: str, request: Request):
    body = None
    if request.method in ("POST", "PATCH"):
        raw = await request.body()
        body = json.loads(raw) if raw else {}
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
