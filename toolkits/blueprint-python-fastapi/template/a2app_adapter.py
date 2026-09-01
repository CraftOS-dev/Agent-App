"""A2App adapter (SYSTEM-OWNED — hash-locked in the ownership canon).

A dependency-free port of the A2App served surface: identity, describe, whoami,
context, guarded records CRUD, declared operations (with approval for
destructive ops), and the app->agent task/event plane. It enforces the fixed
validation chain: origin -> credential -> scope -> guard -> backend -> read-back.

The pure validation rules below MUST match `@a2app/rules` so a FastAPI app and a
Node app reject identical payloads identically — verified by the conformance
suite. FastAPI wiring lives in `main.py`; this file never imports FastAPI. An
agent evolves the app by editing `schema.py`, never this file.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from urllib.parse import parse_qs

RULES_VERSION = "0.1.0"
PROTOCOL_VERSION = "0.1"
ADAPTER_VERSION = "0.1.0"

ERROR_CODES = {
    "UNKNOWN_FIELD": "unknown_field",
    "READ_ONLY_FIELD": "read_only_field",
    "INVALID_DATE": "invalid_date",
    "INVALID_DAYKEY": "invalid_daykey",
    "INVALID_STRING": "invalid_string",
    "INVALID_NUMBER": "invalid_number",
    "INVALID_BOOLEAN": "invalid_boolean",
    "INVALID_ENUM": "invalid_enum",
    "NOT_STORED": "not_stored",
    "DUPLICATE_REQUEST": "duplicate_request",
    "APPROVAL_REQUIRED": "approval_required",
    "INSUFFICIENT_SCOPE": "insufficient_scope",
    "AMBIGUOUS_REF": "ambiguous_ref",
    "INVALID_EVENT": "invalid_event",
    "TASK_NOT_FOUND": "task_not_found",
    "TASK_NOT_CLAIMABLE": "task_not_claimable",
    "TASK_CANCELED": "task_canceled",
    "AGENT_TOKEN_REQUIRED": "agent_token_required",
    "RATE_LIMITED": "rate_limited",
}

# --------------------------------------------------------------- pure rules

_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
_DATE_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$"
)
_DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _valid_ymd(y: int, m: int, d: int) -> bool:
    if m < 1 or m > 12 or d < 1:
        return False
    mx = _MONTH[m - 1]
    if m == 2 and y % 4 == 0 and (y % 100 != 0 or y % 400 == 0):
        mx = 29
    return d <= mx


def looks_like_date(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    m = _DATE_RE.match(v)
    return bool(m) and _valid_ymd(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def is_day_key_value(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    m = _DAY_RE.match(v)
    return bool(m) and _valid_ymd(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _is_blank(v: Any) -> bool:
    return v is None or v == ""


def _violation(code: str, field: str, expected: str, got: Any) -> dict:
    return {"code": code, "field": field, "expected": expected, "got": None if got is None else got}


def validate(fields: list[dict], body: dict, allow: Optional[dict] = None) -> list[dict]:
    """Validate a RAW body against normalized fields; returns every violation."""
    allow = allow or {}
    by_name = {f["name"]: f for f in fields}
    writable = [f["name"] for f in fields if not f.get("readOnly")]
    out: list[dict] = []
    for key, value in body.items():
        if allow.get(key):
            continue
        f = by_name.get(key)
        if f is None:
            out.append(_violation(ERROR_CODES["UNKNOWN_FIELD"], key, "one of: " + ", ".join(writable), value))
            continue
        if f.get("readOnly"):
            out.append(_violation(ERROR_CODES["READ_ONLY_FIELD"], key, "not writable (server-managed)", value))
            continue
        if _is_blank(value):
            continue
        ftype = f["type"]
        if ftype == "datetime" and not looks_like_date(value):
            out.append(_violation(ERROR_CODES["INVALID_DATE"], key, "an ISO 8601 date", value))
        elif f.get("dayKey") and not is_day_key_value(value):
            out.append(_violation(ERROR_CODES["INVALID_DAYKEY"], key, 'a day key "YYYY-MM-DD"', value))
        elif ftype == "string" and not isinstance(value, str):
            out.append(_violation(ERROR_CODES["INVALID_STRING"], key, "text", value))
        elif ftype == "number" and not isinstance(value, (int, float)) and not (
            isinstance(value, str) and value.strip() != "" and _is_number(value)
        ):
            out.append(_violation(ERROR_CODES["INVALID_NUMBER"], key, "a number", value))
        elif ftype == "boolean" and not isinstance(value, bool) and value not in ("true", "false"):
            out.append(_violation(ERROR_CODES["INVALID_BOOLEAN"], key, "true or false", value))
        elif ftype == "enum" and f.get("values") and str(value) not in [str(v) for v in f["values"]]:
            out.append(_violation(ERROR_CODES["INVALID_ENUM"], key, "one of: " + " | ".join(map(str, f["values"])), value))
        elif ftype == "list<enum>" and f.get("values"):
            items = value if isinstance(value, list) else [value]
            allowed = [str(v) for v in f["values"]]
            if any(str(i) not in allowed for i in items):
                out.append(_violation(ERROR_CODES["INVALID_ENUM"], key, "each of: " + " | ".join(map(str, f["values"])), value))
    return out


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def divergences(fields: list[dict], body: dict, read: Callable[[str], Any]) -> list[dict]:
    """Read-back backstop: which non-blank requested values failed to land?"""
    by_name = {f["name"]: f for f in fields}
    out: list[dict] = []
    for key, requested in body.items():
        f = by_name.get(key)
        if f is None or f.get("readOnly"):
            continue
        if _is_blank(requested):
            continue
        try:
            stored = read(key)
        except Exception:
            stored = None
        if _is_blank(stored):
            out.append({"field": key, "type": f["type"], "stored": str(stored)})
    return out


def label_field_of(fields: list[dict]) -> Optional[str]:
    names = [f["name"] for f in fields]
    for pref in ("title", "name", "label"):
        if pref in names:
            return pref
    for f in fields:
        if f["type"] == "string" and f.get("required") and not f.get("readOnly"):
            return f["name"]
    return None


def schema_fingerprint(entities: dict) -> str:
    parts = []
    for name, fields in entities.items():
        pairs = sorted(f"{f['name']}:{f['type']}" for f in fields)
        parts.append(f"{name}({','.join(pairs)})")
    parts.sort()
    joined = ";".join(parts)
    h = 5381
    for ch in joined:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return "sv_" + format(h, "x")


def describe_violation(v: dict, server_now: Optional[str] = None) -> str:
    msg = (
        "Rejected by a2app (" + v["code"] + '): field "' + v["field"] + '" expects '
        + v["expected"] + "; got " + json.dumps(v["got"])
    )
    if v["code"] in (ERROR_CODES["INVALID_DATE"], ERROR_CODES["INVALID_DAYKEY"]) and server_now:
        msg += '. Example: "' + server_now[:10] + '"'
    if server_now:
        msg += ". Server time is " + server_now
    return msg + "."


def describe_incomplete(lost: list[dict]) -> str:
    names = ", ".join(l["field"] for l in lost)
    return "Rejected by a2app (not_stored): the database did not store " + names + ". Do NOT report this as done."


# --------------------------------------------------------------- rate limiter

DEFAULT_RATE_LIMITS = {"data": 1200, "ops": 300}


class _RateLimiter:
    def __init__(self, limits: dict, now_ms: Callable[[], int]):
        self.limits = limits
        self.now_ms = now_ms
        self.windows: dict[tuple, list] = {}

    def check(self, caller: str, cls: str) -> dict:
        limit = self.limits.get(cls, 0)
        if limit <= 0:
            return {"allowed": True, "limit": limit, "retryAfterSeconds": 0}
        now = self.now_ms()
        key = (caller, cls)
        ws, count = self.windows.get(key, [now, 0])
        if now - ws >= 60000:
            ws, count = now, 0
        count += 1
        self.windows[key] = [ws, count]
        if count > limit:
            return {"allowed": False, "limit": limit, "retryAfterSeconds": max(1, (60000 - (now - ws)) // 1000)}
        return {"allowed": True, "limit": limit, "retryAfterSeconds": 0}


# ------------------------------------------------------------------- store

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _coerce(field: dict, value: Any) -> Any:
    if value is None or value == "":
        return value
    if field["type"] == "number" and isinstance(value, str):
        return float(value) if "." in value else int(value)
    if field["type"] == "boolean" and isinstance(value, str):
        return value == "true"
    return value


class Store:
    """In-memory record store plus adapter-owned state (tasks, events,
    idempotency keys, approvals, audit). A real deployment swaps this for a
    database; the served surface and the rules are unchanged."""

    def __init__(self, seed: Optional[dict] = None):
        self.seed = seed or {}
        self.rows: dict[str, dict[str, dict]] = {}
        self.tasks: dict[str, dict] = {}
        self.events: list[dict] = []
        self.idem: dict[tuple, str] = {}
        self.approvals: set[str] = set()
        self.audit: list[dict] = []
        self.grants: dict[str, dict] = {}
        self._task_seq = 0
        self._event_seq = 0

    # records ---------------------------------------------------------------
    def list_records(self, entity: str, query: dict) -> dict:
        items = list(self.rows.get(entity, {}).values())
        sort = query.get("sort")
        if sort:
            desc = sort.startswith("-")
            key = sort[1:] if desc else sort
            items = sorted(items, key=lambda r: (r.get(key) is None, str(r.get(key))), reverse=desc)
        total = len(items)
        per_page = int(query["perPage"]) if query.get("perPage") else total
        page = int(query["page"]) if query.get("page") else 1
        start = (page - 1) * per_page if per_page else 0
        return {"items": items[start:start + per_page] if per_page else items, "page": page, "perPage": per_page, "totalItems": total}

    def get_record(self, entity: str, rec_id: str) -> Optional[dict]:
        return self.rows.get(entity, {}).get(rec_id)

    def put_record(self, entity: str, rec: dict) -> None:
        self.rows.setdefault(entity, {})[rec["id"]] = rec

    def delete_record(self, entity: str, rec_id: str) -> bool:
        table = self.rows.get(entity, {})
        if rec_id in table:
            del table[rec_id]
            return True
        return False

    # grants ----------------------------------------------------------------
    def put_grant(self, grant: dict) -> None:
        self.grants[grant["token"]] = grant

    def grant_by_token(self, token: str) -> Optional[dict]:
        return self.grants.get(token)

    # idempotency / approvals ----------------------------------------------
    def idem_get(self, entity: str, key: str) -> Optional[str]:
        return self.idem.get((entity, key))

    def idem_put(self, entity: str, key: str, rec_id: str) -> None:
        self.idem[(entity, key)] = rec_id

    def approval_issue(self, key: str) -> None:
        self.approvals.add(key)

    def approval_consume(self, key: str) -> bool:
        if key in self.approvals:
            self.approvals.discard(key)
            return True
        return False

    # tasks / events --------------------------------------------------------
    def append_event(self, etype: str, payload: dict) -> dict:
        self._event_seq += 1
        ev = {"id": f"ev_{self._event_seq}", "app": None, "type": etype, "payload": payload, "createdAt": _now_iso(), "seq": self._event_seq}
        self.events.append(ev)
        return ev

    def events_since(self, cursor: Optional[str]) -> dict:
        after = int(cursor) if cursor and cursor.isdigit() else 0
        fresh = [e for e in self.events if e["seq"] > after]
        return {"events": fresh, "nextCursor": str(fresh[-1]["seq"]) if fresh else (cursor or "0")}

    def enqueue_task(self, event_id: str, capability: str, payload: dict) -> dict:
        self._task_seq += 1
        task = {
            "id": f"task_{self._task_seq}", "app": None, "event": event_id, "status": "submitted",
            "request": {"capability": capability, "payload": payload}, "claim": None,
            "progress": {}, "result": None, "reason": None, "ask": None,
            "createdAt": _now_iso(), "updatedAt": _now_iso(), "deliveries": 0,
        }
        self.tasks[task["id"]] = task
        return task

    def list_tasks(self, status: Optional[str]) -> list[dict]:
        return [t for t in self.tasks.values() if status is None or t["status"] == status]

    def get_task(self, task_id: str) -> Optional[dict]:
        return self.tasks.get(task_id)

    def save_task(self, task: dict) -> None:
        task["updatedAt"] = _now_iso()
        self.tasks[task["id"]] = task


# ----------------------------------------------------------------- adapter

def _approval_key(name: str, args: dict) -> str:
    canonical = json.dumps({"op": name, "args": args}, sort_keys=True, separators=(",", ":"))
    return "ak_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


class Adapter:
    def __init__(
        self,
        app_id: str,
        app_name: Optional[str],
        entities: dict,
        operations: list[dict],
        store: Store,
        token: str,
        allowed_origins: Optional[list[str]] = None,
        operation_runners: Optional[dict[str, Callable]] = None,
        auth_mode: str = "none",
        credential_hint: Optional[str] = None,
        env: Optional[str] = None,
    ):
        self.app_id = app_id
        self.app_name = app_name
        self.entity_defs = entities  # {name: {"fields": [...], "auth"?: bool, "writeAllow"?: [...]}}
        self.operations = operations
        self.op_by_name = {o["name"]: o for o in operations}
        self.store = store
        self.auth_mode = auth_mode
        self.allowed_origins = set(allowed_origins or [])
        self.runners = operation_runners or {}
        self.credential_hint = credential_hint or "Read the app's .agent-token file (mode 0600) in the project directory."
        self.env = env
        self.limiter = _RateLimiter(dict(DEFAULT_RATE_LIMITS), lambda: int(time.time() * 1000))
        store.put_grant({
            "token": token, "credentialId": "cred_local", "agentName": "local",
            "principal": "owner", "scopes": ["*"],
        })
        # Seed records (materialize server-managed read-only fields).
        for name, records in store.seed.items():
            for raw in records:
                store.put_record(name, self._materialize(name, raw))

    # -- schema helpers -----------------------------------------------------
    def _fields(self, entity: str) -> Optional[list[dict]]:
        d = self.entity_defs.get(entity)
        return d["fields"] if d else None

    def _materialize(self, entity: str, body: dict) -> dict:
        fields = self._fields(entity) or []
        rec_id = body["id"] if isinstance(body.get("id"), str) and body["id"] else "rec_" + secrets.token_hex(8)
        rec = {"id": rec_id}
        for f in fields:
            if f["name"] in body and body[f["name"]] not in (None, ""):
                rec[f["name"]] = _coerce(f, body[f["name"]])
            elif f.get("readOnly") and f["name"] == "created":
                rec[f["name"]] = _now_iso()
        return rec

    def _schema_version(self) -> str:
        return schema_fingerprint({n: d["fields"] for n, d in self.entity_defs.items()})

    # -- envelopes ----------------------------------------------------------
    @staticmethod
    def _err(status: int, code: str, message: str, **extra) -> tuple[int, dict]:
        return status, {"a2app": True, "ok": False, "code": code, "message": message, **extra}

    # -- identity / describe ------------------------------------------------
    def identity(self) -> dict:
        now = datetime.now(timezone.utc)
        doc = {
            "a2app": True, "protocol": PROTOCOL_VERSION, "adapterVersion": ADAPTER_VERSION,
            "app": {"id": self.app_id, "name": self.app_name}, "schemaVersion": self._schema_version(),
            "serverNow": _now_iso(), "serverTzOffsetMinutes": 0,
        }
        if self.env:
            doc["env"] = self.env
        return doc

    def _describe(self) -> dict:
        entities: dict = {}
        for name, d in self.entity_defs.items():
            fields: dict = {}
            for f in d["fields"]:
                if f.get("writeOnly"):
                    continue
                field: dict = {"type": f["type"]}
                if f.get("required"):
                    field["required"] = True
                if f.get("readOnly"):
                    field["readOnly"] = True
                if f.get("max") is not None:
                    field["max"] = f["max"]
                if f.get("values"):
                    field["values"] = f["values"]
                if f.get("entity"):
                    field["entity"] = f["entity"]
                if f.get("dayKey"):
                    field["format"] = "YYYY-MM-DD"
                fields[f["name"]] = field
            entity: dict = {"label": label_field_of(d["fields"]), "records": f"/api/collections/{name}/records", "fields": fields}
            if d.get("auth"):
                entity["auth"] = True
            entities[name] = entity
        ops = []
        for o in self.operations:
            decl = {"name": o["name"], "destructive": o.get("destructive", False)}
            if o.get("description"):
                decl["description"] = o["description"]
            if o.get("readOnly"):
                decl["readOnly"] = True
            if o.get("idempotent"):
                decl["idempotent"] = True
            if o.get("params"):
                decl["params"] = o["params"]
            ops.append(decl)
        return {"entities": entities, "operations": ops, "conventions": self._conventions()}

    @staticmethod
    def _conventions() -> dict:
        return {
            "writes": "Prefer a declared operation over a raw write where one exists.",
            "labels": "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
            "dates": 'Relative words ("tomorrow") are rejected by the app; resolve them to ISO 8601 client-side.',
            "honesty": "If the app cannot express what was asked, say so instead of approximating into a wrong field.",
        }

    # -- IAM ----------------------------------------------------------------
    def _expand_scopes(self, grant: dict) -> set:
        if "*" not in grant["scopes"]:
            return set(grant["scopes"])
        scopes = set()
        for name in self.entity_defs:
            scopes.add(f"data:{name}:read")
            scopes.add(f"data:{name}:write")
        for o in self.operations:
            scopes.add(f"op:{o['name']}")
        return scopes

    def _credential_of(self, headers: dict) -> Optional[dict]:
        token = headers.get("x-a2app-token") or headers.get("x-lui-token")
        return self.store.grant_by_token(token) if token else None

    def _authorize(self, headers: dict, scope: Optional[str], is_write: bool):
        origin = headers.get("origin")
        if origin is not None and origin not in self.allowed_origins:
            return None, self._err(403, "forbidden_origin", "Refused: request Origin is not this app's own.")
        if origin is not None and origin in self.allowed_origins:
            return {"credentialId": "ui", "agentName": None, "principal": "owner"}, None
        grant = self._credential_of(headers)
        required = is_write or self.auth_mode == "multi-user"
        if grant is None:
            if required:
                return None, self._err(401, ERROR_CODES["AGENT_TOKEN_REQUIRED"], "This write requires an agent credential.", how=self.credential_hint)
            return {"credentialId": "anonymous", "agentName": None, "principal": "owner"}, None
        if scope:
            if scope not in self._expand_scopes(grant):
                return None, self._err(403, ERROR_CODES["INSUFFICIENT_SCOPE"], f"This credential does not hold {scope}.", required=scope)
        return {"credentialId": grant["credentialId"], "agentName": grant["agentName"], "principal": grant["principal"]}, None

    def _rate_gate(self, headers: dict, cls: str):
        caller = headers.get("x-a2app-token") or (("origin:" + headers["origin"]) if headers.get("origin") else "anon")
        decision = self.limiter.check(caller, cls)
        if decision["allowed"]:
            return None
        return self._err(429, ERROR_CODES["RATE_LIMITED"], f"Rate limit exceeded ({decision['limit']} per window). Slow down and retry.", retryAfterSeconds=decision["retryAfterSeconds"])

    # -- dispatch -----------------------------------------------------------
    def dispatch(self, method: str, path: str, headers: dict, body: Optional[dict], query: Optional[dict] = None):
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        method = method.upper()
        q = dict(query or {})
        if "?" in path:
            path, qs = path.split("?", 1)
            q.update({k: v[-1] for k, v in parse_qs(qs).items()})
        path = re.sub(r"/+$", "", path) or "/"

        if path in ("/.well-known/a2app.json", "/api/_a2app"):
            return 200, self.identity()
        if path == "/api/_a2app/describe":
            return 200, self._describe()
        if path == "/api/_a2app/whoami":
            grant = self._credential_of(headers)
            if not grant:
                return self._err(401, ERROR_CODES["AGENT_TOKEN_REQUIRED"], "whoami requires a credential.")
            return 200, {"a2app": True, "credentialId": grant["credentialId"], "agentName": grant["agentName"], "principal": grant["principal"], "scopes": sorted(self._expand_scopes(grant))}
        if path == "/api/_a2app/context":
            ctx, reply = self._authorize(headers, None, False)
            if reply:
                return reply
            return 200, {"a2app": True, "view": None, "selected": []}
        if path == "/api/_a2app/events":
            return self._handle_events(method, headers, q)
        if path == "/api/_a2app/tasks" or path.startswith("/api/_a2app/tasks/"):
            rest = [] if path == "/api/_a2app/tasks" else path[len("/api/_a2app/tasks/"):].split("/")
            return self._handle_tasks(method, headers, rest, body, q)

        m = re.match(r"^/api/collections/([^/]+)/records(?:/([^/]+))?$", path)
        if m:
            return self._handle_records(method, headers, m.group(1), m.group(2), body, q)

        m = re.match(r"^/api/ops/([^/]+)$", path)
        if m:
            if method != "POST":
                return self._err(405, "usage", "Operations are POST-only.")
            return self._handle_operation(headers, m.group(1), body or {})

        return self._err(404, "not_found", "No such route.")

    # -- records ------------------------------------------------------------
    def _handle_records(self, method, headers, entity, rec_id, body, query):
        limited = self._rate_gate(headers, "data")
        if limited:
            return limited
        d = self.entity_defs.get(entity)
        if not d:
            return self._err(404, "unknown_entity", f'No such entity "{entity}".')
        fields = d["fields"]
        server_now = _now_iso()

        if method == "GET":
            _, reply = self._authorize(headers, f"data:{entity}:read", False)
            if reply:
                return reply
            if rec_id:
                rec = self.store.get_record(entity, rec_id)
                if not rec:
                    return self._err(404, "record_not_found", f'No {entity} record "{rec_id}".')
                return 200, rec
            return 200, self.store.list_records(entity, query)

        ctx, reply = self._authorize(headers, f"data:{entity}:write", True)
        if reply:
            return reply
        body = body or {}

        if method == "DELETE":
            if not rec_id:
                return self._err(400, "usage", "DELETE requires a record id.")
            ok = self.store.delete_record(entity, rec_id)
            if not ok:
                return self._err(404, "record_not_found", f'No {entity} record "{rec_id}".')
            return 200, {"a2app": True, "ok": True, "deleted": rec_id}

        if method not in ("POST", "PATCH"):
            return self._err(405, "usage", f"{method} not allowed on records.")

        idem = headers.get("idempotency-key")
        if idem and method == "POST":
            prior = self.store.idem_get(entity, idem)
            if prior:
                return self._err(409, ERROR_CODES["DUPLICATE_REQUEST"], "This idempotency key already produced a record.", id=prior)

        allow = {k: True for k in d.get("writeAllow", [])}
        violations = validate(fields, body, allow)
        if violations:
            first = violations[0]
            return 400, {
                "a2app": True, "ok": False, "code": first["code"], "field": first["field"],
                "expected": first["expected"], "got": first["got"],
                "message": describe_violation(first, server_now),
                "violations": [{"code": v["code"], "field": v["field"], "expected": v["expected"], "got": v["got"]} for v in violations],
            }

        if method == "POST":
            stored = self._materialize(entity, body)
            self.store.put_record(entity, stored)
        else:
            if not rec_id:
                return self._err(400, "usage", "PATCH requires a record id.")
            existing = self.store.get_record(entity, rec_id)
            if not existing:
                return self._err(404, "record_not_found", f'No {entity} record "{rec_id}".')
            for f in fields:
                if f.get("readOnly") or f["name"] not in body:
                    continue
                v = body[f["name"]]
                if v is None or v == "":
                    existing.pop(f["name"], None)
                else:
                    existing[f["name"]] = _coerce(f, v)
            self.store.put_record(entity, existing)
            stored = existing

        lost = divergences(fields, body, lambda n: stored.get(n))
        if lost:
            return 422, {
                "a2app": True, "ok": False, "code": ERROR_CODES["NOT_STORED"],
                "message": describe_incomplete(lost),
                "violations": [{"code": ERROR_CODES["NOT_STORED"], "field": l["field"]} for l in lost],
                "id": stored["id"],
            }

        if idem and method == "POST":
            self.store.idem_put(entity, idem, stored["id"])
        return 200, stored

    # -- operations ---------------------------------------------------------
    def _handle_operation(self, headers, name, args):
        limited = self._rate_gate(headers, "ops")
        if limited:
            return limited
        decl = self.op_by_name.get(name)
        if not decl:
            return self._err(404, "unknown_operation", f'No declared operation "{name}".')
        ctx, reply = self._authorize(headers, f"op:{name}", not decl.get("readOnly"))
        if reply:
            return reply

        if decl.get("destructive"):
            key = _approval_key(name, args)
            provided = headers.get("x-a2app-approval") or headers.get("x-lui-approval")
            if not provided:
                self.store.approval_issue(key)
                return self._err(428, ERROR_CODES["APPROVAL_REQUIRED"], f'Operation "{name}" is destructive and requires approval.', approvalKey=key)
            if provided != key or not self.store.approval_consume(key):
                return self._err(428, ERROR_CODES["APPROVAL_REQUIRED"], "Approval key does not match this exact call (or has expired).", approvalKey=key)

        runner = self.runners.get(name)
        if not runner:
            return self._err(501, "not_implemented", f'This app declares "{name}" but implements no operation runner.')
        try:
            result = runner(args, ctx, self.store)
            return 200, {"a2app": True, "ok": True, "operation": name, "result": result}
        except Exception as e:  # noqa: BLE001
            return self._err(500, "operation_failed", f'Operation "{name}" threw: {e}')

    # -- tasks / events -----------------------------------------------------
    def _handle_events(self, method, headers, query):
        limited = self._rate_gate(headers, "data")
        if limited:
            return limited
        _, reply = self._authorize(headers, None, False)
        if reply:
            return reply
        since = query.get("since")
        res = self.store.events_since(since)
        return 200, {
            "a2app": True,
            "events": [{"id": e["id"], "app": e["app"], "type": e["type"], "payload": e["payload"], "createdAt": e["createdAt"]} for e in res["events"]],
            "nextCursor": res["nextCursor"], "pollAfterMs": 3000,
        }

    def _handle_tasks(self, method, headers, rest, body, query):
        limited = self._rate_gate(headers, "data")
        if limited:
            return limited
        ctx, reply = self._authorize(headers, None, method != "GET")
        if reply:
            return reply

        if not rest and method == "GET":
            status = query.get("status")
            return 200, {"a2app": True, "tasks": [self._task_wire(t) for t in self.store.list_tasks(status)], "pollAfterMs": 2000}
        task_id = rest[0] if rest else None
        if not task_id:
            return self._err(400, "usage", "Task id required.")
        action = rest[1] if len(rest) > 1 else None
        task = self.store.get_task(task_id)
        if not task:
            return self._err(404, ERROR_CODES["TASK_NOT_FOUND"], f'No task "{task_id}".')
        if action is None and method == "GET":
            return 200, self._task_wire(task)
        if method != "POST":
            return self._err(405, "usage", f"{method} not allowed here.")
        body = body or {}

        if action == "claim":
            if task["status"] != "submitted":
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} is {task["status"]}, not claimable.')
            task["status"] = "working"
            task["claim"] = {"credentialId": ctx["credentialId"], "principal": ctx["principal"], "claimedAt": _now_iso()}
            self.store.save_task(task)
            return 200, self._task_wire(task)
        if action == "progress":
            if task["status"] == "canceled":
                return self._err(409, ERROR_CODES["TASK_CANCELED"], f"Task {task_id} was canceled.")
            if task["status"] not in ("working", "input-required"):
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} is {task["status"]}.')
            if isinstance(body.get("step"), str):
                task["progress"]["step"] = body["step"]
            if isinstance(body.get("percent"), (int, float)):
                task["progress"]["percent"] = body["percent"]
            if body.get("ask") is not None:
                task["ask"] = body["ask"]
                task["status"] = "input-required"
            elif task["status"] == "input-required":
                task["status"] = "working"
            self.store.save_task(task)
            return 200, self._task_wire(task)
        if action == "complete":
            if task["status"] == "canceled":
                return self._err(409, ERROR_CODES["TASK_CANCELED"], f"Task {task_id} was canceled.")
            status = body.get("status")
            if status == "completed":
                task["status"] = "completed"
                task["result"] = body.get("result") or {}
            elif status == "failed":
                task["status"] = "failed"
                task["reason"] = body["reason"] if isinstance(body.get("reason"), str) else "unspecified"
            else:
                return self._err(400, "usage", 'complete requires status "completed" or "failed".')
            self.store.save_task(task)
            return 200, self._task_wire(task)
        if action == "cancel":
            task["status"] = "canceled"
            self.store.save_task(task)
            return 200, self._task_wire(task)
        return self._err(404, "usage", f'Unknown task action "{action}".')

    @staticmethod
    def _task_wire(t: dict) -> dict:
        return {
            "id": t["id"], "app": t["app"], "event": t["event"], "status": t["status"],
            "request": t["request"], "claim": t["claim"], "progress": t["progress"],
            "result": t["result"], "reason": t["reason"], "createdAt": t["createdAt"],
            "updatedAt": t["updatedAt"], "pollAfterMs": 2000,
        }

    # -- app -> agent -------------------------------------------------------
    def trigger(self, etype: str, payload: dict, capability: Optional[str] = None) -> dict:
        ev = self.store.append_event(etype, payload)
        task_id = None
        if capability:
            task_id = self.store.enqueue_task(ev["id"], capability, payload)["id"]
        return {"eventId": ev["id"], "taskId": task_id}
