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
from urllib.parse import parse_qs, unquote

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


def _field_print(f: dict) -> str:
    """Every published attribute of a field, rendered deterministically.

    Must match `fieldPrint` in @a2app/rules exactly: a client that caches
    describe against this value is told never to write against a stale schema,
    so narrowing an enum or tightening a max has to move the hash.
    """
    parts = [f"{f['name']}:{f['type']}"]
    if f.get("required"):
        parts.append("req")
    if f.get("readOnly"):
        parts.append("ro")
    if f.get("writeOnly"):
        parts.append("wo")
    if f.get("dayKey"):
        parts.append("day")
    if f.get("max") is not None:
        parts.append(f"max={f['max']}")
    if f.get("entity"):
        parts.append(f"entity={f['entity']}")
    if f.get("values"):
        parts.append("values=" + "|".join(sorted(f["values"])))
    return ":".join(parts)


def _stable_json(value: Any) -> str:
    """JSON with keys sorted at every depth, so declaration order cannot move the hash."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _operation_print(o: dict) -> str:
    flags = "".join(c for c, k in (("d", "destructive"), ("r", "readOnly"), ("i", "idempotent")) if o.get(k))
    parts = [f"{o['name']}:{flags}" if flags else o["name"]]
    if o.get("module"):
        parts.append(f"mod={o['module']}")
    if o.get("entity"):
        parts.append(f"on={o['entity']}")
    if o.get("params"):
        parts.append("params=" + _stable_json(o["params"]))
    if o.get("appliesWhen"):
        parts.append("when=" + _stable_json(o["appliesWhen"]))
    return ":".join(parts)


def schema_fingerprint(entities: dict, operations: Optional[list[dict]] = None) -> str:
    """Stable fingerprint of everything describe publishes.

    Parity oracle: @a2app/rules `schemaFingerprint`. `entities` maps a name to
    {"fields": [...], "module": str, "auth"?: bool}. `module` is required for the
    same reason it is required there: an entity that could move between modules
    without moving the hash would leave caches placing it in the old one.
    """
    parts = []
    for name, value in entities.items():
        attrs = [f"{name}({','.join(sorted(_field_print(f) for f in value['fields']))})"]
        if value.get("auth"):
            attrs.append("auth")
        attrs.append(f"mod={value['module']}")
        parts.append(":".join(attrs))
    parts.sort()
    ops = sorted(_operation_print(o) for o in (operations or []))
    joined = ";".join(parts) + "|" + ",".join(ops)
    h = 5381
    for ch in joined:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return "sv_" + format(h, "x")


# -- availability predicates (A2APP-SPEC 3.4) -------------------------------
# Parity oracle: adapters/rules/src/predicate.ts. Same predicate + same record
# must yield the same availability and the same blocked reason on every stack.

DESCRIBE_BUDGET_CHARS = 2000


def _as_declared(value: Any, declared_type: Optional[str]) -> Any:
    """Read a value as its field's DECLARED type.

    A backend is only obliged to return what it stored, so `done: "true"` and
    `done: True` are the same boolean. Deciding from the runtime type instead
    would make availability depend on the storage engine.
    """
    if _is_blank(value):
        return None
    if declared_type == "boolean":
        if isinstance(value, bool):
            return value
        if value == "true":
            return True
        if value == "false":
            return False
        return value
    if declared_type == "number":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value
        try:
            return float(value)
        except (TypeError, ValueError):
            return value
    return value


def _same_value(a: Any, b: Any) -> bool:
    if isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
        return _stable_json(a) == _stable_json(b)
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return a == b


def _read_field(record: dict, name: str, index: dict) -> Any:
    return _as_declared(record.get(name), (index.get(name) or {}).get("type"))


def evaluate_predicate(predicate: dict, record: dict, fields: list[dict]) -> bool:
    index = {f["name"]: f for f in fields}
    return _evaluate(predicate, record, index)


def _evaluate(p: dict, record: dict, index: dict) -> bool:
    if "all" in p:
        return all(_evaluate(sub, record, index) for sub in p["all"])
    if "any" in p:
        return any(_evaluate(sub, record, index) for sub in p["any"])
    if "not" in p:
        return not _evaluate(p["not"], record, index)

    actual = _read_field(record, p["field"], index)
    declared = (index.get(p["field"]) or {}).get("type")
    if "isBlank" in p:
        return (actual is None) == p["isBlank"]
    if "eq" in p:
        return _same_value(actual, _as_declared(p["eq"], declared))
    if "ne" in p:
        return not _same_value(actual, _as_declared(p["ne"], declared))
    if "in" in p:
        return any(_same_value(actual, _as_declared(c, declared)) for c in p["in"])
    if "notIn" in p:
        return not any(_same_value(actual, _as_declared(c, declared)) for c in p["notIn"])
    # Unrecognised form: refuse rather than default to available. An unknown
    # condition must never silently unblock an action.
    return False


def _render_value(v: Any) -> str:
    if v is None:
        return "blank"
    if isinstance(v, str):
        return f'"{v}"'
    if isinstance(v, (list, dict)):
        return _stable_json(v)
    return json.dumps(v)


def _predicate_fields(predicate: dict) -> list[str]:
    """Every field name a predicate reads, for declaration-time validation."""
    out: list[str] = []

    def collect(p: dict) -> None:
        if "all" in p:
            for sub in p["all"]:
                collect(sub)
        elif "any" in p:
            for sub in p["any"]:
                collect(sub)
        elif "not" in p:
            collect(p["not"])
        elif p.get("field") and p["field"] not in out:
            out.append(p["field"])

    collect(predicate)
    return out


def _render_list(values: list) -> str:
    parts = [_render_value(v) for v in values]
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " or " + parts[-1]


def explain_predicate(predicate: dict, record: dict, fields: list[dict]) -> str:
    """Why this predicate does not hold, derived — never composed by a model."""
    index = {f["name"]: f for f in fields}
    if _evaluate(predicate, record, index):
        return "the condition holds"
    return _explain(predicate, record, index)


def _explain(p: dict, record: dict, index: dict) -> str:
    if "all" in p:
        for sub in p["all"]:
            if not _evaluate(sub, record, index):
                return _explain(sub, record, index)
        return "the condition holds"
    if "any" in p:
        return _explain(p["any"][0], record, index) if p["any"] else "no condition is satisfiable"
    if "not" in p:
        inner = p["not"]
        if "isBlank" in inner:
            return f"{inner['field']} is blank" if inner["isBlank"] else f"{inner['field']} is set"
        if "eq" in inner:
            return f"{inner['field']} is {_render_value(_read_field(record, inner['field'], index))}"
        return "the condition is not met"

    actual = _read_field(record, p["field"], index)
    if "isBlank" in p:
        if p["isBlank"]:
            return f"{p['field']} is set to {_render_value(actual)}, not blank"
        return f"{p['field']} is blank"
    if "eq" in p:
        return f"{p['field']} is {_render_value(actual)}, not {_render_value(p['eq'])}"
    if "ne" in p:
        return f"{p['field']} is {_render_value(actual)}"
    if "in" in p:
        return f"{p['field']} is {_render_value(actual)}, not {_render_list(p['in'])}"
    if "notIn" in p:
        return f"{p['field']} is {_render_value(actual)}"
    return "the condition is not met"


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
        modules: Optional[list[dict]] = None,
        allowed_origins: Optional[list[str]] = None,
        operation_runners: Optional[dict[str, Callable]] = None,
        auth_mode: str = "none",
        credential_hint: Optional[str] = None,
        env: Optional[str] = None,
    ):
        self.app_id = app_id
        self.app_name = app_name
        # {name: {"fields": [...], "module": str, "summary"?, "auth"?, "writeAllow"?}}
        self.entity_defs = entities
        self.operations = operations
        self.modules = modules or []
        self.op_by_name = {o["name"]: o for o in operations}
        problems = self._model_problems()
        if problems:
            # Fail fast: a model whose entities or operations name a module that
            # was never declared cannot be walked, so serving it would answer 200
            # while omitting real capability.
            raise ValueError(
                "A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - "
                + "\n  - ".join(problems)
            )
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

    def _model_problems(self) -> list[str]:
        """Everything wrong with the app part's module/operation declarations.

        Parity oracle: `modelProblems` in adapters/adapter-core/src/describe.ts.
        """
        problems: list[str] = []
        declared = {m["name"] for m in self.modules}
        if not self.modules:
            problems.append(
                "no modules declared: every entity and operation belongs to one, and the root screen lists them"
            )
        seen = set()
        for m in self.modules:
            if m["name"] in seen:
                problems.append(f'duplicate module "{m["name"]}"')
            seen.add(m["name"])

        for name, d in self.entity_defs.items():
            module = d.get("module")
            if not module:
                problems.append(f'entity "{name}" declares no module')
            elif module not in declared:
                problems.append(f'entity "{name}" names undeclared module "{module}"')

        for o in self.operations:
            module = o.get("module")
            if not module:
                problems.append(f'operation "{o["name"]}" declares no module')
            elif module not in declared:
                problems.append(f'operation "{o["name"]}" names undeclared module "{module}"')
            if not isinstance(o.get("params"), dict):
                problems.append(
                    f'operation "{o["name"]}" declares no typed params (declare {{}} if it takes none)'
                )
            entity = o.get("entity")
            if entity is not None:
                d = self.entity_defs.get(entity)
                if d is None:
                    problems.append(f'operation "{o["name"]}" acts on unknown entity "{entity}"')
                else:
                    if d.get("module") != module:
                        problems.append(
                            f'operation "{o["name"]}" is in module "{module}" but acts on entity '
                            f'"{entity}" in module "{d.get("module")}"'
                        )
                    when = o.get("appliesWhen")
                    if when:
                        names = {f["name"] for f in d["fields"]}
                        for referenced in _predicate_fields(when):
                            if referenced not in names:
                                problems.append(
                                    f'operation "{o["name"]}" appliesWhen reads "{referenced}", '
                                    f'not a field of "{entity}"'
                                )
            elif o.get("appliesWhen"):
                problems.append(
                    f'operation "{o["name"]}" declares appliesWhen but no entity: '
                    "there is no record to evaluate it against"
                )
        return problems

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
        prints = {
            n: {"fields": d["fields"], "auth": bool(d.get("auth")), "module": d["module"]}
            for n, d in self.entity_defs.items()
        }
        return schema_fingerprint(prints, self.operations)

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

    # -- navigational describe (A2APP-SPEC 3) -------------------------------
    # One request answers for one place in the app, never for the whole app.
    # Parity oracle: adapters/adapter-core/src/describe.ts.

    @staticmethod
    def _field_doc(f: dict) -> dict:
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
        return field

    @staticmethod
    def _readable_fields(d: dict) -> list[dict]:
        """Everything except write-only.

        Load-bearing beyond describe: a client treats a field absent here as
        write-only and exempts it from the read-back check, so dropping anything
        else would quietly disable that backstop.
        """
        return [f for f in d["fields"] if not f.get("writeOnly")]

    def _fit_list(self, build: Callable[[list, int], dict], items: list) -> dict:
        """Trim a list until the level fits, always reporting what was dropped."""
        whole = build(list(items), 0)
        if len(json.dumps(whole)) <= DESCRIBE_BUDGET_CHARS:
            return whole
        lo, hi = 0, len(items)
        while lo < hi:
            mid = -(-(lo + hi) // 2)
            if len(json.dumps(build(items[:mid], len(items) - mid))) <= DESCRIBE_BUDGET_CHARS:
                lo = mid
            else:
                hi = mid - 1
        return build(items[:lo], len(items) - lo)

    def _entities_of(self, module: str) -> list[tuple]:
        return [(n, d) for n, d in self.entity_defs.items() if d.get("module") == module]

    def _describe_root(self, access: dict) -> dict:
        modules = []
        for m in self.modules:
            owned = self._entities_of(m["name"])
            ops = [o for o in self.operations if o.get("module") == m["name"]]
            readable = sum(1 for n, _ in owned if access["read"](n))
            writable = sum(1 for n, _ in owned if access["write"](n))
            runnable = sum(1 for o in ops if access["run"](o["name"]))
            if not owned:
                reach = "none" if runnable == 0 else "full"
            elif readable == 0 and runnable == 0:
                reach = "none"
            elif writable == len(owned) and runnable == len(ops):
                reach = "full"
            else:
                reach = "read-only"
            row = {"name": m["name"], "entities": len(owned), "operations": len(ops), "access": reach}
            if m.get("summary"):
                row["summary"] = m["summary"]
            modules.append(row)
        return {
            "level": "root",
            "app": {"id": self.app_id, "name": self.app_name},
            "modules": modules,
            "conventions": self._conventions(),
            "next": ["describe/{module}", "describe?find={term}"],
        }

    def _describe_module(self, module: dict, access: dict, show_all: bool) -> dict:
        owned = []
        for name, d in self._entities_of(module["name"]):
            if not access["read"](name):
                continue
            row = {"name": name}
            if d.get("summary"):
                row["summary"] = d["summary"]
            owned.append(row)
        ops = []
        for o in self.operations:
            if o.get("module") != module["name"] or o.get("entity") is not None:
                continue
            if not access["run"](o["name"]):
                continue
            row = {"name": o["name"], "destructive": o.get("destructive", False)}
            if o.get("description"):
                row["summary"] = o["description"]
            ops.append(row)

        base_next = [f"describe/{module['name']}/{{entity}}"]
        if ops:
            base_next.append(f"{module['name']} <operation> [--params]")

        def build(entity_rows: list, truncated: int) -> dict:
            level = {
                "level": "module",
                "path": module["name"],
                "entities": entity_rows,
                "operations": ops,
                "next": base_next + ([f"describe/{module['name']}?all=true"] if truncated else []),
            }
            if module.get("summary"):
                level["summary"] = module["summary"]
            if truncated:
                level["truncated"] = truncated
            return level

        return build(owned, 0) if show_all else self._fit_list(build, owned)

    def _describe_entity(self, module: str, name: str, d: dict, access: dict) -> dict:
        fields = {f["name"]: self._field_doc(f) for f in self._readable_fields(d)}
        ops = []
        for o in self.operations:
            if o.get("entity") != name or not access["run"](o["name"]):
                continue
            decl = {"name": o["name"], "destructive": o.get("destructive", False), "params": o.get("params", {})}
            if o.get("description"):
                decl["description"] = o["description"]
            if o.get("readOnly"):
                decl["readOnly"] = True
            if o.get("idempotent"):
                decl["idempotent"] = True
            decl["entity"] = name
            ops.append(decl)
        level = {
            "level": "entity",
            "path": f"{module}/{name}",
            "label": label_field_of(d["fields"]),
            "records": f"/api/collections/{name}/records",
            "fields": fields,
            "operations": ops,
            "next": [f"describe/{module}/{name}/{{id}}", f"data {name} list"],
        }
        if d.get("auth"):
            level["auth"] = True
        return level

    def _describe_record(self, module: str, name: str, d: dict, record: dict, access: dict) -> dict:
        fields = self._readable_fields(d)
        label_field = label_field_of(d["fields"])
        label = record.get(label_field) if label_field else None

        ops = []
        for o in self.operations:
            if o.get("entity") != name or not access["run"](o["name"]):
                continue
            row = {"name": o["name"], "available": True}
            if o.get("destructive"):
                row["destructive"] = True
            when = o.get("appliesWhen")
            if when and not evaluate_predicate(when, record, fields):
                row["available"] = False
                row["blocked"] = explain_predicate(when, record, fields)
            ops.append(row)

        # Sub-resources are the record's own list<ref> fields: a forward relation
        # is derivable from the type vocabulary alone, with no query grammar.
        relations = []
        for f in fields:
            if f["type"] != "list<ref>" or not f.get("entity"):
                continue
            row = {"name": f["name"], "entity": f["entity"]}
            value = record.get(f["name"])
            if isinstance(value, list):
                row["count"] = len(value)
            relations.append(row)

        path = f"{module}/{name}/{record['id']}"
        level = {
            "level": "record",
            "path": path,
            "id": record["id"],
            "label": label if isinstance(label, str) or label is None else str(label),
            "operations": ops,
            "next": (
                [f"describe/{path}/{r['name']}" for r in relations]
                + [f"{path} {o['name']}" for o in ops if o["available"]]
                + [f"data {name} get {record['id']}"]
            ),
        }
        if relations:
            level["relations"] = relations
        return level

    def _describe_find(self, term: str, access: dict) -> dict:
        needle = term.lower()
        matches = []
        for m in self.modules:
            if needle in m["name"].lower():
                matches.append({"path": m["name"], "level": "module"})
        for name, d in self.entity_defs.items():
            if access["read"](name) and needle in name.lower():
                matches.append({"path": f"{d.get('module')}/{name}", "level": "entity"})
        for o in self.operations:
            if access["run"](o["name"]) and needle in o["name"].lower():
                path = f"{o['module']}/{o['entity']}" if o.get("entity") else o.get("module", "")
                matches.append({"path": path, "operation": o["name"]})

        def build(items: list, truncated: int) -> dict:
            level = {"level": "find", "term": term, "matches": items, "next": ["describe/{path}"]}
            if truncated:
                level["truncated"] = truncated
            return level

        return self._fit_list(build, matches)

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
    def _access_for(self, headers: dict) -> dict:
        """What this caller may do, for rendering access on a describe level.

        Mirrors `_authorize`'s precedence including its two bypasses — the app's
        own UI and an anonymous read on a single-user app both reach a context
        without meeting the scope check, so both genuinely have full access.
        """
        if self._is_same_origin(headers):
            return {"read": lambda _e: True, "write": lambda _e: True, "run": lambda _o: True}
        grant = self._credential_of(headers)
        if not grant:
            allow = self.auth_mode != "multi-user"
            return {"read": lambda _e: allow, "write": lambda _e: allow, "run": lambda _o: allow}
        held = self._expand_scopes(grant)
        return {
            "read": lambda e: f"data:{e}:read" in held,
            "write": lambda e: f"data:{e}:write" in held,
            "run": lambda o: f"op:{o}" in held,
        }

    def _handle_describe(self, headers: dict, segments: list, q: dict):
        """Serve one level of describe.

        The record and relation levels read real records, which makes them data
        reads: they take the same scope and rate class as the records API.
        Without that, describe would be an unmetered path around the scope model.
        """
        access = self._access_for(headers)

        find = q.get("find")
        if find is not None and not segments:
            if find == "":
                return self._err(400, "usage", "find needs a term: describe?find={term}")
            return 200, self._describe_find(find, access)

        if not segments:
            return 200, self._describe_root(access)

        module_name = segments[0]
        module = next((m for m in self.modules if m["name"] == module_name), None)
        if module is None:
            return self._err(404, "unknown_module", f'No module "{module_name}".',
                             {"modules": [m["name"] for m in self.modules]})
        if len(segments) == 1:
            return 200, self._describe_module(module, access, q.get("all") == "true")

        entity = segments[1]
        d = self.entity_defs.get(entity)
        if d is None:
            return self._err(404, "unknown_entity", f'No such entity "{entity}".')
        if d.get("module") != module_name:
            return self._err(404, "unknown_entity",
                             f'Entity "{entity}" is in module "{d.get("module")}", not "{module_name}".')
        if len(segments) == 2:
            if not access["read"](entity):
                return self._err(403, ERROR_CODES["INSUFFICIENT_SCOPE"],
                                 f"This credential does not hold data:{entity}:read.",
                                 {"required": f"data:{entity}:read"})
            return 200, self._describe_entity(module_name, entity, d, access)

        limited = self._rate_gate(headers, "data")
        if limited:
            return limited
        ctx, reply = self._authorize(headers, f"data:{entity}:read", False)
        if reply:
            return reply

        record_id = segments[2]
        record = self.store.get_record(entity, record_id)
        if record is None:
            return self._err(404, "record_not_found", f'No {entity} record "{record_id}".')
        if len(segments) == 3:
            return 200, self._describe_record(module_name, entity, d, record, access)

        relation = segments[3]
        field = next(
            (f for f in d["fields"]
             if f["name"] == relation and f["type"] == "list<ref>" and f.get("entity") and not f.get("writeOnly")),
            None,
        )
        if field is None:
            return self._err(404, "unknown_relation", f'"{relation}" is not a sub-resource of {entity}.')
        target = field["entity"]
        if not access["read"](target):
            return self._err(403, ERROR_CODES["INSUFFICIENT_SCOPE"],
                             f"This credential does not hold data:{target}:read.",
                             {"required": f"data:{target}:read"})
        target_def = self.entity_defs.get(target)
        target_label = label_field_of(target_def["fields"]) if target_def else None
        items = []
        for rid in (record.get(relation) or []):
            referenced = self.store.get_record(target, str(rid))
            label = referenced.get(target_label) if (referenced and target_label) else None
            items.append({"id": str(rid), "label": label if isinstance(label, str) or label is None else str(label)})

        path = f"{module_name}/{entity}/{record_id}/{relation}"

        def build(rows: list, truncated: int) -> dict:
            level = {
                "level": "relation", "path": path, "entity": target, "items": rows,
                "next": [f"data {target} get {{id}}", f"describe/{module_name}/{entity}/{record_id}"],
            }
            if truncated:
                level["truncated"] = truncated
            return level

        return 200, self._fit_list(build, items)

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
        # Describe is navigational: the bare path is the root level, and each
        # extra segment moves one level inward (A2APP-SPEC 3).
        if path == "/api/_a2app/describe":
            return self._handle_describe(headers, [], q)
        if path.startswith("/api/_a2app/describe/"):
            segments = [unquote(s) for s in path[len("/api/_a2app/describe/"):].split("/")]
            if len(segments) > 4:
                return self._err(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.")
            if any(s == "" for s in segments):
                return self._err(404, "usage", "describe path has an empty segment.")
            return self._handle_describe(headers, segments, q)
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


# ---------------------------------------------------------------- self-test
# Rules-parity oracle, run by the toolkit gate (`python a2app_adapter.py
# --selftest`). Its job is to prove this port and `@a2app/rules` agree, so a
# FastAPI app and a Node app reject identical payloads identically and block
# identical operations for identical stated reasons.
#
# Until this existed, the gate step ran, imported the module, and exited 0
# without asserting anything — a vacuously passing check, which is worse than
# no check because it reads as coverage.

def _selftest() -> int:
    failures: list[str] = []

    def check(label: str, actual: Any, expected: Any) -> None:
        if actual != expected:
            failures.append(f"{label}\n    expected: {expected!r}\n    actual:   {actual!r}")

    fields = [
        {"name": "title", "type": "string", "required": True, "max": 200},
        {"name": "status", "type": "enum", "values": ["todo", "doing", "done"]},
        {"name": "due", "type": "string", "max": 10, "dayKey": True},
        {"name": "created", "type": "datetime", "readOnly": True},
    ]

    # 1. Guard: every violation, by code, sorted.
    bad = {"nope": 1, "created": "x", "status": "nonsense", "due": "31-12-2026"}
    check(
        "guard reports every violation",
        sorted(v["code"] for v in validate(fields, bad)),
        ["invalid_daykey", "invalid_enum", "read_only_field", "unknown_field"],
    )
    check("a good body yields no violations", validate(fields, {"title": "ok", "status": "todo"}), [])
    check("label field resolution", label_field_of(fields), "title")

    # 2. Predicates: availability AND the stated reason. Both are contractual —
    #    a blocked operation must say the same thing on every stack.
    record = {"id": "t1", "title": "Ship it", "status": "doing"}
    check("ne holds", evaluate_predicate({"field": "status", "ne": "done"}, record, fields), True)
    check("eq fails", evaluate_predicate({"field": "status", "eq": "done"}, record, fields), False)
    check(
        "eq explains with both values",
        explain_predicate({"field": "status", "eq": "done"}, record, fields),
        'status is "doing", not "done"',
    )
    check(
        "in explains with the full set",
        explain_predicate({"field": "status", "in": ["todo", "done"]}, record, fields),
        'status is "doing", not "todo" or "done"',
    )
    check(
        "all reports the first failing branch",
        explain_predicate(
            {"all": [{"field": "status", "ne": "done"}, {"field": "title", "eq": "Other"}]}, record, fields
        ),
        'title is "Ship it", not "Other"',
    )
    check("isBlank on an absent field", evaluate_predicate({"field": "due", "isBlank": True}, record, fields), True)
    # A backend may store a boolean as text; both are the same boolean.
    bool_fields = [{"name": "done", "type": "boolean"}]
    check(
        "boolean compares by declared type, not storage shape",
        evaluate_predicate({"field": "done", "eq": True}, {"id": "x", "done": "true"}, bool_fields),
        True,
    )
    # An unrecognised form must refuse, never default to available.
    check("unknown predicate form refuses", evaluate_predicate({"field": "status"}, record, fields), False)

    # 3. Fingerprint: stable, and moved by anything describe publishes.
    base = {"tasks": {"fields": fields, "module": "planning"}}
    check("fingerprint is deterministic", schema_fingerprint(base), schema_fingerprint(base))
    moved = {"tasks": {"fields": fields, "module": "other"}}
    if schema_fingerprint(base) == schema_fingerprint(moved):
        failures.append("fingerprint ignores an entity's module")
    if schema_fingerprint(base, [{"name": "op", "params": {}}]) == schema_fingerprint(
        base, [{"name": "op", "params": {"x": {"type": "string"}}}]
    ):
        failures.append("fingerprint ignores operation params")

    if failures:
        print("a2app_adapter selftest FAILED:\n  - " + "\n  - ".join(failures))
        return 1
    print("a2app_adapter selftest ok (guard, predicates, fingerprint)")
    return 0


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    print("a2app_adapter is a library; run main.py to serve. Use --selftest to check rules parity.")
