"""A2App adapter (SYSTEM-OWNED — hash-locked in the ownership canon).

A dependency-free port of the A2App served surface: identity, describe, whoami,
context, guarded records CRUD, declared operations (with approval for
destructive ops), the app->agent task/event plane, and the 0.2 auth layer
(spec/v0_2/auth.md): accounts, sessions and invites on a multi-user app,
delegated agent credentials held only as hashes, device-code sign-in, task
credentials, and the user ceiling on every request. It enforces the fixed
validation chain: origin -> credential -> scope -> guard -> backend -> read-back.
Records persist in SQLite (stdlib ``sqlite3`` -- see ``SqliteStore``), so the
stack stays dependency-free while the live database is a real on-disk file
inside the toolkit's declared lifecycle dataDir.

The pure validation rules below MUST match `@a2app/rules` so a FastAPI app and a
Node app reject identical payloads identically — verified by the conformance
suite. The served surface is a port of `@a2app/adapter-core`, which is the
parity oracle for every status, code and shape. FastAPI wiring lives in
`main.py`; this file never imports FastAPI. An agent evolves the app by editing
`schema.py`, never this file.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, quote, unquote, urlsplit

RULES_VERSION = "0.1.0"
PROTOCOL_VERSION = "0.2"
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
    # The record is still referenced, and a `ref` pointing at it says `restrict`.
    "RECORD_REFERENCED": "record_referenced",
}

# What a `ref` does when nothing says otherwise: refuse the delete. Silently
# orphaning is the worse default -- it is invisible at the moment it happens, and
# the app that has to cope with it is the one reading the record weeks later. A
# field opts out with `onDelete: "ignore"`.
#
# There is deliberately no `cascade` or `detach`: both would let one delete write
# to records the caller never named, which an agent cannot approve in advance and
# an audit log cannot explain afterwards. That belongs in a declared operation.
DEFAULT_ON_DELETE = "restrict"

# Page size for the referential scan a delete runs before it commits.
REFERENCE_SCAN_PAGE = 500
# How many blocking record ids are reported per field: the answer is "yes, and
# here are examples", not a dump of every row in the way.
REFERENCE_SCAN_LIMIT = 10
# Hard stop on paging, so a store that ignores `page` cannot spin forever.
REFERENCE_SCAN_MAX_PAGES = 200

# A claimed task with no progress for this long is presumed abandoned and goes
# back to the queue, so a dead agent's work is redelivered rather than lost.
# Anything that delivers work from this queue (`agent-app <dir> bridge`)
# heartbeats well inside it; the value matches adapter-core.
TASK_TIMEOUT_MS = 60_000
# Redelivery is bounded: a task handed out this many times without finishing
# fails with `redelivery_exhausted` instead of cycling forever.
TASK_MAX_DELIVERIES = 5
TERMINAL_TASK = {"completed", "failed", "canceled"}

# -- auth (spec/v0_2/auth.md); every value matches adapter-core ---------------

# The framework's account page: sign in, invites, people, connected agents, and
# approving an agent's sign-in. Served by `main.py`, named in identity.
ACCOUNT_URL = "/_a2app/account"
SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
SIGN_IN_FAILURES = 10
SIGN_IN_WINDOW_MS = 15 * 60 * 1000
LOGIN_MAX = 254
NAME_MAX = 100
PBKDF2_ITERATIONS = 600_000
PBKDF2_KEY_BYTES = 32
PBKDF2_SALT_BYTES = 16
PASSWORD_MIN = 10
PASSWORD_MAX = 256
DEFAULT_EXPIRES_SECONDS = 30 * 24 * 60 * 60
MIN_EXPIRES_SECONDS = 60
MAX_EXPIRES_SECONDS = 365 * 24 * 60 * 60
# A task credential's lifetime (spec §6.2); its task ending kills it sooner.
TASK_CREDENTIAL_SECONDS = 60 * 60
# Device-code sign-in: codes live 10 minutes; a poll sooner than the interval
# is told to slow down, and the interval grows by a step.
CODE_TTL_SECONDS = 600
POLL_INTERVAL_SECONDS = 5
SLOW_DOWN_STEP_SECONDS = 5
# How long a revoked or expired credential is remembered (spec §2.1), so its
# token is told why it stopped rather than that it never existed.
GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
# `lastUsedAt` is written at most this often, so use does not mean a write per
# request.
LAST_USED_RESOLUTION_MS = 60_000
# The admin credential: the app's own .agent-token (spec §2.3).
ADMIN_CREDENTIAL_ID = "cred_local"
# Said to an agent whose credential stopped working (revoked, expired, or its
# person deactivated). A fact, not an instruction: a new credential is the
# person's to give. Same text as adapter-core's AGENT_TEXT.renewHint.
RENEW_HINT = (
    "Ask the person this agent acts for to approve it again (a2app <app> login), "
    "or the app's owner for a new credential."
)

# --------------------------------------------------------------- pure rules

_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
_DATE_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$"
)
_DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


# ---------------------------------------------------------------- network
#
# Where an app listens, and the address the rest of the world uses for it. The
# one rule: a bearer token must never cross a network in clear, so binding a
# non-loopback address needs an https public URL, and a public URL may be plain
# http only when it names this machine (an SSH tunnel ends on loopback).


def is_loopback_name(name: str) -> bool:
    """Is `name` a loopback name or address? Accepts a bracketed IPv6 literal."""
    bare = name.lower().strip("[]")
    if bare == "localhost":
        return True
    try:
        return ipaddress.ip_address(bare).is_loopback
    except ValueError:
        return False


def hostname_of(host: str) -> Optional[str]:
    """The host name in a Host value (`name`, `name:port`, `[v6]:port`), or None."""
    try:
        return urlsplit("//" + host).hostname
    except ValueError:
        return None


def network_policy(host_env: Optional[str], public_url_env: Optional[str]) -> tuple[str, Optional[str]]:
    """Resolve (bind host, public origin) from A2APP_HOST / A2APP_PUBLIC_URL, or
    raise ValueError with the reason the combination is unsafe."""
    host = (host_env or "").strip() or "127.0.0.1"
    public: Optional[str] = None
    scheme = ""
    raw = (public_url_env or "").strip()
    if raw:
        parts = urlsplit(raw)
        scheme = parts.scheme.lower()
        if not parts.netloc:
            raise ValueError(f'A2APP_PUBLIC_URL is not a URL: "{raw}".')
        if scheme not in ("http", "https"):
            raise ValueError(f'A2APP_PUBLIC_URL must be an http(s) URL, not "{raw}".')
        if scheme == "http" and not is_loopback_name(parts.hostname or ""):
            raise ValueError(
                f'A2APP_PUBLIC_URL must be https: "{raw}" would send the agent token across a network in clear. '
                "Put the app behind a TLS proxy, or reach it through an SSH tunnel to a loopback address."
            )
        public = f"{scheme}://{parts.netloc.lower()}"
    if not is_loopback_name(host) and scheme != "https":
        raise ValueError(
            f"A2APP_HOST={host} exposes the app to the network, so A2APP_PUBLIC_URL must name its https address "
            "(the agent token must not cross a network in clear). To reach it through a tunnel instead, keep A2APP_HOST on 127.0.0.1."
        )
    return host, public


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


# ---------------------------------------------------------- auth primitives
#
# The security rules behind accounts, sessions, invites, device codes and
# credentials (spec/v0_2/auth.md), written once. Parity oracle:
# adapters/adapter-core/src/auth.ts. Every secret the app hands out (tokens,
# session ids, invite codes, device codes) is 256 random bits, returned once,
# and stored only as its SHA-256. Passwords are PBKDF2-SHA256 at 600 000
# iterations (OWASP), compared in constant time.

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _iso(ms: int) -> str:
    """Epoch milliseconds as ISO 8601, exactly as JavaScript's toISOString()."""
    return (_EPOCH + timedelta(milliseconds=ms)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ms(iso: str) -> int:
    """ISO 8601 as epoch milliseconds (JavaScript's Date.parse)."""
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) - _EPOCH) // timedelta(milliseconds=1)


def _utf8(text: str) -> bytes:
    # A JSON body may carry a lone surrogate; it must reach a hash, not a 500.
    return text.encode("utf-8", "surrogatepass")


def new_secret() -> str:
    """256 random bits, base64url (43 chars)."""
    return secrets.token_urlsafe(32)


def new_token() -> str:
    """An agent credential token: `a2a_` + 256 random bits."""
    return "a2a_" + new_secret()


def hash_secret(secret: str) -> str:
    """How a secret is stored and looked up: hex SHA-256 of the whole string."""
    return hashlib.sha256(_utf8(secret)).hexdigest()


def new_id(prefix: str) -> str:
    """An id that is not a secret: `prefix_` + 64 random bits, hex."""
    return f"{prefix}_{secrets.token_hex(8)}"


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    """`pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>` -- adapter-core's
    format, byte for byte, so a stored hash verifies on any stack."""
    salt = secrets.token_bytes(PBKDF2_SALT_BYTES)
    key = hashlib.pbkdf2_hmac("sha256", _utf8(password), salt, iterations, PBKDF2_KEY_BYTES)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(key).decode()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of `password` against a stored hash. A malformed
    hash never matches."""
    parts = stored.split("$")
    if len(parts) != 4 or parts[0] != "pbkdf2_sha256" or not re.fullmatch(r"[0-9]+", parts[1]):
        return False
    iterations = int(parts[1])
    if iterations < 1:
        return False
    try:
        salt = base64.b64decode(parts[2])
        expected = base64.b64decode(parts[3])
    except ValueError:
        return False
    if not expected:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", _utf8(password), salt, iterations, len(expected))
    return hmac.compare_digest(actual, expected)


# Consonants only (RFC 8628 §6.1): no vowels, so no words; no look-alikes.
USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"


def new_user_code() -> str:
    """`XXXX-XXXX` from USER_CODE_ALPHABET."""
    code = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(8))
    return f"{code[:4]}-{code[4:]}"


def normalize_user_code(value: str) -> str:
    """A user code as typed: case and the dash do not matter."""
    letters = "".join(c for c in value.upper() if c in USER_CODE_ALPHABET)
    return f"{letters[:4]}-{letters[4:]}" if len(letters) == 8 else ""


def normalize_login(login: str) -> str:
    """A login as stored and compared: trimmed, lower-cased."""
    return login.strip().lower()


# A `%` that does not start an escape: decodeURIComponent refuses the value.
_BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


def parse_cookies(header: Optional[str]) -> dict[str, str]:
    """`Cookie` header -> name/value pairs (the first occurrence of a name wins)."""
    out: dict[str, str] = {}
    for part in (header or "").split(";"):
        eq = part.find("=")
        if eq <= 0:
            continue
        name = part[:eq].strip()
        if name in out:
            continue
        value = part[eq + 1:].strip()
        if _BAD_ESCAPE.search(value):
            continue  # not a value this app wrote
        try:
            out[name] = unquote(value, errors="strict")
        except UnicodeDecodeError:
            continue
    return out


# quote() with these characters also safe is encodeURIComponent.
_URI_COMPONENT_SAFE = "!*'()"


def session_cookie(name: str, value: str, max_age_seconds: int, secure: bool) -> str:
    """A `Set-Cookie` value for the session cookie. `max_age_seconds=0` clears it."""
    attrs = [f"{name}={quote(value, safe=_URI_COMPONENT_SAFE)}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age_seconds}"]
    if secure:
        attrs.append("Secure")
    return "; ".join(attrs)


class FailureLimiter:
    """Counts failures per key in a fixed window (sign-in failures per login).

    In memory: a restart forgets them, which costs an attacker nothing they
    could not get by waiting out the window.
    """

    def __init__(self, max_failures: int, window_ms: int, now_ms: Callable[[], int]):
        self.max = max_failures
        self.window_ms = window_ms
        self.now_ms = now_ms
        self.windows: dict[str, list[int]] = {}  # key -> [count, window start]

    def retry_after(self, key: str) -> int:
        """Seconds until `key` may try again, or 0 when it may now."""
        w = self.windows.get(key)
        if w is None:
            return 0
        elapsed = self.now_ms() - w[1]
        if elapsed >= self.window_ms:
            del self.windows[key]
            return 0
        return -(-(self.window_ms - elapsed) // 1000) if w[0] >= self.max else 0

    def fail(self, key: str) -> None:
        t = self.now_ms()
        w = self.windows.get(key)
        if w is None or t - w[1] >= self.window_ms:
            self.windows[key] = [1, t]
        else:
            w[0] += 1

    def reset(self, key: str) -> None:
        self.windows.pop(key, None)


def _as_object(body: Any) -> dict:
    """A request body read as an object; anything else reads as `{}`."""
    return body if isinstance(body, dict) else {}


def account_wire(a: dict) -> dict:
    """An account as served: never its password hash."""
    return {"id": a["id"], "name": a["name"], "login": a["login"], "role": a["role"], "active": a["active"], "createdAt": a["createdAt"]}


def credential_wire(g: dict, principal_name: Optional[str]) -> dict:
    """A credential as listed: never its token or the token's hash."""
    return {
        "credentialId": g["credentialId"], "principal": g["principal"], "principalName": principal_name,
        "agentName": g["agentName"], "scopes": g["scopes"], "createdAt": g["createdAt"],
        "expiresAt": g["expiresAt"], "lastUsedAt": g["lastUsedAt"], "task": g["task"],
    }


def mint_credential(
    store: Store, now_ms: int, principal: str, agent_name: Optional[str], scopes: list[str],
    expires_in_seconds: int, task: Optional[str] = None,
) -> tuple[str, dict]:
    """Issue a credential: store its hash, return the token (once) with the grant.

    Every credential this app issues is made here: a 256-bit token, stored as
    its SHA-256, bound to one principal, always expiring. Whatever its scopes
    say, each request it makes is limited to what that principal may do at the
    time (`Adapter._credential_of`).
    """
    token = new_token()
    grant = {
        "credentialId": new_id("cred"), "tokenHash": hash_secret(token), "principal": principal,
        "agentName": agent_name, "scopes": scopes, "createdAt": _iso(now_ms),
        "expiresAt": _iso(now_ms + expires_in_seconds * 1000), "lastUsedAt": None, "revokedAt": None,
        "task": task, "admin": False,
    }
    store.put_grant(grant)
    return token, grant


def parse_agent_name(value: Any) -> tuple[Optional[str], Optional[str]]:
    """The optional agent name a caller gave a credential, checked:
    `(name, None)`, or `(None, problem)`."""
    if value is None:
        return None, None
    if not isinstance(value, str) or value.strip() == "" or len(value) > 100:
        return None, "agentName is 1–100 characters."
    return value.strip(), None


def parse_grant_request(body: dict, declared: set) -> tuple[list[str], int, Optional[str]]:
    """The scopes and lifetime a caller asked for, checked:
    `(scopes, expires_in_seconds, None)`, or `([], 0, problem)`. `scopes`
    defaults to `*`; every entry must be `*` or a scope the app declares."""
    scopes = body.get("scopes")
    if scopes is None:
        scopes = ["*"]
    if not isinstance(scopes, list) or not scopes or not all(isinstance(s, str) for s in scopes):
        return [], 0, 'scopes is a non-empty list of scope names (or ["*"]).'
    unknown = [s for s in scopes if s != "*" and s not in declared]
    if unknown:
        return [], 0, f"Not scopes this app declares: {', '.join(unknown)}."
    expires_in = body.get("expiresIn")
    if expires_in is None:
        expires_in = DEFAULT_EXPIRES_SECONDS
    # A whole number of seconds; JSON's 3600.0 is one, a boolean is not.
    if (
        not isinstance(expires_in, (int, float)) or isinstance(expires_in, bool)
        or not MIN_EXPIRES_SECONDS <= expires_in <= MAX_EXPIRES_SECONDS
        or not float(expires_in).is_integer()
    ):
        return [], 0, f"expiresIn is a whole number of seconds from {MIN_EXPIRES_SECONDS} to {MAX_EXPIRES_SECONDS} (365 days)."
    return list(dict.fromkeys(scopes)), int(expires_in), None


# ------------------------------------------------------------------- store

# The single-clause filter grammar this backend implements -- `field = "value"`,
# `field != "value"`, or `field ~ "value"` (contains), optionally wrapped in one
# pair of parentheses. Enough for label->id resolution; a richer backend exposes
# its own query language. Anything outside it is REFUSED, never ignored: a
# store that accepts `filter` and returns unfiltered rows answers 200 with the
# wrong records, which turns every label lookup into a false multi-match.
# Parity: the react-node blueprint's matchFilter in server.mjs.
_FILTER_RE = re.compile(
    r"""^\s*\(?\s*([A-Za-z_]\w*)\s*(=|!=|~)\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'()]+))\s*\)?\s*$"""
)


class UnsupportedFilter(Exception):
    """Raised when a `filter` expression falls outside the grammar above."""

    def __init__(self, expression: str):
        super().__init__(f"filter expression is not supported by this backend: {expression}")
        self.expression = expression


def _filter_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _match_filter(expr: str) -> Callable[[dict], bool]:
    m = _FILTER_RE.match(expr)
    if m is None:
        raise UnsupportedFilter(expr)
    field, op, quoted, single_quoted, bare = m.groups()
    # Only the double-quoted form carries escapes; unescape exactly what the
    # escaping side wrote (backslash-x -> x).
    if quoted is not None:
        value = re.sub(r"\\(.)", r"\1", quoted)
    else:
        value = single_quoted if single_quoted is not None else (bare or "")

    def predicate(record: dict) -> bool:
        current = _filter_str(record.get(field))
        if op == "=":
            return current == value
        if op == "!=":
            return current != value
        return value in current

    return predicate


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
    idempotency keys, approvals, audit, credentials, accounts). The blueprint's
    live store is ``SqliteStore`` below (same interface; records, idempotency
    keys, credentials and accounts durable); this base class is the disposable
    variant for tests and tooling."""

    def __init__(self, seed: Optional[dict] = None):
        self.seed = seed or {}
        # A fresh in-memory store is always empty, so it always takes the seed.
        # SqliteStore sets this False when the database file already existed:
        # re-seeding an existing database on every boot would resurrect a seed
        # record the user deleted.
        self.wants_seed = True
        self.rows: dict[str, dict[str, dict]] = {}
        self.tasks: dict[str, dict] = {}
        self.events: list[dict] = []
        self.idem: dict[tuple, str] = {}
        self.approvals: set[str] = set()
        self.audit: list[dict] = []
        # credentialId -> grant, and tokenHash -> credentialId
        self.grants: dict[str, dict] = {}
        self.grant_tokens: dict[str, str] = {}
        # The auth layer's keyed tables: users, sessions, invites, devices.
        self.tables: dict[str, dict[str, dict]] = {}
        # The event types this app may emit, set by the Adapter from the app's
        # declarations. Empty means none were declared.
        self.event_types: set[str] = set()
        # occurrence key -> task id, so one occurrence makes one task
        self.dedup: dict[str, str] = {}
        self._task_seq = 0
        self._event_seq = 0

    # records ---------------------------------------------------------------
    def _all_records(self, entity: str) -> list[dict]:
        """Every record of one entity — the single hook a durable subclass
        overrides for reads; list_records keeps the shared filter/sort/page."""
        return list(self.rows.get(entity, {}).values())

    def list_records(self, entity: str, query: dict) -> dict:
        items = self._all_records(entity)
        # `where` (field = value) comes from the adapter: a member sees only the
        # records it owns. Applied before filtering, sorting and paging like any
        # other constraint -- after them, a page would come back short and the
        # total would count other people's records.
        for field, value in (query.get("where") or {}).items():
            items = [r for r in items if r.get(field) == value]
        flt = query.get("filter")
        if flt:
            items = [r for r in items if _match_filter(flt)(r)]
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

    # auth rows -------------------------------------------------------------
    # Accounts, sessions, invites and device codes (spec/v0_2/auth.md): rows
    # keyed by id or by the hash of the secret that finds them; no secret is
    # ever a key or a value. Adapter state, never records.
    def auth_row(self, table: str, key: str) -> Optional[dict]:
        return self.tables.get(table, {}).get(key)

    def put_auth_row(self, table: str, key: str, row: dict) -> None:
        self.tables.setdefault(table, {})[key] = row

    def delete_auth_row(self, table: str, key: str) -> None:
        self.tables.get(table, {}).pop(key, None)

    def auth_rows(self, table: str) -> list[tuple[str, dict]]:
        return list(self.tables.get(table, {}).items())

    # grants ----------------------------------------------------------------
    # A credential is held only as the SHA-256 of its token and looked up by
    # it. Callers never mutate a grant in place: they put a new dict.
    def grant_by_token_hash(self, token_hash: str) -> Optional[dict]:
        credential_id = self.grant_tokens.get(token_hash)
        return None if credential_id is None else self.grants.get(credential_id)

    def grant_by_id(self, credential_id: str) -> Optional[dict]:
        return self.grants.get(credential_id)

    def put_grant(self, grant: dict) -> None:
        previous = self.grants.get(grant["credentialId"])
        if previous is not None and previous["tokenHash"] != grant["tokenHash"]:
            self.grant_tokens.pop(previous["tokenHash"], None)
        self.grants[grant["credentialId"]] = grant
        self.grant_tokens[grant["tokenHash"]] = grant["credentialId"]

    def delete_grant(self, credential_id: str) -> None:
        grant = self.grants.pop(credential_id, None)
        if grant is not None:
            self.grant_tokens.pop(grant["tokenHash"], None)

    def list_grants(self) -> list[dict]:
        return list(self.grants.values())

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

    def enqueue_task(
        self, event_id: str, capability: str, payload: dict, dedup_key: Optional[str] = None,
        principal: Optional[str] = None,
    ) -> dict:
        if dedup_key is not None:
            existing = self.tasks.get(self.dedup.get(dedup_key, ""))
            if existing is not None:
                return existing
        self._task_seq += 1
        task = {
            "id": f"task_{self._task_seq}", "app": None, "event": event_id, "status": "submitted",
            # `principal`: who queued it (spec/v0_2/auth.md §6.1); None for work
            # the app queued on its own.
            "request": {"capability": capability, "payload": payload, "principal": principal}, "claim": None,
            "progress": {}, "result": None, "reason": None, "ask": None,
            "createdAt": _now_iso(), "updatedAt": _now_iso(), "deliveries": 1,
        }
        self.tasks[task["id"]] = task
        if dedup_key is not None:
            self.dedup[dedup_key] = task["id"]
        return task

    def trigger(
        self, etype: str, payload: dict, capability: Optional[str] = None, principal: Optional[str] = None,
    ) -> dict:
        """Emit a declared event and, when ``capability`` is given, queue a task
        for an agent. This is the app->agent seam an operation runner reaches
        through the ``store`` it is handed -- where ``principal`` is already
        bound to the runner's caller (``_CallerStore``), so the agent that takes
        the task acts as them (spec/v0_2/auth.md §6). None is work the app
        queues on its own, run as the owner.

        Returns ``{"eventId": ..., "taskId": ...}``; ``taskId`` is None when no
        capability was named, because an event alone asks no agent for work.
        """
        if self.event_types and etype not in self.event_types:
            raise ValueError(f'event type "{etype}" is not declared')
        ev = self.append_event(etype, payload)
        task_id = None
        if capability:
            # Dedup is keyed on the OCCURRENCE, not on the event record: the same
            # trigger firing twice must make one task. The event id is fresh per
            # emit, so keying on it would deduplicate nothing. The occurrence is
            # what the app asked for (type, capability, payload), serialized with
            # sorted keys so key order cannot tell two identical triggers apart.
            occurrence = {"type": etype, "capability": capability, "payload": payload}
            # Who asked is part of the occurrence: the same request from two
            # people is two tasks, each run as the person who asked.
            if principal:
                occurrence["principal"] = principal
            key = "sha256:" + hashlib.sha256(
                json.dumps(occurrence, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            task_id = self.enqueue_task(ev["id"], capability, payload, key, principal)["id"]
        return {"eventId": ev["id"], "taskId": task_id}

    def sweep(self, timeout_ms: int, max_deliveries: int) -> None:
        """Return abandoned claims to the queue.

        A ``working`` task with no update for ``timeout_ms`` goes back to
        ``submitted`` so another agent can take it, and fails with
        ``redelivery_exhausted`` once it has been handed out ``max_deliveries``
        times. Never a silent drop.
        """
        now = datetime.now(timezone.utc)
        for task in self.tasks.values():
            if task["status"] != "working":
                continue
            updated = datetime.fromisoformat(task["updatedAt"].replace("Z", "+00:00"))
            if (now - updated).total_seconds() * 1000 < timeout_ms:
                continue
            if task["deliveries"] >= max_deliveries:
                task["status"] = "failed"
                task["reason"] = "redelivery_exhausted"
            else:
                task["status"] = "submitted"
                task["claim"] = None
                task["deliveries"] += 1
            task["updatedAt"] = _now_iso()

    def list_tasks(self, status: Optional[str]) -> list[dict]:
        return [t for t in self.tasks.values() if status is None or t["status"] == status]

    def get_task(self, task_id: str) -> Optional[dict]:
        return self.tasks.get(task_id)

    def save_task(self, task: dict) -> None:
        task["updatedAt"] = _now_iso()
        self.tasks[task["id"]] = task


class SqliteStore(Store):
    """The blueprint's live store: records + idempotency keys in SQLite
    (stdlib ``sqlite3`` -- still dependency-free).

    Records are JSON rows in one table keyed (entity, id): the schema stays
    declarative and additive (a new field simply appears in the JSON) while the
    DATABASE is a real on-disk file inside the toolkit's declared lifecycle
    dataDir -- which is what backup/restore/promote protect. WAL keeps a reader
    and a writer from blocking each other.

    Idempotency keys persist because a restart is exactly when a retried POST
    arrives -- an in-memory table would return a duplicate record instead of
    the 409 the protocol promises. Credentials and the auth tables (accounts,
    sessions, invites, device codes) persist in tables of their own: they are
    adapter state, never records, and a restart must not sign everyone out or
    forget who may do what. The task/event plane, approvals and audit stay in
    memory: they are runtime queues, not records.

    Writes are durable when the call returns -- there is no separate persist()
    step. A dict read from this store is a COPY: mutate it, then put_record()
    it back, or the change never happened.
    """

    def __init__(self, path: str, seed: Optional[dict] = None):
        super().__init__(seed)
        full = os.path.abspath(path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        fresh = not os.path.exists(full)
        # uvicorn may service requests off the event-loop thread; one connection
        # guarded by one lock keeps this correct without a pool.
        self._lock = threading.Lock()
        self._db = sqlite3.connect(full, check_same_thread=False)
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS records ("
                "entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, "
                "PRIMARY KEY (entity, id))"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS idem ("
                "entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, "
                "PRIMARY KEY (entity, key))"
            )
            # A grant row holds the token's hash, never the token.
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS grants ("
                "credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, data TEXT NOT NULL)"
            )
            self._db.execute("CREATE INDEX IF NOT EXISTS grants_by_token ON grants (token_hash)")
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS auth ("
                "tbl TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, "
                "PRIMARY KEY (tbl, key))"
            )
            self._db.commit()
        self.wants_seed = fresh

    def close(self) -> None:
        """Release the database file (the last connection closing checkpoints
        the WAL into the main file)."""
        self._db.close()

    # records ---------------------------------------------------------------
    def _all_records(self, entity: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT data FROM records WHERE entity = ?", (entity,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def get_record(self, entity: str, rec_id: str) -> Optional[dict]:
        with self._lock:
            row = self._db.execute(
                "SELECT data FROM records WHERE entity = ? AND id = ?", (entity, rec_id)
            ).fetchone()
        return None if row is None else json.loads(row[0])

    def put_record(self, entity: str, rec: dict) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO records (entity, id, data) VALUES (?, ?, ?) "
                "ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data",
                (entity, rec["id"], json.dumps(rec)),
            )
            self._db.commit()

    def delete_record(self, entity: str, rec_id: str) -> bool:
        with self._lock:
            cursor = self._db.execute(
                "DELETE FROM records WHERE entity = ? AND id = ?", (entity, rec_id)
            )
            self._db.commit()
        return cursor.rowcount > 0

    # idempotency -----------------------------------------------------------
    def idem_get(self, entity: str, key: str) -> Optional[str]:
        with self._lock:
            row = self._db.execute(
                "SELECT rec_id FROM idem WHERE entity = ? AND key = ?", (entity, key)
            ).fetchone()
        return None if row is None else row[0]

    def idem_put(self, entity: str, key: str, rec_id: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO idem (entity, key, rec_id) VALUES (?, ?, ?) "
                "ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id",
                (entity, key, rec_id),
            )
            self._db.commit()

    # auth rows -------------------------------------------------------------
    def auth_row(self, table: str, key: str) -> Optional[dict]:
        with self._lock:
            found = self._db.execute("SELECT data FROM auth WHERE tbl = ? AND key = ?", (table, key)).fetchone()
        return None if found is None else json.loads(found[0])

    def put_auth_row(self, table: str, key: str, row: dict) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO auth (tbl, key, data) VALUES (?, ?, ?) "
                "ON CONFLICT (tbl, key) DO UPDATE SET data = excluded.data",
                (table, key, json.dumps(row)),
            )
            self._db.commit()

    def delete_auth_row(self, table: str, key: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM auth WHERE tbl = ? AND key = ?", (table, key))
            self._db.commit()

    def auth_rows(self, table: str) -> list[tuple[str, dict]]:
        with self._lock:
            found = self._db.execute("SELECT key, data FROM auth WHERE tbl = ? ORDER BY rowid", (table,)).fetchall()
        return [(key, json.loads(data)) for key, data in found]

    # grants ----------------------------------------------------------------
    def grant_by_token_hash(self, token_hash: str) -> Optional[dict]:
        with self._lock:
            found = self._db.execute("SELECT data FROM grants WHERE token_hash = ?", (token_hash,)).fetchone()
        return None if found is None else json.loads(found[0])

    def grant_by_id(self, credential_id: str) -> Optional[dict]:
        with self._lock:
            found = self._db.execute("SELECT data FROM grants WHERE credential_id = ?", (credential_id,)).fetchone()
        return None if found is None else json.loads(found[0])

    def put_grant(self, grant: dict) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO grants (credential_id, token_hash, data) VALUES (?, ?, ?) "
                "ON CONFLICT (credential_id) DO UPDATE SET token_hash = excluded.token_hash, data = excluded.data",
                (grant["credentialId"], grant["tokenHash"], json.dumps(grant)),
            )
            self._db.commit()

    def delete_grant(self, credential_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM grants WHERE credential_id = ?", (credential_id,))
            self._db.commit()

    def list_grants(self) -> list[dict]:
        with self._lock:
            found = self._db.execute("SELECT data FROM grants ORDER BY rowid").fetchall()
        return [json.loads(data) for (data,) in found]


class _CallerStore:
    """The store an operation runner is handed: the live store, with
    ``trigger`` bound to the runner's caller.

    The caller is who asked for the work, so the agent that takes a task the
    runner queues acts as them (spec/v0_2/auth.md §6). Binding it here, in
    system-owned code, means a runner cannot forget to pass it -- a task that
    lost its caller would run with the owner's reach whoever asked.
    """

    def __init__(self, store: Store, principal: str):
        self._store = store
        self._principal = principal

    def __getattr__(self, name: str) -> Any:
        return getattr(self._store, name)

    def trigger(self, etype: str, payload: dict, capability: Optional[str] = None) -> dict:
        return self._store.trigger(etype, payload, capability, principal=self._principal)


# ----------------------------------------------------------------- adapter

def _approval_key(name: str, args: dict) -> str:
    canonical = json.dumps({"op": name, "args": args}, sort_keys=True, separators=(",", ":"))
    return "ak_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


# The app's administrator: the admin credential, and the only principal of an
# `authMode: none` app.
_OWNER = {"id": "owner", "name": "Owner", "role": "owner", "active": True}
# The reach of an uncredentialled read on a single-user app: it never meets the
# scope check (`_resolve`).
_ANONYMOUS = "anonymous"
# What a refused caller is shown on describe: nothing.
_NO_ACCESS = {"read": lambda _e: False, "write": lambda _e: False, "run": lambda _o: False}


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
        public_url: Optional[str] = None,
        operation_runners: Optional[dict[str, Callable]] = None,
        events: Optional[list[dict]] = None,
        auth_mode: str = "none",
        credential_hint: Optional[str] = None,
        env: Optional[str] = None,
        capabilities: Optional[dict] = None,
        permissions_of: Optional[Callable[[dict], list]] = None,
        clock: Optional[Callable[[], int]] = None,
    ):
        """`token` is the app's admin credential (its .agent-token). Optional:
        `capabilities` ({name: {"scopes": [...]}}) is what each capability's
        task credential may do, else `*`; `permissions_of(principal)` is what a
        principal ({id, name, role, active}) may do, as scopes, evaluated per
        request, default `*`; `clock` returns epoch milliseconds (tests)."""
        self.app_id = app_id
        self.app_name = app_name
        # {name: {"fields": [...], "module": str, "summary"?, "auth"?, "ownedBy"?, "writeAllow"?}}
        self.entity_defs = entities
        self.operations = operations
        self.modules = modules or []
        self.op_by_name = {o["name"]: o for o in operations}
        self.capabilities = capabilities or {}
        problems = self._model_problems()
        declared = self._all_scopes()
        for capability, spec in self.capabilities.items():
            unknown = [s for s in spec["scopes"] if s != "*" and s not in declared]
            if unknown:
                problems.append(f'capability "{capability}" needs scopes this app does not declare: {", ".join(unknown)}')
        if problems:
            # Fail fast: a model whose entities or operations name a module that
            # was never declared cannot be walked, so serving it would answer 200
            # while omitting real capability.
            raise ValueError(
                "A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - "
                + "\n  - ".join(problems)
            )
        self.store = store
        # The declared event types are what keep the app->agent queue from being
        # an open channel: `trigger` refuses a type that is not declared, so the
        # set of things this app can ever ask an agent to react to is fixed by
        # its author rather than by whatever a runner passes at the moment of
        # firing.
        store.event_types = {e["type"] for e in events or []}
        self.auth_mode = "multi-user" if auth_mode == "multi-user" else "none"
        self.multi_user = self.auth_mode == "multi-user"
        self.permissions_of = permissions_of
        self.now_ms = clock or (lambda: int(time.time() * 1000))
        # The public URL (A2APP_PUBLIC_URL, resolved by network_policy) is one
        # more of the app's own origins, and the hosts this app answers to are
        # derived from those origins: reached at its public URL, it answers
        # there and nowhere new.
        self.public_url = public_url
        self.own_origins = list(allowed_origins or []) + ([public_url] if public_url else [])
        self.allowed_origins = set(self.own_origins)
        self.allowed_hosts: set[str] = set()
        for origin in self.allowed_origins:
            netloc = urlsplit(origin).netloc.lower()
            if netloc:
                self.allowed_hosts.add(netloc)
                self.allowed_hosts.add(hostname_of(netloc) or "")
        # Per app: browsers do not separate cookies by port, so two apps on one
        # machine would otherwise sign each other out.
        self.session_cookie_name = f"a2app_session_{app_id}"
        self.secure_cookies = bool(public_url) and urlsplit(public_url).scheme == "https"
        self.sign_in_failures = FailureLimiter(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS, self.now_ms)
        # Checked against when a login does not exist, so a missing account
        # takes as long to refuse as a wrong password and the timing does not
        # say which. Made on first use.
        self._dummy_hash: Optional[str] = None
        self.runners = operation_runners or {}
        self.credential_hint = credential_hint or "Read the app's .agent-token file (mode 0600) in the project directory."
        self.env = env
        self.limiter = _RateLimiter(dict(DEFAULT_RATE_LIMITS), self.now_ms)
        # One request at a time through the adapter's state, released only
        # around password hashing (`_unlocked`) -- the points where adapter-core
        # awaits. main.py calls `dispatch` off the event loop, so a sign-in's
        # few hundred milliseconds of PBKDF2 never stall anyone else.
        self._lock = threading.RLock()

        # The admin credential, seeded from the app's own .agent-token and
        # hashed on the way in. Re-seeding at every boot follows a rotated
        # token file.
        now = self.now_ms()
        existing = store.grant_by_id(ADMIN_CREDENTIAL_ID)
        store.put_grant({
            "credentialId": ADMIN_CREDENTIAL_ID, "tokenHash": hash_secret(token), "principal": _OWNER["id"],
            "agentName": "local", "scopes": ["*"], "createdAt": existing["createdAt"] if existing else _iso(now),
            "expiresAt": None, "lastUsedAt": existing["lastUsedAt"] if existing else None, "revokedAt": None,
            "task": None, "admin": True,
        })
        # Revoked and expired credentials are kept a while so their tokens are
        # told why they stopped; after that they are gone.
        for g in store.list_grants():
            ended = g["revokedAt"] or (g["expiresAt"] if g["expiresAt"] and _ms(g["expiresAt"]) <= now else None)
            if ended and now - _ms(ended) > GRANT_RETENTION_MS:
                store.delete_grant(g["credentialId"])
        # Seed records (materialize server-managed read-only fields) — but only
        # into a store that is genuinely fresh. A durable store that already
        # holds a database refuses the seed: re-seeding on every boot would
        # resurrect seed records the user deleted.
        if store.wants_seed:
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
            owned_by = d.get("ownedBy")
            if owned_by is not None:
                # The adapter writes the owner and the guard keeps clients from
                # doing so, which only holds for a declared, read-only string field.
                owner = next((f for f in d["fields"] if f["name"] == owned_by), None)
                if owner is None:
                    problems.append(f'entity "{name}" is ownedBy "{owned_by}", which is not one of its fields')
                elif owner["type"] != "string" or owner.get("readOnly") is not True:
                    problems.append(f'entity "{name}" is ownedBy "{owned_by}", which must be a readOnly string field')

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
            "authMode": self.auth_mode, "accountUrl": ACCOUNT_URL,
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
        if d.get("ownedBy"):
            level["ownedBy"] = d["ownedBy"]
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
    # Parity oracle: `credentialOf`, `resolve`, `authorize`, `managerOf` and
    # `accessFor` in adapters/adapter-core/src/server.ts.

    def _all_scopes(self) -> set:
        """Every scope the app declares: what `*` means."""
        scopes = set()
        for name in self.entity_defs:
            scopes.add(f"data:{name}:read")
            scopes.add(f"data:{name}:write")
        for o in self.operations:
            scopes.add(f"op:{o['name']}")
        return scopes

    def _expand_scopes(self, scopes: list) -> set:
        return self._all_scopes() if "*" in scopes else set(scopes)

    def _principal_info(self, principal: str) -> Optional[dict]:
        """Who a principal is ({id, name, role, active}), or None when unknown."""
        if principal == _OWNER["id"]:
            return dict(_OWNER)
        if not self.multi_user:
            return None
        a = self.store.auth_row("users", principal)
        return {"id": a["id"], "name": a["name"], "role": a["role"], "active": a["active"]} if a else None

    def _permissions(self, info: Optional[dict]) -> Optional[set]:
        """What a principal may do now (spec §3), or None when it may do nothing."""
        if not info or not info["active"]:
            return None
        return self._expand_scopes(self.permissions_of(info) if self.permissions_of else ["*"])

    def _credential_of(self, headers: dict) -> Optional[dict]:
        """The credential this request presents, checked in the order spec §9
        gives: unknown, revoked (or its task is over), expired, then whether the
        person it acts for may still act. Returns {grant, info, held} -- held
        being its own scopes intersected with the principal's, evaluated now --
        or {reply}; None when no credential was presented."""
        token = headers.get("x-a2app-token") or headers.get("x-lui-token")
        if not token:
            return None
        grant = self.store.grant_by_token_hash(hash_secret(token))
        t = self.now_ms()
        if grant is None:
            return {"reply": self._err(401, "credential_invalid", "This credential is not one this app issued.", how=RENEW_HINT)}
        task = None if grant["task"] is None else self.store.get_task(grant["task"])
        if grant["revokedAt"] is not None or (grant["task"] is not None and (task is None or task["status"] in TERMINAL_TASK)):
            return {"reply": self._err(401, "credential_revoked", "This credential was revoked.", how=RENEW_HINT)}
        if grant["expiresAt"] is not None and _ms(grant["expiresAt"]) <= t:
            return {"reply": self._err(401, "token_expired", f"This credential expired at {grant['expiresAt']}.", how=RENEW_HINT)}
        info = self._principal_info(grant["principal"])
        allowed = self._permissions(info)
        if info is None or allowed is None:
            return {"reply": self._err(401, "principal_inactive", "The person this credential acts for is no longer active.")}
        if grant["lastUsedAt"] is None or t - _ms(grant["lastUsedAt"]) >= LAST_USED_RESOLUTION_MS:
            self.store.put_grant({**grant, "lastUsedAt": _iso(t)})
        return {"grant": grant, "info": info, "held": self._expand_scopes(grant["scopes"]) & allowed}

    def _is_foreign_origin(self, headers: dict) -> bool:
        origin = headers.get("origin")
        return origin is not None and origin not in self.allowed_origins  # no Origin: a program

    def _is_same_origin(self, headers: dict) -> bool:
        """True when the request carries one of the app's OWN origins."""
        origin = headers.get("origin")
        return origin is not None and origin in self.allowed_origins

    def _from_own_page(self, headers: dict) -> bool:
        """Whether a request came from one of the app's own pages. Only ever used
        to pick which 401 to send, or for a read on `authMode: none`. A browser
        marks same-origin fetches, GETs included, with Sec-Fetch-Site, which a
        web page cannot forge; a program sends neither header."""
        return self._is_same_origin(headers) or headers.get("sec-fetch-site") == "same-origin"

    def _session_of(self, headers: dict) -> Optional[dict]:
        """The signed-in account behind this request's session cookie, as
        {key, account}, or None. A deactivated account's session stops here."""
        if not self.multi_user:
            return None
        secret = parse_cookies(headers.get("cookie")).get(self.session_cookie_name)
        if not secret:
            return None
        key = hash_secret(secret)
        session = self.store.auth_row("sessions", key)
        if session is None:
            return None
        if _ms(session["expiresAt"]) <= self.now_ms():
            self.store.delete_auth_row("sessions", key)
            return None
        account = self.store.auth_row("users", session["principal"])
        return {"key": key, "account": account} if account and account["active"] else None

    def _unauthenticated(self, headers: dict, message: str):
        if self.multi_user and self._from_own_page(headers):
            return self._err(401, "sign_in_required", "Sign in to use this app.", signInUrl=f"{ACCOUNT_URL}#sign-in")
        return self._err(401, ERROR_CODES["AGENT_TOKEN_REQUIRED"], message, how=self.credential_hint)

    def _resolve(self, headers: dict, is_write: bool) -> dict:
        """Who the caller is, in a fixed order: a foreign origin is refused;
        then the agent credential; then, on a multi-user app, the session (a
        change must come from the app's own page); on `authMode: none`, the
        app's own View is the owner. Returns {ctx, held, grant} or {reply};
        `held` is `_ANONYMOUS` for an anonymous read on a single-user app, which
        the scope check does not apply to."""
        if self._is_foreign_origin(headers):
            return {"reply": self._err(403, "forbidden_origin", "Refused: request Origin is not this app's own.")}
        presented = self._credential_of(headers)
        if presented is not None and "reply" in presented:
            return presented
        if presented is not None:
            grant, info = presented["grant"], presented["info"]
            ctx = {"credentialId": grant["credentialId"], "agentName": grant["agentName"], "principal": info["id"], "role": info["role"]}
            return {"ctx": ctx, "held": presented["held"], "grant": grant}
        if self.multi_user:
            session = self._session_of(headers)
            if session is not None:
                if is_write and not self._is_same_origin(headers):
                    # A signed-in change must come from this app's own page (CSRF, spec §4).
                    return {"reply": self._err(403, "forbidden_origin", "A signed-in change must come from this app's own page.")}
                account = session["account"]
                ctx = {"credentialId": "session", "agentName": None, "principal": account["id"], "role": account["role"]}
                return {"ctx": ctx, "held": self._permissions(self._principal_info(account["id"])) or set(), "grant": None}
            return {"reply": self._unauthenticated(headers, "This app needs a credential.")}
        # The app's own UI (same origin) is trusted: no credential needed. A
        # browser sends Origin only on a change; on a read it marks the request
        # with Sec-Fetch-Site. A local program can forge that, but on this mode
        # it already reads everything without a credential, so only a change is
        # held to the stronger Origin rule.
        if self._is_same_origin(headers) or (not is_write and self._from_own_page(headers)):
            ctx = {"credentialId": "ui", "agentName": None, "principal": _OWNER["id"], "role": "owner"}
            return {"ctx": ctx, "held": self._permissions(dict(_OWNER)) or set(), "grant": None}
        # A program write always needs a credential; an anonymous read on a
        # single-user app proceeds as the owner.
        if is_write:
            return {"reply": self._unauthenticated(headers, "This write requires an agent credential.")}
        ctx = {"credentialId": "anonymous", "agentName": None, "principal": _OWNER["id"], "role": "owner"}
        return {"ctx": ctx, "held": _ANONYMOUS, "grant": None}

    def _authorize(self, headers: dict, scope: Optional[str], is_write: bool):
        """The fixed chain: origin -> credential -> scope. Returns (ctx, None),
        or (None, refusal)."""
        caller = self._resolve(headers, is_write)
        if "reply" in caller:
            return None, caller["reply"]
        if scope and caller["held"] != _ANONYMOUS and scope not in caller["held"]:
            return None, self._err(403, ERROR_CODES["INSUFFICIENT_SCOPE"], f"This credential does not hold {scope}.", required=scope)
        return caller["ctx"], None

    def _manager_of(self, headers: dict, write: bool):
        """The caller as a manager of accounts and credentials (spec §2.4): a
        signed-in person, the app's own View on `authMode: none`, or the admin
        credential. An agent's delegated credential is never one. Returns
        ({principal, role}, None), or (None, refusal)."""
        caller = self._resolve(headers, write)
        if "reply" in caller:
            return None, caller["reply"]
        if caller["grant"] is not None:
            if not caller["grant"]["admin"]:
                return None, self._err(403, "not_a_manager", "An agent's credential cannot manage accounts or credentials.")
            return {"principal": _OWNER["id"], "role": "owner"}, None
        if caller["ctx"]["credentialId"] == "anonymous":
            return None, self._unauthenticated(headers, "Managing this app needs a credential.")
        return {"principal": caller["ctx"]["principal"], "role": caller["ctx"]["role"]}, None

    def _public_origin(self, headers: dict) -> str:
        """Where this app is reached, for links handed to a person. The Host
        header has already passed the host check by the time a route runs."""
        if self.public_url:
            return self.public_url
        host = headers.get("host")
        return f"http://{host}" if host else (self.own_origins[0] if self.own_origins else "")

    def _unlocked(self, fn: Callable, *args: Any) -> Any:
        """Run slow, pure work (password hashing) with the adapter lock
        released, so other requests are served meanwhile. State read before it
        may have changed after it, exactly as across an `await` in
        adapter-core; callers re-check what they rely on."""
        self._lock.release()
        try:
            return fn(*args)
        finally:
            self._lock.acquire()

    def _rate_gate(self, headers: dict, cls: str):
        caller = headers.get("x-a2app-token") or (("origin:" + headers["origin"]) if headers.get("origin") else "anon")
        decision = self.limiter.check(caller, cls)
        if decision["allowed"]:
            return None
        return self._err(429, ERROR_CODES["RATE_LIMITED"], f"Rate limit exceeded ({decision['limit']} per window). Slow down and retry.", retryAfterSeconds=decision["retryAfterSeconds"])

    # -- ownership (spec §5) ------------------------------------------------
    def _owned_only(self, d: dict, ctx: dict) -> bool:
        """Whether `ctx` sees only the records it owns of this entity."""
        return self.multi_user and d.get("ownedBy") is not None and ctx["role"] != "owner"

    def _visible(self, d: dict, ctx: dict, rec: Optional[dict]) -> Optional[dict]:
        """The record if `ctx` may see it, else None (another member's record
        is indistinguishable from a missing one)."""
        if rec is None:
            return None
        return None if self._owned_only(d, ctx) and rec.get(d["ownedBy"]) != ctx["principal"] else rec

    # -- access, as describe and whoami render it ---------------------------
    def _anonymous_access(self) -> dict:
        """What an uncredentialled caller on a single-user app may do: reads,
        and nothing that changes anything. `_authorize` refuses its writes and
        any operation not declared readOnly; rendering it as full access would
        tell an agent it may plan writes that are then refused."""
        return {
            "read": lambda _e: True,
            "write": lambda _e: False,
            "run": lambda o: self.op_by_name.get(o, {}).get("readOnly") is True,
        }

    def _access_for(self, headers: dict) -> dict:
        """What this caller may do, for rendering access on a describe level.

        Mirrors `_authorize`'s precedence exactly, including the anonymous read
        on a single-user app, which reaches a context without the scope check.
        """
        caller = self._resolve(headers, False)
        if "reply" in caller:
            return _NO_ACCESS
        if caller["held"] == _ANONYMOUS:
            return self._anonymous_access()
        held = caller["held"]
        return {
            "read": lambda e: f"data:{e}:read" in held,
            "write": lambda e: f"data:{e}:write" in held,
            "run": lambda o: f"op:{o}" in held,
        }

    def _reach_as_scopes(self, access: dict) -> set:
        """The same reach, written as the scope names a grant would carry, so
        whoami and describe cannot disagree about one caller."""
        scopes = set()
        for name in self.entity_defs:
            if access["read"](name):
                scopes.add(f"data:{name}:read")
            if access["write"](name):
                scopes.add(f"data:{name}:write")
        for o in self.operations:
            if access["run"](o["name"]):
                scopes.add(f"op:{o['name']}")
        return scopes

    # -- dispatch -----------------------------------------------------------
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
                             modules=[m["name"] for m in self.modules])
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
                                 required=f"data:{entity}:read")
            return 200, self._describe_entity(module_name, entity, d, access)

        limited = self._rate_gate(headers, "data")
        if limited:
            return limited
        ctx, reply = self._authorize(headers, f"data:{entity}:read", False)
        if reply:
            return reply

        record_id = segments[2]
        record = self._visible(d, ctx, self.store.get_record(entity, record_id))
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
                             required=f"data:{target}:read")
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

    def _is_allowed_host(self, raw: str) -> bool:
        if raw.lower() in self.allowed_hosts:
            return True
        name = hostname_of(raw)
        return name is not None and (is_loopback_name(name) or name in self.allowed_hosts)

    def host_refusal(self, headers: dict):
        """The `403 forbidden_host` reply for a request under a Host this app
        does not answer to, else None. Checked before any route -- including
        the unauthenticated identity document and the account page, which are
        otherwise a free fingerprint of the app for a rebound page: binding
        loopback does not stop a page on evil.com whose DNS re-resolves to
        127.0.0.1, but its Host header still says evil.com."""
        host = next((v for k, v in (headers or {}).items() if k.lower() == "host"), None)
        if host is not None and not self._is_allowed_host(host):
            return self._err(403, "forbidden_host", f'Refused: this app answers only on its own host, not "{host}".')
        return None

    def dispatch(self, method: str, path: str, headers: dict, body: Optional[dict], query: Optional[dict] = None):
        """Route one request. Returns ``(status, json, headers)``; the headers
        are the ones the reply sets (a session cookie), usually none."""
        with self._lock:
            reply = self._route(method, path, headers, body, query)
        return reply[0], reply[1], (reply[2] if len(reply) > 2 else {})

    def _route(self, method: str, path: str, headers: dict, body: Optional[dict], query: Optional[dict]):
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        method = method.upper()
        q = dict(query or {})
        if "?" in path:
            path, qs = path.split("?", 1)
            q.update({k: v[-1] for k, v in parse_qs(qs).items()})
        path = re.sub(r"/+$", "", path) or "/"

        refused = self.host_refusal(headers)
        if refused is not None:
            return refused
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
            # whoami answers whoever this app will actually serve, which is what
            # `_authorize` decides -- so it asks the same question. An
            # uncredentialled caller on a single-user app reads records, and is
            # told so here rather than 401.
            caller = self._resolve(headers, False)
            if "reply" in caller:
                return caller["reply"]
            ctx, held, grant = caller["ctx"], caller["held"], caller["grant"]
            info = self._principal_info(ctx["principal"])
            return 200, {
                "a2app": True,
                "credentialId": ctx["credentialId"],
                "agentName": ctx["agentName"],
                "principal": ctx["principal"],
                "principalName": info["name"] if info else None,
                "role": ctx["role"],
                "expiresAt": grant["expiresAt"] if grant else None,
                # The reach the request was given: a credential's scopes
                # intersected with what its person may do now, or a person's
                # own. An anonymous read was never scope-checked, so it reports
                # the reach describe renders -- one source, so they agree.
                "scopes": sorted(self._reach_as_scopes(self._access_for(headers)) if held == _ANONYMOUS else held),
            }
        if path.startswith("/api/_a2app/auth/"):
            # Unauthenticated by design (an agent starts here with nothing), so
            # it is metered like an operation before anything is looked up.
            limited = self._rate_gate(headers, "ops")
            if limited:
                return limited
            reply = self._handle_device(method, headers, body, path)
            if reply is not None:
                return reply
        if path == "/api/_a2app/credentials" or path.startswith("/api/_a2app/credentials/"):
            return self._handle_credentials(method, headers, body, path)
        if any(path == p or path.startswith(p + "/") for p in ("/api/_a2app/session", "/api/_a2app/invites", "/api/_a2app/users")):
            if not self.multi_user:
                return self._err(404, "not_multi_user", "This app has no accounts: its authMode is none.")
            reply = self._handle_accounts(method, headers, body, path)
            if reply is not None:
                return reply
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

        return self._err(404, "not_found", "No such route. Operations are invoked with POST /api/ops/<name>; GET /api/_a2app/describe lists them.")

    # -- records ------------------------------------------------------------
    def _references_to(self, entity: str, rec_id: str) -> list[dict]:
        """Who still points at this record.

        Every `ref` and `list<ref>` names the entity it targets, so the app has
        ALREADY declared where its references live -- this reads that rather than
        asking for a second declaration.

        Pages through referencing entities instead of filtering in the store: a
        filter grammar differs per backend, and a policy that silently did
        nothing against one of them would be worse than no policy. Only entities
        that actually declare a `restrict` ref to this one are read, so an entity
        nothing points at costs nothing.
        """
        blockers: list[dict] = []
        for other, d in self.entity_defs.items():
            pointing = [
                f
                for f in d["fields"]
                if f.get("type") in ("ref", "list<ref>")
                and f.get("entity") == entity
                and f.get("onDelete", DEFAULT_ON_DELETE) == "restrict"
            ]
            if not pointing:
                continue

            found: dict[str, list[str]] = {}
            page = 1
            while True:
                result = self.store.list_records(other, {"page": page, "perPage": REFERENCE_SCAN_PAGE})
                items = result.get("items") or []
                for row in items:
                    for f in pointing:
                        value = row.get(f["name"])
                        hit = (rec_id in value) if isinstance(value, list) else (value == rec_id)
                        if not hit:
                            continue
                        ids = found.setdefault(f["name"], [])
                        if len(ids) < REFERENCE_SCAN_LIMIT:
                            ids.append(str(row.get("id", "")))
                if len(items) < REFERENCE_SCAN_PAGE:
                    break
                page += 1
                if page > REFERENCE_SCAN_MAX_PAGES:
                    break

            for field, ids in found.items():
                blockers.append({"entity": other, "field": field, "ids": ids})
        return blockers

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
            ctx, reply = self._authorize(headers, f"data:{entity}:read", False)
            if reply:
                return reply
            if rec_id:
                rec = self._visible(d, ctx, self.store.get_record(entity, rec_id))
                if not rec:
                    return self._err(404, "record_not_found", f'No {entity} record "{rec_id}".')
                return 200, rec
            # Only what the store is asked: the request cannot name a `where`.
            list_query = {k: query[k] for k in ("filter", "sort", "perPage", "page") if k in query}
            if self._owned_only(d, ctx):
                list_query["where"] = {d["ownedBy"]: ctx["principal"]}
            try:
                return 200, self.store.list_records(entity, list_query)
            except UnsupportedFilter as e:
                # Refuse, never ignore: unfiltered rows under a filter would be
                # a 200 with the wrong records (see the grammar's comment).
                return self._err(400, "invalid_filter", str(e))

        ctx, reply = self._authorize(headers, f"data:{entity}:write", True)
        if reply:
            return reply
        body = body or {}

        if method == "DELETE":
            if not rec_id:
                return self._err(400, "usage", "DELETE requires a record id.")
            if self._owned_only(d, ctx) and not self._visible(d, ctx, self.store.get_record(entity, rec_id)):
                return self._err(404, "record_not_found", f'No {entity} record "{rec_id}".')

            # The app's referential rules bind THIS door too.
            #
            # An app that guards deletion inside an operation has guarded one way
            # in: its own UI. This generic record route is the other, and it used
            # to go straight to the store -- so the rule held right up until an
            # agent took the path the rule did not cover, and the orphan it left
            # was reported as a successful delete. The check belongs here, in
            # adapter code an app author cannot edit, because this is the only
            # place both doors pass through.
            blockers = self._references_to(entity, rec_id)
            if blockers:
                total = sum(len(b["ids"]) for b in blockers)
                where = ", ".join(f"{b['entity']}.{b['field']}" for b in blockers)
                said = "a record still references" if total == 1 else f"{total} records still reference"
                return self._err(
                    409,
                    ERROR_CODES["RECORD_REFERENCED"],
                    f'Cannot delete {entity} "{rec_id}": {said} it ({where}).',
                    referencedBy=blockers,
                    resolution=(
                        "Remove or repoint the referencing records first, or run an operation the app "
                        'provides for this. An app that intends references to outlive the record '
                        'declares `onDelete: "ignore"` on the ref.'
                    ),
                )

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
            # The owner field is the adapter's to set: the guard has already
            # refused a client that tried, because it is read-only.
            owned_by = d.get("ownedBy")
            stored = self._materialize(entity, {**body, owned_by: ctx["principal"]} if owned_by else body)
            self.store.put_record(entity, stored)
        else:
            if not rec_id:
                return self._err(400, "usage", "PATCH requires a record id.")
            existing = self._visible(d, ctx, self.store.get_record(entity, rec_id))
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
            # `ctx` is who is calling ({credentialId, agentName, principal,
            # role}); a runner holds itself to the same ownership rule for the
            # records it touches. Its store's `trigger` records that caller.
            result = runner(args, ctx, _CallerStore(self.store, ctx["principal"]))
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

        self.store.sweep(TASK_TIMEOUT_MS, TASK_MAX_DELIVERIES)

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
        body = _as_object(body)

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
            # A terminal write belongs to a live claim. Once the sweeper has
            # returned a task to the queue, a late completion from the run that
            # abandoned it must not close work someone else may now be doing.
            if task["status"] not in ("working", "input-required"):
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} is {task["status"]}, not in progress.')
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
        if action == "credential":
            # What the bridge runs the task's harness with (spec §6.2): the
            # person who queued it, the capability's scopes, and no life past
            # the task.
            manager, reply = self._manager_of(headers, write=True)
            if reply:
                return reply
            if manager["role"] != "owner":
                return self._err(403, "not_a_manager", "Only an owner issues a task's credential.")
            if task["status"] in TERMINAL_TASK:
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} already reached {task["status"]}.')
            principal = task["request"].get("principal") or _OWNER["id"]
            info = self._principal_info(principal)
            if not info or not info["active"]:
                return self._err(401, "principal_inactive", "The person who queued this task is no longer active.")
            agent_name, problem = parse_agent_name(body.get("agentName"))
            if problem:
                return self._err(400, "usage", problem)
            capability = self.capabilities.get(task["request"]["capability"])
            token, grant = mint_credential(
                self.store, self.now_ms(), principal, agent_name,
                list(capability["scopes"]) if capability else ["*"], TASK_CREDENTIAL_SECONDS, task=task["id"],
            )
            return 201, {"a2app": True, "token": token, "credential": credential_wire(grant, info["name"])}
        return self._err(404, "usage", f'Unknown task action "{action}".')

    @staticmethod
    def _task_wire(t: dict) -> dict:
        return {
            "id": t["id"], "app": t["app"], "event": t["event"], "status": t["status"],
            "request": {**t["request"], "principal": t["request"].get("principal")},
            "claim": t["claim"], "progress": t["progress"],
            "result": t["result"], "reason": t["reason"], "createdAt": t["createdAt"],
            "updatedAt": t["updatedAt"], "pollAfterMs": 2000,
        }

    # -- accounts, sessions, invites (multi-user only; spec §4) ---------------
    # Parity oracle: adapters/adapter-core/src/accounts.ts.
    #
    #   GET/POST/DELETE /api/_a2app/session        who is signed in · sign in · sign out
    #   POST /api/_a2app/invites                    a one-time setup link (owner manager)
    #   GET/POST /api/_a2app/invites/{code}         read · accept (creates the account)
    #   GET /api/_a2app/users                       every account (owner manager)
    #   PATCH /api/_a2app/users/{id}                activate/deactivate, change role
    #
    # Accounts are adapter state, never records: the records API never serves
    # them, and a password hash never leaves these methods.

    def _handle_accounts(self, method, headers, body, path):
        """Route one request under /api/_a2app/{session,invites,users}, or None."""
        if path == "/api/_a2app/session":
            return self._handle_session(method, headers, body)
        if path == "/api/_a2app/invites":
            return self._handle_invites(method, headers, body, None)
        if path.startswith("/api/_a2app/invites/"):
            return self._handle_invites(method, headers, body, unquote(path[len("/api/_a2app/invites/"):]))
        if path == "/api/_a2app/users":
            return self._handle_users(method, headers, body, None)
        if path.startswith("/api/_a2app/users/"):
            return self._handle_users(method, headers, body, unquote(path[len("/api/_a2app/users/"):]))
        return None

    def _accounts(self) -> list[dict]:
        return [a for _, a in self.store.auth_rows("users")]

    def _account_by_login(self, login: str) -> Optional[dict]:
        return next((a for a in self._accounts() if a["login"] == login), None)

    def _start_session(self, account: dict, status: int):
        secret = new_secret()
        created = self.now_ms()
        self.store.put_auth_row("sessions", hash_secret(secret), {
            "principal": account["id"], "createdAt": _iso(created), "expiresAt": _iso(created + SESSION_TTL_MS),
        })
        cookie = session_cookie(self.session_cookie_name, secret, SESSION_TTL_MS // 1000, self.secure_cookies)
        return status, {"a2app": True, **account_wire(account)}, {"set-cookie": cookie}

    @staticmethod
    def _account_problem(body: dict) -> Optional[str]:
        """The reason `body` is not a valid new account, or None."""
        name, login, password = body.get("name"), body.get("login"), body.get("password")
        if not isinstance(name, str) or name.strip() == "" or len(name.strip()) > NAME_MAX:
            return f"name must be 1–{NAME_MAX} characters."
        if not isinstance(login, str) or normalize_login(login) == "" or len(normalize_login(login)) > LOGIN_MAX:
            return f"login must be 1–{LOGIN_MAX} characters."
        if not isinstance(password, str) or len(password) < PASSWORD_MIN or len(password) > PASSWORD_MAX:
            return f"password must be {PASSWORD_MIN}–{PASSWORD_MAX} characters."
        return None

    def _live_invite(self, code: str) -> Optional[tuple[str, dict]]:
        key = hash_secret(code)
        invite = self.store.auth_row("invites", key)
        if invite is None:
            return None
        if _ms(invite["expiresAt"]) <= self.now_ms():
            self.store.delete_auth_row("invites", key)
            return None
        return key, invite

    def _handle_session(self, method, headers, body):
        if method == "GET":
            session = self._session_of(headers)
            if session is None:
                return self._err(401, "sign_in_required", "Not signed in.", signInUrl=f"{ACCOUNT_URL}#sign-in")
            return 200, {"a2app": True, **account_wire(session["account"])}
        if method == "DELETE":
            session = self._session_of(headers)
            if session is not None:
                self.store.delete_auth_row("sessions", session["key"])
            cleared = session_cookie(self.session_cookie_name, "", 0, self.secure_cookies)
            return 200, {"a2app": True, "ok": True}, {"set-cookie": cleared}
        if method != "POST":
            return self._err(405, "usage", f"{method} not allowed on the session.")

        body = _as_object(body)
        if not isinstance(body.get("login"), str) or not isinstance(body.get("password"), str):
            return self._err(400, "usage", "Sign in with { login, password }.")
        login = normalize_login(body["login"])
        wait = self.sign_in_failures.retry_after(login)
        if wait > 0:
            return self._err(429, "rate_limited", "Too many failed sign-ins for this login. Try again later.", retryAfterSeconds=wait)
        account = self._account_by_login(login)
        if account is not None:
            matches = self._unlocked(verify_password, body["password"], account["passwordHash"])
        else:
            if self._dummy_hash is None:
                self._dummy_hash = self._unlocked(hash_password, new_secret())
            self._unlocked(verify_password, body["password"], self._dummy_hash)
            matches = False
        if account is None or not matches or not account["active"]:
            self.sign_in_failures.fail(login)
            return self._err(401, "sign_in_failed", "That login and password do not match an active account.")
        self.sign_in_failures.reset(login)
        return self._start_session(account, 200)

    def _handle_invites(self, method, headers, body, code):
        if code is None:
            if method != "POST":
                return self._err(405, "usage", f"{method} not allowed on invites.")
            manager, reply = self._manager_of(headers, write=True)
            if reply:
                return reply
            if manager["role"] != "owner":
                return self._err(403, "not_a_manager", "Only an owner can invite people.")
            role = _as_object(body).get("role")
            if role is None:
                role = "member"
            if role not in ("owner", "member"):
                return self._err(400, "usage", 'role is "owner" or "member".')
            secret = new_secret()
            created = self.now_ms()
            invite = {"role": role, "createdAt": _iso(created), "expiresAt": _iso(created + INVITE_TTL_MS)}
            self.store.put_auth_row("invites", hash_secret(secret), invite)
            return 201, {
                "a2app": True, "code": secret, "url": f"{self._public_origin(headers)}{ACCOUNT_URL}#setup/{secret}",
                "role": invite["role"], "expiresAt": invite["expiresAt"],
            }

        found = self._live_invite(code)
        if found is None:
            return self._err(404, "invite_invalid", "This invite link is not valid: it was used, or it expired.")
        if method == "GET":
            return 200, {"a2app": True, "role": found[1]["role"], "expiresAt": found[1]["expiresAt"]}
        if method != "POST":
            return self._err(405, "usage", f"{method} not allowed on an invite.")

        body = _as_object(body)
        problem = self._account_problem(body)
        if problem:
            return self._err(400, "usage", problem)
        login = normalize_login(body["login"])
        if self._account_by_login(login) is not None:
            return self._err(409, "login_taken", "That login is already in use.")
        password_hash = self._unlocked(hash_password, body["password"])
        # Hashing ran with the lock released, so check again: a second
        # acceptance of the same invite, or a second account racing for the
        # same login, sees this one's result. From here to the write is one step.
        still = self._live_invite(code)
        if still is None:
            return self._err(404, "invite_invalid", "This invite link is not valid: it was used, or it expired.")
        if self._account_by_login(login) is not None:
            return self._err(409, "login_taken", "That login is already in use.")
        account = {
            "id": new_id("usr"), "name": body["name"].strip(), "login": login, "role": still[1]["role"],
            "active": True, "createdAt": _iso(self.now_ms()), "passwordHash": password_hash,
        }
        self.store.delete_auth_row("invites", still[0])
        self.store.put_auth_row("users", account["id"], account)
        return self._start_session(account, 201)

    def _handle_users(self, method, headers, body, user_id):
        manager, reply = self._manager_of(headers, write=method != "GET")
        if reply:
            return reply
        if manager["role"] != "owner":
            return self._err(403, "not_a_manager", "Only an owner can manage people.")

        if user_id is None:
            if method != "GET":
                return self._err(405, "usage", f"{method} not allowed on users.")
            users = [account_wire(a) for a in sorted(self._accounts(), key=lambda a: a["createdAt"])]
            return 200, {"a2app": True, "users": users}
        if method != "PATCH":
            return self._err(405, "usage", f"{method} not allowed on a user.")
        account = self.store.auth_row("users", user_id)
        if account is None:
            return self._err(404, "not_found", f'No account "{user_id}".')
        body = _as_object(body)
        if "active" in body and not isinstance(body["active"], bool):
            return self._err(400, "usage", "active is true or false.")
        if "role" in body and body["role"] not in ("owner", "member"):
            return self._err(400, "usage", 'role is "owner" or "member".')
        updated = {**account, **{k: body[k] for k in ("active", "role") if k in body}}
        loses_owner = account["role"] == "owner" and account["active"] and (updated["role"] != "owner" or not updated["active"])
        active_owners = [a for a in self._accounts() if a["role"] == "owner" and a["active"]]
        if loses_owner and len(active_owners) == 1:
            return self._err(409, "last_owner", "This is the last active owner. Make someone else an owner first.")
        self.store.put_auth_row("users", updated["id"], updated)
        return 200, {"a2app": True, **account_wire(updated)}

    # -- credentials (spec §2, §8) -------------------------------------------
    # Parity oracle: adapters/adapter-core/src/credentials.ts.
    #
    #   GET /api/_a2app/credentials          a manager's own (an owner: everyone's)
    #   POST /api/_a2app/credentials         issue one; the token is in this reply only
    #   DELETE /api/_a2app/credentials/{id}  revoke (a manager, or the credential itself)

    def _live_grant(self, g: dict) -> bool:
        """Still able to make a request: not revoked, not expired, its task not over."""
        if g["admin"] or g["revokedAt"] is not None:
            return False
        if g["expiresAt"] is not None and _ms(g["expiresAt"]) <= self.now_ms():
            return False
        if g["task"] is not None:
            task = self.store.get_task(g["task"])
            if task is None or task["status"] in TERMINAL_TASK:
                return False
        return True

    def _principal_name(self, principal: str) -> Optional[str]:
        info = self._principal_info(principal)
        return info["name"] if info else None

    def _handle_credentials(self, method, headers, body, path):
        if path == "/api/_a2app/credentials":
            if method == "GET":
                return self._list_credentials(headers)
            if method == "POST":
                return self._issue_credential(headers, body)
            return self._err(405, "usage", f"{method} not allowed on credentials.")
        if method != "DELETE":
            return self._err(405, "usage", "A credential is revoked with DELETE.")
        return self._revoke_credential(headers, unquote(path[len("/api/_a2app/credentials/"):]))

    def _list_credentials(self, headers):
        manager, reply = self._manager_of(headers, write=False)
        if reply:
            return reply
        mine = [
            g for g in self.store.list_grants()
            if self._live_grant(g) and (manager["role"] == "owner" or g["principal"] == manager["principal"])
        ]
        mine.sort(key=lambda g: g["createdAt"], reverse=True)
        return 200, {"a2app": True, "credentials": [credential_wire(g, self._principal_name(g["principal"])) for g in mine]}

    def _issue_credential(self, headers, body):
        manager, reply = self._manager_of(headers, write=True)
        if reply:
            return reply
        body = _as_object(body)
        principal = body.get("principal")
        if principal is None:
            principal = manager["principal"]
        if not isinstance(principal, str):
            return self._err(400, "usage", 'principal is an account id (or "owner").')
        if principal != manager["principal"] and manager["role"] != "owner":
            return self._err(403, "not_a_manager", "Only an owner can issue a credential for someone else.")
        info = self._principal_info(principal)
        if not info or not info["active"]:
            return self._err(400, "usage", f'"{principal}" is not an active account of this app.')
        agent_name, problem = parse_agent_name(body.get("agentName"))
        if problem:
            return self._err(400, "usage", problem)
        scopes, expires_in, problem = parse_grant_request(body, self._all_scopes())
        if problem:
            return self._err(400, "usage", problem)
        token, grant = mint_credential(self.store, self.now_ms(), principal, agent_name, scopes, expires_in)
        return 201, {"a2app": True, "token": token, "credential": credential_wire(grant, info["name"])}

    def _revoke_credential(self, headers, credential_id):
        grant = self.store.grant_by_id(credential_id)
        if grant is None:
            return self._err(404, "not_found", f'No credential "{credential_id}".')
        if grant["admin"]:
            return self._err(403, "not_a_manager", "The admin credential is the app's .agent-token: rotate that file instead.")
        # A credential may always revoke itself -- the one thing an agent may do
        # with credentials -- so an agent can hand back access it no longer needs.
        presented = self._credential_of(headers)
        if not (presented and "grant" in presented and presented["grant"]["credentialId"] == credential_id):
            manager, reply = self._manager_of(headers, write=True)
            if reply:
                return reply
            if manager["role"] != "owner" and grant["principal"] != manager["principal"]:
                return self._err(404, "not_found", f'No credential "{credential_id}".')
        if grant["revokedAt"] is None:
            self.store.put_grant({**grant, "revokedAt": _iso(self.now_ms())})
        return 200, {"a2app": True, "ok": True, "revoked": credential_id}

    # -- device-code sign-in (spec §7, RFC 8628 shape) -------------------------
    # Parity oracle: adapters/adapter-core/src/device.ts.
    #
    #   POST /api/_a2app/auth/device               an agent asks; gets a code to show
    #   GET  /api/_a2app/auth/device/{userCode}     the person reviews (a manager)
    #   POST /api/_a2app/auth/device/{userCode}     the person approves or denies
    #   POST /api/_a2app/auth/token                 the agent polls; gets its credential
    #
    # The person approves on the app's own account page, signed in as
    # themselves; the credential issued acts for them, with the scopes they
    # approved. No password or session ever reaches the agent. Codes live 10
    # minutes, are single use, and the device code is stored only as its hash.

    def _handle_device(self, method, headers, body, path):
        """Route one request under /api/_a2app/auth/, or None."""
        if path == "/api/_a2app/auth/device":
            return self._device_start(headers, body) if method == "POST" else self._err(405, "usage", "Start a sign-in with POST.")
        if path == "/api/_a2app/auth/token":
            return self._device_poll(body) if method == "POST" else self._err(405, "usage", "Poll with POST.")
        if path.startswith("/api/_a2app/auth/device/"):
            code = unquote(path[len("/api/_a2app/auth/device/"):])
            if method == "GET":
                return self._device_review(headers, code)
            if method == "POST":
                return self._device_decide(headers, body, code)
            return self._err(405, "usage", f"{method} not allowed on a sign-in request.")
        return None

    def _live_devices(self) -> list[tuple[str, dict]]:
        """Live rows by key, dropping the expired as it goes."""
        t = self.now_ms()
        rows = self.store.auth_rows("devices")
        for key, row in rows:
            if _ms(row["expiresAt"]) <= t:
                self.store.delete_auth_row("devices", key)
        return [(key, row) for key, row in rows if _ms(row["expiresAt"]) > t]

    def _device_by_user_code(self, value: str) -> Optional[tuple[str, dict]]:
        code = normalize_user_code(value)
        if code == "":
            return None
        return next(((k, r) for k, r in self._live_devices() if r["userCode"] == code and r["status"] == "pending"), None)

    def _device_start(self, headers, body):
        body = _as_object(body)
        scopes, expires_in, problem = parse_grant_request(body, self._all_scopes())
        if problem:
            return self._err(400, "usage", problem)
        agent_name = body.get("agentName")
        if "agentName" in body and (not isinstance(agent_name, str) or agent_name.strip() == "" or len(agent_name) > 100):
            return self._err(400, "usage", "agentName is 1–100 characters.")
        taken = {row["userCode"] for _, row in self._live_devices()}
        user_code = new_user_code()
        while user_code in taken:
            user_code = new_user_code()
        device_code = new_secret()
        t = self.now_ms()
        self.store.put_auth_row("devices", hash_secret(device_code), {
            "userCode": user_code,
            "agentName": agent_name.strip() if isinstance(agent_name, str) else None,
            "scopes": scopes,  # what the agent asked for
            "expiresInSeconds": expires_in,  # the issued credential's lifetime
            "createdAt": _iso(t),
            "expiresAt": _iso(t + CODE_TTL_SECONDS * 1000),  # when the codes stop working
            "interval": POLL_INTERVAL_SECONDS,
            "lastPolledAt": None,
            "status": "pending",
            "approvedBy": None,
            "approvedScopes": None,
        })
        approve = f"{self._public_origin(headers)}{ACCOUNT_URL}#approve"
        return 200, {
            "a2app": True, "deviceCode": device_code, "userCode": user_code,
            "verificationUri": approve, "verificationUriComplete": f"{approve}/{user_code}",
            "expiresIn": CODE_TTL_SECONDS, "interval": POLL_INTERVAL_SECONDS,
        }

    def _device_poll(self, body):
        device_code = _as_object(body).get("deviceCode")
        if not isinstance(device_code, str):
            return self._err(400, "usage", "Poll with { deviceCode }.")
        key = hash_secret(device_code)
        row = self.store.auth_row("devices", key)
        t = self.now_ms()
        if row is None or _ms(row["expiresAt"]) <= t:
            if row is not None:
                self.store.delete_auth_row("devices", key)
            return self._err(400, "expired_token", "This sign-in request expired or was already used. Start again.")
        if row["status"] == "denied":
            self.store.delete_auth_row("devices", key)
            return self._err(400, "access_denied", "The person declined this agent's request.")
        if row["status"] == "approved" and row["approvedBy"] is not None and row["approvedScopes"] is not None:
            # Single use: the row goes before the credential is handed out.
            self.store.delete_auth_row("devices", key)
            info = self._principal_info(row["approvedBy"])
            if not info or not info["active"]:
                return self._err(400, "access_denied", "The person who approved this is no longer active.")
            token, grant = mint_credential(
                self.store, self.now_ms(), row["approvedBy"], row["agentName"], row["approvedScopes"], row["expiresInSeconds"],
            )
            return 200, {"a2app": True, "token": token, "credential": credential_wire(grant, info["name"])}
        if row["lastPolledAt"] is not None and t - row["lastPolledAt"] < row["interval"] * 1000:
            interval = row["interval"] + SLOW_DOWN_STEP_SECONDS
            self.store.put_auth_row("devices", key, {**row, "interval": interval, "lastPolledAt": t})
            return self._err(400, "slow_down", f"Polling too fast: wait {interval} s between polls.", interval=interval)
        self.store.put_auth_row("devices", key, {**row, "lastPolledAt": t})
        return self._err(400, "authorization_pending", "Waiting for the person to approve.", interval=row["interval"])

    def _device_review(self, headers, user_code):
        manager, reply = self._manager_of(headers, write=False)
        if reply:
            return reply
        found = self._device_by_user_code(user_code)
        if found is None:
            return self._err(404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.")
        row = found[1]
        return 200, {
            "a2app": True, "userCode": row["userCode"], "agentName": row["agentName"], "scopes": row["scopes"],
            "expiresIn": row["expiresInSeconds"], "expiresAt": row["expiresAt"],
        }

    def _device_decide(self, headers, body, user_code):
        manager, reply = self._manager_of(headers, write=True)
        if reply:
            return reply
        found = self._device_by_user_code(user_code)
        if found is None:
            return self._err(404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.")
        key, row = found
        body = _as_object(body)
        if not isinstance(body.get("approve"), bool):
            return self._err(400, "usage", "Decide with { approve: true | false }.")
        if not body["approve"]:
            self.store.put_auth_row("devices", key, {**row, "status": "denied"})
            return 200, {"a2app": True, "ok": True, "status": "denied"}
        # The person may only narrow what was asked for.
        scopes = row["scopes"]
        if "scopes" in body:
            narrowed, _, problem = parse_grant_request({"scopes": body["scopes"]}, self._all_scopes())
            if problem:
                return self._err(400, "usage", problem)
            asked = None if "*" in row["scopes"] else set(row["scopes"])
            wider = [] if asked is None else [s for s in narrowed if s == "*" or s not in asked]
            if wider:
                return self._err(400, "usage", f"Approval can only narrow what the agent asked for, not add {', '.join(wider)}.")
            scopes = narrowed
        self.store.put_auth_row("devices", key, {**row, "status": "approved", "approvedBy": manager["principal"], "approvedScopes": scopes})
        return 200, {"a2app": True, "ok": True, "status": "approved"}

    # -- app -> agent -------------------------------------------------------
    def trigger(
        self, etype: str, payload: dict, capability: Optional[str] = None, principal: Optional[str] = None,
    ) -> dict:
        """Emit a declared event and, with a capability, queue a task. Work the
        app queues on its own has no `principal` and runs as the owner."""
        with self._lock:
            return self.store.trigger(etype, payload, capability, principal=principal)


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

    # 4. Referential deletes: the rule an app declares with a `ref` binds the
    #    generic record route, not just whatever operation the app wrote. This
    #    checks the scan itself -- the thing a delete consults before it commits.
    class _FakeStore:
        def __init__(self, rows):
            self.rows = rows

        def list_records(self, entity, query):
            items = list(self.rows.get(entity, {}).values())
            per_page = int(query.get("perPage") or len(items) or 1)
            page = int(query.get("page") or 1)
            start = (page - 1) * per_page
            return {"items": items[start:start + per_page], "totalItems": len(items)}

    class _FakeAdapter:
        _references_to = Adapter._references_to

        def __init__(self, entity_defs, store):
            self.entity_defs = entity_defs
            self.store = store

    invoice_fields = [
        {"name": "client", "type": "ref", "entity": "clients"},
        {"name": "projects", "type": "list<ref>", "entity": "projects"},
    ]
    defs = {
        "clients": {"fields": [{"name": "name", "type": "string"}], "module": "sales"},
        "projects": {"fields": [{"name": "title", "type": "string"}], "module": "sales"},
        "invoices": {"fields": invoice_fields, "module": "sales"},
    }
    store = _FakeStore({
        "clients": {"c_acme": {"id": "c_acme"}, "c_unused": {"id": "c_unused"}},
        "projects": {"p_one": {"id": "p_one"}},
        "invoices": {"inv_1": {"id": "inv_1", "client": "c_acme", "projects": ["p_one"]}},
    })
    ad = _FakeAdapter(defs, store)

    check(
        "a referenced record reports who blocks it",
        ad._references_to("clients", "c_acme"),
        [{"entity": "invoices", "field": "client", "ids": ["inv_1"]}],
    )
    check("an unreferenced record blocks nothing", ad._references_to("clients", "c_unused"), [])
    check(
        "a reference held in a list counts too",
        ad._references_to("projects", "p_one"),
        [{"entity": "invoices", "field": "projects", "ids": ["inv_1"]}],
    )

    # The opt-out is per field, and it is the only way to allow orphaning.
    ignoring = {**defs, "invoices": {"fields": [
        {"name": "client", "type": "ref", "entity": "clients", "onDelete": "ignore"},
        invoice_fields[1],
    ], "module": "sales"}}
    check(
        'onDelete "ignore" removes the block',
        _FakeAdapter(ignoring, store)._references_to("clients", "c_acme"),
        [],
    )
    check(
        "and leaves the other ref guarded",
        _FakeAdapter(ignoring, store)._references_to("projects", "p_one"),
        [{"entity": "invoices", "field": "projects", "ids": ["inv_1"]}],
    )

    # 5. Filter grammar: filtered reads filter, and anything outside the
    #    grammar is refused, never ignored.
    flt_store = Store()
    flt_store.put_record("tasks", {"id": "a", "title": "Ship it", "status": "todo"})
    flt_store.put_record("tasks", {"id": "b", "title": "Other work", "status": "done"})
    check(
        "filter: equality",
        [r["id"] for r in flt_store.list_records("tasks", {"filter": 'status = "todo"'})["items"]],
        ["a"],
    )
    check(
        "filter: negation",
        [r["id"] for r in flt_store.list_records("tasks", {"filter": 'status != "todo"'})["items"]],
        ["b"],
    )
    check(
        "filter: contains",
        [r["id"] for r in flt_store.list_records("tasks", {"filter": 'title ~ "Ship"'})["items"]],
        ["a"],
    )
    try:
        flt_store.list_records("tasks", {"filter": 'status = "todo" && title ~ "x"'})
        failures.append("an unsupported filter expression was silently accepted")
    except UnsupportedFilter:
        pass

    # 6. SQLite store: durable records + idempotency keys, and seed-once
    #    semantics across a restart (reopening the same file).
    import shutil
    import tempfile

    tmp = tempfile.mkdtemp(prefix="a2app-selftest-")
    try:
        db_path = os.path.join(tmp, "data", "db.sqlite")
        first = SqliteStore(db_path)
        check("a fresh database file wants the seed", first.wants_seed, True)
        first.put_record("tasks", {"id": "t1", "title": "persisted", "status": "todo"})
        first.idem_put("tasks", "key-1", "t1")
        _, kept = mint_credential(first, 0, "owner", None, ["*"], 3600)
        first.put_auth_row("users", "usr_x", {"id": "usr_x", "name": "X"})
        check("sqlite get returns what was put", first.get_record("tasks", "t1")["title"], "persisted")
        check(
            "sqlite list flows through the shared filter/sort/page",
            [r["id"] for r in first.list_records("tasks", {"filter": 'status = "todo"'})["items"]],
            ["t1"],
        )
        first.close()

        second = SqliteStore(db_path)
        check("an existing database refuses the seed", second.wants_seed, False)
        check("records survive a restart", second.get_record("tasks", "t1")["title"], "persisted")
        check("idempotency keys survive a restart", second.idem_get("tasks", "key-1"), "t1")
        check("credentials survive a restart, found by their token's hash", second.grant_by_token_hash(kept["tokenHash"]), kept)
        check("…and so do accounts", second.auth_rows("users"), [("usr_x", {"id": "usr_x", "name": "X"})])
        second.delete_grant(kept["credentialId"])
        check("a deleted credential is gone", [second.grant_by_id(kept["credentialId"]), second.list_grants()], [None, []])
        check("delete removes the row", second.delete_record("tasks", "t1"), True)
        check("a second delete reports not-found", second.delete_record("tasks", "t1"), False)
        second.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 7. The app->agent queue: declared types, one task per occurrence, and the
    #    sweeper that returns an abandoned claim. Whatever delivers this queue to
    #    an agent (`agent-app <dir> bridge`) relies on all three.
    q_store = Store()
    q = Adapter(
        app_id="selftest", app_name="selftest",
        entities={"tasks": {"fields": fields, "module": "planning"}}, operations=[],
        store=q_store, token="tok_selftest", modules=[{"name": "planning"}],
        events=[{"type": "task.needs_triage"}],
    )
    try:
        q_store.trigger("task.undeclared", {"task": "t1"}, "triage")
        failures.append("an undeclared event type was emitted")
    except ValueError:
        pass
    fired = q_store.trigger("task.needs_triage", {"task": "t1"}, "triage")
    check("a trigger with a capability queues a task", fired["taskId"] is not None, True)
    check(
        "the same occurrence makes one task",
        q_store.trigger("task.needs_triage", {"task": "t1"}, "triage")["taskId"],
        fired["taskId"],
    )
    check(
        "a different occurrence makes another",
        q_store.trigger("task.needs_triage", {"task": "t2"}, "triage")["taskId"] != fired["taskId"],
        True,
    )
    check("an event with no capability queues nothing", q_store.trigger("task.needs_triage", {"task": "t3"})["taskId"], None)

    agent = {"x-a2app-token": "tok_selftest"}
    tid = fired["taskId"]
    check("claim takes a submitted task", q.dispatch("POST", f"/api/_a2app/tasks/{tid}/claim", agent, {})[1]["status"], "working")
    q_store.tasks[tid]["updatedAt"] = "2000-01-01T00:00:00.000Z"
    check(
        "the sweeper returns an abandoned claim to the queue",
        q.dispatch("GET", f"/api/_a2app/tasks/{tid}", agent, None)[1]["status"],
        "submitted",
    )
    check(
        "a late completion from the abandoned run is refused",
        q.dispatch("POST", f"/api/_a2app/tasks/{tid}/complete", agent, {"status": "completed"})[0],
        409,
    )
    for _ in range(TASK_MAX_DELIVERIES):
        q.dispatch("POST", f"/api/_a2app/tasks/{tid}/claim", agent, {})
        q_store.tasks[tid]["updatedAt"] = "2000-01-01T00:00:00.000Z"
        q.dispatch("GET", f"/api/_a2app/tasks/{tid}", agent, None)
    swept = q_store.tasks[tid]
    check("redelivery is bounded", (swept["status"], swept["reason"]), ("failed", "redelivery_exhausted"))

    # Host and network policy: the app answers only to loopback and its own
    # origins (the public URL among them), and refuses to listen where the
    # agent token would cross a network in clear.
    hosted = Adapter(
        app_id="selftest", app_name=None, entities={}, operations=[], store=Store(), token="t",
        modules=[{"name": "core"}], allowed_origins=["http://127.0.0.1:9931"], public_url="https://crm.example.com",
    )
    check("the public host is answered", hosted._is_allowed_host("crm.example.com"), True)
    check("…with an explicit port", hosted._is_allowed_host("crm.example.com:443"), True)
    check("loopback is answered", hosted._is_allowed_host("127.0.0.2:9931"), True)
    check("an IPv6 loopback literal is answered", hosted._is_allowed_host("[::1]:9931"), True)
    check("a rebound host is refused", hosted._is_allowed_host("evil.example.com"), False)
    check("a lookalike host is refused", hosted._is_allowed_host("localhost.evil.example.com"), False)
    check("dispatch refuses a foreign host before identity", hosted.dispatch("GET", "/api/_a2app", {"Host": "evil.example.com"}, None)[0], 403)
    check("the public origin is the app's own", "https://crm.example.com" in hosted.allowed_origins, True)

    def policy(host: Optional[str], public: Optional[str]) -> Any:
        try:
            return network_policy(host, public)
        except ValueError:
            return "refused"

    check("loopback by default", policy(None, None), ("127.0.0.1", None))
    check("an https public URL is reduced to its origin", policy(None, "https://CRM.example.com/x"), ("127.0.0.1", "https://crm.example.com"))
    check("a non-loopback bind needs a public URL", policy("0.0.0.0", None), "refused")
    check("…an https one", policy("0.0.0.0", "http://localhost:8080"), "refused")
    check("a non-loopback bind behind https is allowed", policy("0.0.0.0", "https://crm.example.com"), ("0.0.0.0", "https://crm.example.com"))
    check("a plain-http public name is refused", policy(None, "http://crm.example.com"), "refused")
    check("a plain-http tunnel to loopback is allowed", policy(None, "http://localhost:9000"), ("127.0.0.1", "http://localhost:9000"))
    check("a public URL that is not a URL is refused", policy(None, "crm.example.com"), "refused")

    # 8. Auth primitives (spec/v0_2/auth.md). Parity oracle: adapter-core's
    #    auth.ts. This hash was made by its hashPassword("correct horse battery
    #    staple", 1000), so a stored hash verifies the same on either stack.
    vector = "pbkdf2_sha256$1000$Fwx0pyFB/cKse2VOB4hrkA==$n9kBbND5w7l0anXD+de9OXQhh1wnyQhn3oXWO+CuNkI="
    check("an adapter-core password hash verifies", verify_password("correct horse battery staple", vector), True)
    check("…and refuses another password", verify_password("correct horse battery stapler", vector), False)
    made = hash_password("a long enough password")
    check(
        "a new hash is pbkdf2_sha256 at 600 000, 16-byte salt, 32-byte key",
        re.fullmatch(r"pbkdf2_sha256\$600000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=", made) is not None,
        True,
    )
    check("…and round-trips", verify_password("a long enough password", made), True)
    check(
        "a malformed hash never matches",
        [verify_password("x", h) for h in ("", "md5$1$AA==$AA==", "pbkdf2_sha256$0$AA==$AA==", "pbkdf2_sha256$1$AA==$", "pbkdf2_sha256$1$A$A")],
        [False] * 5,
    )
    check("a token is a2a_ + 256 bits, base64url", re.fullmatch(r"a2a_[A-Za-z0-9_-]{43}", new_token()) is not None, True)
    check("a secret is kept as its hex SHA-256", hash_secret("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    check(
        "a user code is XXXX-XXXX in consonants",
        re.fullmatch(r"[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}", new_user_code()) is not None,
        True,
    )
    check("a typed user code ignores case, spaces and the dash", normalize_user_code("bcdf ghjk"), "BCDF-GHJK")
    check("…and is nothing without exactly eight letters", [normalize_user_code("BCDFGHJ"), normalize_user_code("ab cd ef gh jk lm")], ["", ""])
    check("a login is trimmed and lower-cased", normalize_login("  Alice@Example.COM "), "alice@example.com")
    check(
        "cookies: the first of a name wins, values decode, malformed ones drop",
        parse_cookies("a=1; b=x%20y; a=2; bad=%zz; c"),
        {"a": "1", "b": "x y"},
    )
    check(
        "the session cookie: HttpOnly, SameSite=Lax, on /, Secure behind https",
        session_cookie("a2app_session_x", "v/1", 10, True),
        "a2app_session_x=v%2F1; Path=/; HttpOnly; SameSite=Lax; Max-Age=10; Secure",
    )
    tick = [0]
    failing = FailureLimiter(2, 60_000, lambda: tick[0])
    failing.fail("bob")
    check("one failure does not lock a login", failing.retry_after("bob"), 0)
    failing.fail("bob")
    tick[0] = 1_500
    check("the limit locks it for the rest of the window", failing.retry_after("bob"), 59)
    tick[0] = 60_000
    check("…and the window passing frees it", failing.retry_after("bob"), 0)
    check("a grant asks for declared scopes", parse_grant_request({"scopes": ["data:x:read"]}, {"data:x:read"}), (["data:x:read"], DEFAULT_EXPIRES_SECONDS, None))
    check("…never an undeclared one", parse_grant_request({"scopes": ["op:nope"]}, set())[2], "Not scopes this app declares: op:nope.")
    check("…and always expires, within bounds", [parse_grant_request({"expiresIn": n}, set())[2] is None for n in (60, 3600.0, 59, True)], [True, True, False, False])

    # 9. The ceiling, ownership, accounts, device sign-in and task credentials,
    #    end to end through dispatch on a multi-user adapter with a fixed clock.
    clock = [_ms("2026-10-28T09:00:00.000Z")]
    origin = "http://127.0.0.1:9931"
    notes = {
        "notes": {
            "module": "core",
            "fields": [{"name": "title", "type": "string"}, {"name": "owner", "type": "string", "readOnly": True}],
            "ownedBy": "owner",
        },
    }
    mu_store = Store()
    mu = Adapter(
        app_id="selftest", app_name="Selftest", entities=notes, operations=[], store=mu_store, token="tok_admin",
        modules=[{"name": "core"}], allowed_origins=[origin], events=[{"type": "note.triage"}], auth_mode="multi-user",
        capabilities={"triage": {"scopes": ["data:notes:read"]}}, clock=lambda: clock[0],
        # Members may read only; the owner anything.
        permissions_of=lambda p: ["*"] if p["role"] == "owner" else ["data:notes:read"],
    )
    for uid, name, role in (("usr_alice", "Alice", "owner"), ("usr_bob", "Bob", "member")):
        mu_store.put_auth_row("users", uid, {
            "id": uid, "name": name, "login": name.lower(), "role": role, "active": True,
            "createdAt": _iso(clock[0]), "passwordHash": vector,
        })

    def call(method, path, as_=None, body=None, **headers):
        h = dict(headers)
        if isinstance(as_, str):
            h["x-a2app-token"] = as_
        elif isinstance(as_, dict):
            h.update(as_)
        return mu.dispatch(method, path, h, body)

    admin = "tok_admin"
    check("identity speaks 0.2 and names the account page", [mu.identity()[k] for k in ("protocol", "authMode", "accountUrl")], ["0.2", "multi-user", ACCOUNT_URL])
    check("the admin token is held only as its hash", mu_store.grant_by_id(ADMIN_CREDENTIAL_ID)["tokenHash"], hash_secret(admin))
    check("a stranger is told to present a credential", call("GET", "/api/collections/notes/records")[1]["code"], "agent_token_required")
    check("…or, from the app's own page, to sign in", call("GET", "/api/collections/notes/records", **{"sec-fetch-site": "same-origin"})[1]["code"], "sign_in_required")

    signed_in = call("POST", "/api/_a2app/session", body={"login": " Alice ", "password": "correct horse battery staple"}, origin=origin)
    alice = {"cookie": signed_in[2]["set-cookie"].split(";")[0], "origin": origin}
    check("signing in sets the session cookie", [signed_in[0], signed_in[1]["id"]], [200, "usr_alice"])
    check("the session says who is signed in", call("GET", "/api/_a2app/session", {"cookie": alice["cookie"]})[1]["id"], "usr_alice")
    check("a wrong password is refused", call("POST", "/api/_a2app/session", body={"login": "alice", "password": "nope nope nope"})[1]["code"], "sign_in_failed")
    check("a signed-in change needs the app's own Origin", call("POST", "/api/collections/notes/records", {"cookie": alice["cookie"]}, {"title": "x"})[1]["code"], "forbidden_origin")
    alices = call("POST", "/api/collections/notes/records", alice, {"title": "Alice's"})[1]
    check("the adapter fills the owner", alices.get("owner"), "usr_alice")
    check("…and a client cannot", call("POST", "/api/collections/notes/records", alice, {"title": "x", "owner": "usr_bob"})[1]["code"], "read_only_field")

    bob_token, bob_grant = mint_credential(mu_store, clock[0], "usr_bob", "test agent", ["*"], 3600)
    who = call("GET", "/api/_a2app/whoami", bob_token)[1]
    check("a `*` credential is held to its person's permissions", who["scopes"], ["data:notes:read"])
    check("…acting as them", [who["principal"], who["principalName"], who["role"], who["expiresAt"]], ["usr_bob", "Bob", "member", bob_grant["expiresAt"]])
    check("…and cannot write past them", call("POST", "/api/collections/notes/records", bob_token, {"title": "x"})[1]["code"], "insufficient_scope")
    check("a member does not see another's records", call("GET", "/api/collections/notes/records", bob_token)[1]["totalItems"], 0)
    check("…even by id", call("GET", f"/api/collections/notes/records/{alices['id']}", bob_token)[0], 404)
    check("an owner sees everyone's", call("GET", "/api/collections/notes/records", alice)[1]["totalItems"], 1)
    check("use is recorded", mu_store.grant_by_id(bob_grant["credentialId"])["lastUsedAt"], _iso(clock[0]))
    check("an agent's credential manages nothing", call("GET", "/api/_a2app/credentials", bob_token)[1]["code"], "not_a_manager")
    check("an unknown token is refused", call("GET", "/api/_a2app/whoami", "a2a_nope")[1]["code"], "credential_invalid")
    call("PATCH", "/api/_a2app/users/usr_bob", alice, {"active": False})
    check("deactivating a person stops their agents", call("GET", "/api/_a2app/whoami", bob_token)[1]["code"], "principal_inactive")
    call("PATCH", "/api/_a2app/users/usr_bob", alice, {"active": True})
    check("the last active owner stays one", call("PATCH", "/api/_a2app/users/usr_alice", alice, {"role": "member"})[1]["code"], "last_owner")
    check("a credential may revoke itself", call("DELETE", f"/api/_a2app/credentials/{bob_grant['credentialId']}", bob_token)[0], 200)
    check("…and then says so", call("GET", "/api/_a2app/whoami", bob_token)[1]["code"], "credential_revoked")
    short_token, _ = mint_credential(mu_store, clock[0], "usr_alice", None, ["*"], 60)
    clock[0] += 60_000
    check("an expired credential says so", call("GET", "/api/_a2app/whoami", short_token)[1]["code"], "token_expired")

    started = call("POST", "/api/_a2app/auth/device", body={"agentName": "cli", "scopes": ["data:notes:read", "data:notes:write"]})[1]
    poll = lambda: call("POST", "/api/_a2app/auth/token", body={"deviceCode": started["deviceCode"]})[1]  # noqa: E731
    check("device sign-in links to the approve screen", started["verificationUriComplete"], f"http://127.0.0.1:9931{ACCOUNT_URL}#approve/{started['userCode']}")
    check("polling waits for the person", poll()["code"], "authorization_pending")
    check("…and slows a poll that comes too soon", poll()["interval"], POLL_INTERVAL_SECONDS + SLOW_DOWN_STEP_SECONDS)
    check(
        "approval can only narrow",
        call("POST", f"/api/_a2app/auth/device/{started['userCode'].lower()}", alice, {"approve": True, "scopes": ["*"]})[1]["code"],
        "usage",
    )
    call("POST", f"/api/_a2app/auth/device/{started['userCode']}", alice, {"approve": True, "scopes": ["data:notes:read"]})
    clock[0] += 11_000
    issued = poll()
    check("the agent gets a credential for the approver, as approved", [issued["credential"]["principal"], issued["credential"]["scopes"]], ["usr_alice", ["data:notes:read"]])
    check("…once", poll()["code"], "expired_token")

    queued = mu.trigger("note.triage", {"note": alices["id"]}, "triage", principal="usr_bob")["taskId"]
    check("a task records who queued it", call("GET", f"/api/_a2app/tasks/{queued}", admin)[1]["request"]["principal"], "usr_bob")
    task_cred = call("POST", f"/api/_a2app/tasks/{queued}/credential", admin, {"agentName": "bridge"})
    check(
        "a task credential: that person, the capability's scopes, one hour, that task",
        [task_cred[0], task_cred[1]["credential"]["principal"], task_cred[1]["credential"]["scopes"],
         task_cred[1]["credential"]["expiresAt"], task_cred[1]["credential"]["task"]],
        [201, "usr_bob", ["data:notes:read"], _iso(clock[0] + 3_600_000), queued],
    )
    call("POST", f"/api/_a2app/tasks/{queued}/claim", admin, {})
    call("POST", f"/api/_a2app/tasks/{queued}/complete", task_cred[1]["token"], {"status": "completed"})
    check("…dead once its task ends", call("GET", "/api/_a2app/whoami", task_cred[1]["token"])[1]["code"], "credential_revoked")
    check("…and none is issued for a finished task", call("POST", f"/api/_a2app/tasks/{queued}/credential", admin)[1]["code"], "task_not_claimable")

    def refused(**kwargs) -> Optional[str]:
        try:
            Adapter(app_id="x", app_name=None, operations=[], store=Store(), token="t", modules=[{"name": "core"}], **kwargs)
        except ValueError as e:
            return str(e)
        return None

    owned_by = lambda field: {"notes": {**notes["notes"], "ownedBy": field}}  # noqa: E731
    check("ownedBy must name a field", "not one of its fields" in (refused(entities=owned_by("author")) or ""), True)
    check("…a readOnly string one", "readOnly string field" in (refused(entities=owned_by("title")) or ""), True)
    check("a capability may not need undeclared scopes", "does not declare: op:nope" in (refused(entities=notes, capabilities={"t": {"scopes": ["op:nope"]}}) or ""), True)

    # On authMode none: one principal, no accounts, nothing filtered.
    single = Adapter(
        app_id="selftest", app_name=None, entities=notes, operations=[], store=Store(), token="tok_admin",
        modules=[{"name": "core"}], allowed_origins=[origin],
    )
    check("accounts exist only on multi-user apps", single.dispatch("GET", "/api/_a2app/session", {}, None)[1]["code"], "not_multi_user")
    check("the app's own View writes as the owner", single.dispatch("POST", "/api/collections/notes/records", {"origin": origin}, {"title": "x"})[1]["owner"], "owner")
    check("…and reads with no credential", single.dispatch("GET", "/api/_a2app/whoami", {"sec-fetch-site": "same-origin"}, None)[1]["credentialId"], "ui")
    check("an anonymous read is told it may only read", single.dispatch("GET", "/api/_a2app/whoami", {}, None)[1]["scopes"], ["data:notes:read"])
    if failures:
        print("a2app_adapter selftest FAILED:\n  - " + "\n  - ".join(failures))
        return 1
    print(
        "a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store, "
        "task queue, host and network policy, auth primitives, ceiling, ownership, accounts, device sign-in, "
        "task credentials)"
    )
    return 0


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    print("a2app_adapter is a library; run main.py to serve. Use --selftest to check rules parity.")
