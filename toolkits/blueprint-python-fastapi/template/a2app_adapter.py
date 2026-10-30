"""A2App adapter (SYSTEM-OWNED — hash-locked in the ownership canon).

A dependency-free port of the A2App served surface: identity, describe, whoami,
context, guarded records CRUD, declared operations (with approval for
destructive ops), the app->agent task/event plane, and the 0.2 auth layer
(spec/v0_2/auth.md): accounts, sessions and invites on a multi-user app,
delegated agent credentials held only as hashes, device-code sign-in, task
credentials, and the user ceiling on every request. It enforces the fixed
validation chain: origin -> credential -> scope -> guard -> backend -> read-back.
Records, and the adapter's own state (credentials, accounts, tasks, events,
approvals, idempotency keys, the audit log), persist in SQLite (stdlib
``sqlite3`` -- see ``SqliteStore``), so the stack stays dependency-free while
the live database is a real on-disk file inside the toolkit's declared
lifecycle dataDir.

The pure validation rules below MUST match `@a2app/rules` so a FastAPI app and a
Node app reject identical payloads identically — verified by the conformance
suite. The served surface is a port of `@a2app/adapter-core`, which is the
parity oracle for every status, code and shape. FastAPI wiring lives in
`main.py`; this file never imports FastAPI. An agent evolves the app by editing
`schema.py`, never this file.
"""
from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import formatdate, parsedate_to_datetime
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
    "MISSING_REQUIRED": "missing_required",
    "NOT_STORED": "not_stored",
    "DUPLICATE_REQUEST": "duplicate_request",
    "APPROVAL_REQUIRED": "approval_required",
    "INSUFFICIENT_SCOPE": "insufficient_scope",
    "AMBIGUOUS_REF": "ambiguous_ref",
    "INVALID_FILTER": "invalid_filter",
    "INVALID_EVENT": "invalid_event",
    "TASK_NOT_FOUND": "task_not_found",
    "TASK_NOT_CLAIMABLE": "task_not_claimable",
    "TASK_CANCELED": "task_canceled",
    # Progress or completion on a task whose claim another credential holds (auth §6.3).
    "TASK_NOT_HELD": "task_not_held",
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
# A task that has not reached a terminal state: the one a repeated request joins.
OPEN_TASK = {"submitted", "working", "input-required"}

# The adapter's own state is bounded and expires like adapter-core's store: an
# idempotency key is honoured for at least 24 hours, an approval key for 10
# minutes, and the event log and the audit log are rings of 5000 (the oldest
# rows fall off; the event sequence keeps counting, so a cursor stays valid).
IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
APPROVAL_TTL_MS = 10 * 60 * 1000
EVENT_RETENTION = 5000
AUDIT_RETENTION = 5000

# Connected viewers (a count, never identities): a heartbeat lives a minute, and
# the table is pruned once it holds more than this many ids.
VIEWER_TTL_MS = 60_000
VIEWER_CAP = 1_000

# Path prefixes the adapter owns outright. A miss inside them is the adapter's
# 404; any other path is the host app's (main.py's account page, or a route the
# app adds). Keep in step with `_route`.
ADAPTER_NAMESPACES = ("/api/_a2app", "/api/ops", "/api/collections")
IDENTITY_PATHS = ("/.well-known/a2app.json", "/api/_a2app")
# A miss is usually a guessed route, so it names the routes that answer.
UNKNOWN_ROUTE_MESSAGE = (
    "No such route. Operations are invoked with POST /api/ops/<name>; GET /api/_a2app/describe lists them."
)

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
# Approving hands nothing over by itself: it issues a confirmation code, and
# the credential goes only to a poll that presents it. A request survives this
# many wrong codes. An agent on the person's own computer waits for the code on
# a loopback port (RFC 8252), at this path.
CONFIRM_ATTEMPTS = 5
LOOPBACK_CALLBACK = "/a2app/callback"
LOOPBACK_PORT_MIN = 1024
LOOPBACK_PORT_MAX = 65535
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
# The default `how` on a `401 agent_token_required` (adapter-core's
# AGENT_TEXT.credentialHint), and the cap on an app's own hint: app text that
# reaches an agent is one line and at most this long (`bound_app_text`).
CREDENTIAL_HINT = "Read the app's .agent-token file (mode 0600) in the project directory."
APP_TEXT_MAX = 300

# ------------------------------------------------- JavaScript value semantics
#
# The rules are defined by a JavaScript reference, so where the answer depends
# on how a value reads in JavaScript -- a number written as text, the string
# form of a value, JSON text, the order strings sort in, a string's length --
# these give JavaScript's answer. Without them a Python app would accept "inf"
# as a number, compare 1.0 and "1" differently, and hash a different approval
# key for the same call.

# JavaScript's whitespace (`\s`, and what String.prototype.trim removes).
_JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_JS_TRIM = re.compile(f"^[{_JS_SPACE}]+|[{_JS_SPACE}]+$")
_JS_SPACES = re.compile(f"[{_JS_SPACE}]+")
# What Number(text) reads: a decimal literal or Infinity, or a 0x/0o/0b integer.
_JS_DECIMAL = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)\Z")
_JS_RADIX = re.compile(r"0([xXoObB])([0-9A-Za-z]+)\Z")
_SURROGATE = re.compile("[\ud800-\udfff]")


def js_trim(text: str) -> str:
    return _JS_TRIM.sub("", text)


def js_number(text: str) -> float:
    """`Number(text)`: NaN when the text is not a number."""
    s = js_trim(text)
    if s == "":
        return 0.0
    if _JS_DECIMAL.match(s):
        return float(s.replace("Infinity", "inf"))
    radix = _JS_RADIX.match(s)
    if radix:
        try:
            return float(int(radix.group(2), {"x": 16, "o": 8, "b": 2}[radix.group(1).lower()]))
        except ValueError:
            return math.nan
        except OverflowError:
            return math.inf
    return math.nan


def _js_value(n: float) -> Any:
    """A JavaScript number as Python holds it: an int when it is a whole number
    JavaScript would print without an exponent, so it serializes as JS does."""
    return int(n) if math.isfinite(n) and n == int(n) and abs(n) < 1e21 else n


def _is_number(value: Any) -> bool:
    """`typeof value === "number"`: a boolean is not a number."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def number_text(n: Any) -> str:
    """ECMAScript Number::toString -- the shortest round-trip form, which is
    also the number form RFC 8785 mandates."""
    try:
        f = float(n)
    except OverflowError:
        f = math.inf if n > 0 else -math.inf
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    if f == 0:
        return "0"
    sign = "-" if f < 0 else ""
    mantissa, _, exponent = repr(abs(f)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + int(exponent or 0)  # value = 0.<digits> x 10^point
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= point <= 21:
        return sign + digits + "0" * (point - k)
    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * -point + digits
    e = point - 1
    exp = ("+" if e >= 0 else "-") + str(abs(e))
    return sign + (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + exp


def js_string(value: Any) -> str:
    """`String(value)` for a JSON value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join("" if v is None else js_string(v) for v in value)
    return "[object Object]"


def _utf16(text: str) -> bytes:
    """`text` as UTF-16 code units: JavaScript sorts and compares strings by them."""
    return text.encode("utf-16-be", "surrogatepass")


def js_length(text: str) -> int:
    """`text.length`: UTF-16 code units, so an emoji counts two."""
    return len(_utf16(text)) // 2


def _json_string(text: str, escape_lone_surrogates: bool) -> str:
    out = json.dumps(text, ensure_ascii=False)
    # A surrogate in a Python str is always a lone one; JSON.stringify writes it
    # as an escape, RFC 8785 as itself.
    return _SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", out) if escape_lone_surrogates else out


def _json_text(value: Any, sort_keys: bool, canonical: bool) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            if canonical:
                raise ValueError("cannot canonicalize a non-finite number")
            return "null"
        return number_text(value)
    if isinstance(value, str):
        return _json_string(value, not canonical)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_json_text(v, sort_keys, canonical) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=_utf16) if sort_keys else list(value)
        return "{" + ",".join(
            _json_string(k, not canonical) + ":" + _json_text(value[k], sort_keys, canonical) for k in keys
        ) + "}"
    raise ValueError(f"cannot serialize a value of type {type(value).__name__}")


def js_stringify(value: Any) -> str:
    """`JSON.stringify(value)`: compact, keys in insertion order, JavaScript's
    number form, a non-finite number as null."""
    return _json_text(value, sort_keys=False, canonical=False)


def canonicalize(value: Any) -> str:
    """RFC 8785 (JSON Canonicalization Scheme) text: keys sorted by UTF-16 code
    unit, ECMAScript number form, minimal string escaping. Parity oracle:
    `canonicalize` in adapters/adapter-core/src/canon.ts."""
    return _json_text(value, sort_keys=True, canonical=True)


def _js_utf8(text: str) -> bytes:
    """`text` as JavaScript hashes it: a lone surrogate becomes U+FFFD."""
    return _SURROGATE.sub("\ufffd", text).encode("utf-8")


def approval_key(operation: str, args: Any) -> str:
    """The content-addressed approval key for one exact operation call: the
    hex SHA-256 of the canonical `{"operation", "args"}`. Two adapters that
    follow RFC 8785 compute the same key, so approving a call is portable, and
    approving one call approves no variant of it."""
    return hashlib.sha256(_js_utf8(canonicalize({"operation": operation, "args": {} if args is None else args}))).hexdigest()


def sha256_prefixed(text: str) -> str:
    return "sha256:" + hashlib.sha256(_js_utf8(text)).hexdigest()


def to_json(value: Any) -> str:
    """JSON text as JSON.stringify writes it, for a reply and for a stored row:
    a non-finite number is null, and a lone surrogate is escaped rather than
    unencodable. The C encoder serves every ordinary value."""
    try:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if not _SURROGATE.search(text):
            return text
    except ValueError:
        pass
    return js_stringify(value)


def decode_uri_component(text: str) -> str:
    """`decodeURIComponent`: a malformed escape is an error, not a pass-through."""
    if _BAD_ESCAPE.search(text):
        raise ValueError(f"URI malformed: {text}")
    return unquote(text, errors="strict")


_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")


def object_view(body: Any) -> dict:
    """A request body as JavaScript's Object.keys sees it: an object's own
    keys (array indices first, as a JavaScript object orders them), an array's
    or a string's indices, nothing for any other value. The guard reads every
    body this way, so `[]` is refused by the rules that refuse `{}`."""
    if isinstance(body, dict):
        index = sorted((k for k in body if _ARRAY_INDEX.fullmatch(k) and int(k) < 2**32 - 1), key=int)
        return {**{k: body[k] for k in index}, **body} if index else body
    if isinstance(body, (list, str)):
        return {str(i): v for i, v in enumerate(body)}
    return {}



def bound_app_text(value: Any, limit: int = APP_TEXT_MAX) -> Optional[str]:
    """App-supplied text forwarded into an agent's context, kept one line and
    at most `limit` characters, with a marker saying what was cut. None for
    absent or blank text. Parity oracle: `boundAppText` in agentText.ts."""
    if not isinstance(value, str):
        return None
    single = js_trim(_JS_SPACES.sub(" ", value))
    if single == "":
        return None
    if js_length(single) <= limit:
        return single
    suffix = ""
    for _ in range(3):
        suffix = f" [truncated by adapter, {js_length(single) - limit + js_length(suffix)} chars cut]"
    return single[: max(0, limit - js_length(suffix))] + suffix

# --------------------------------------------------------------- pure rules

_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
# ASCII digits and an end that is the end: Python's `\d` takes any script's
# digits and its `$` a trailing newline, and the reference takes neither.
_DATE_RE = re.compile(
    r"^([0-9]{4})-([0-9]{2})-([0-9]{2})([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?)?"
    f"[{_JS_SPACE}]*" r"(Z|[+-][0-9]{2}:?[0-9]{2})?\Z"
)
_DAY_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})\Z")


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
        if not scheme:
            raise ValueError(f'A2APP_PUBLIC_URL is not a URL: "{raw}".')
        if scheme not in ("http", "https"):
            raise ValueError(f'A2APP_PUBLIC_URL must be an http(s) URL, not "{raw}".')
        try:
            hostname, port = parts.hostname, parts.port
        except ValueError:
            hostname = None
        if not hostname:
            raise ValueError(f'A2APP_PUBLIC_URL is not a URL: "{raw}".')
        if scheme == "http" and not is_loopback_name(hostname):
            raise ValueError(
                f'A2APP_PUBLIC_URL must be https: "{raw}" would send the agent token across a network in clear. '
                "Put the app behind a TLS proxy, or reach it through an SSH tunnel to a loopback address."
            )
        # The URL's origin, as a browser sends it in Origin: no credentials, and
        # no port when it is the scheme's default.
        named = f"[{hostname}]" if ":" in hostname else hostname
        default_port = 443 if scheme == "https" else 80
        public = f"{scheme}://{named}" + (f":{port}" if port is not None and port != default_port else "")
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


def _join_values(values: list, separator: str) -> str:
    """`values.join(separator)`: each value's String() form, null as empty."""
    return separator.join("" if v is None else js_string(v) for v in values)


def validate(fields: list[dict], body: dict, allow: Optional[dict] = None, require_required: bool = False) -> list[dict]:
    """Validate a RAW body against normalized fields; returns every violation.

    `require_required` is set ONLY on a create (POST): a required field that is
    absent is then `missing_required` too. A required field sent blank is
    refused on any write -- clearing it would leave a record the schema says
    cannot exist. Parity oracle: `validate` in adapters/rules/src/index.ts.
    """
    allow = allow or {}
    by_name = {f["name"]: f for f in fields}
    writable = [f["name"] for f in fields if not f.get("readOnly")]
    # An operation may declare no parameters at all, and "one of: " with nothing
    # after it reads as a truncated message rather than as the answer it is.
    accepted = "one of: " + ", ".join(writable) if writable else "nothing — no writable fields are declared"
    out: list[dict] = []
    for key, value in body.items():
        if allow.get(key):
            continue
        f = by_name.get(key)
        if f is None:
            out.append(_violation(ERROR_CODES["UNKNOWN_FIELD"], key, accepted, value))
            continue
        if f.get("readOnly"):
            out.append(_violation(ERROR_CODES["READ_ONLY_FIELD"], key, "not writable (server-managed)", value))
            continue
        if _is_blank(value):
            if f.get("required"):
                out.append(_violation(ERROR_CODES["MISSING_REQUIRED"], key, "a non-blank value (required field)", value))
            continue
        ftype = f["type"]
        values = f.get("values")
        if ftype == "datetime" and not looks_like_date(value):
            out.append(_violation(ERROR_CODES["INVALID_DATE"], key, "an ISO 8601 date", value))
        elif f.get("dayKey") and not is_day_key_value(value):
            out.append(_violation(ERROR_CODES["INVALID_DAYKEY"], key, 'a day key "YYYY-MM-DD"', value))
        elif ftype == "string" and not isinstance(value, str):
            out.append(_violation(ERROR_CODES["INVALID_STRING"], key, "text", value))
        elif ftype == "string" and _is_number(f.get("max")) and js_length(value) > f["max"]:
            # `max` is published in describe, so a client plans against it.
            out.append(_violation(ERROR_CODES["INVALID_STRING"], key, f"text of at most {number_text(f['max'])} characters", value))
        elif ftype == "number" and not _is_number(value) and (
            not isinstance(value, str) or js_trim(value) == "" or math.isnan(js_number(value))
        ):
            out.append(_violation(ERROR_CODES["INVALID_NUMBER"], key, "a number", value))
        elif ftype == "boolean" and not isinstance(value, bool) and value not in ("true", "false"):
            out.append(_violation(ERROR_CODES["INVALID_BOOLEAN"], key, "true or false", value))
        elif ftype == "enum" and values and js_string(value) not in [js_string(v) for v in values]:
            out.append(_violation(ERROR_CODES["INVALID_ENUM"], key, "one of: " + _join_values(values, " | "), value))
        elif ftype == "list<enum>" and values:
            # The wire form of a list is an array: wrapping a bare scalar would
            # hide a client bug and make the stored shape depend on the count.
            if not isinstance(value, list):
                out.append(_violation(ERROR_CODES["INVALID_ENUM"], key, "an array of: " + _join_values(values, " | "), value))
            elif any(js_string(i) not in [js_string(v) for v in values] for i in value):
                out.append(_violation(ERROR_CODES["INVALID_ENUM"], key, "each of: " + _join_values(values, " | "), value))
    if require_required:
        # Only the create-specific case: a required field absent entirely. One
        # sent blank is already reported above.
        for f in fields:
            if f.get("required") and not f.get("readOnly") and f["name"] not in body:
                out.append(_violation(ERROR_CODES["MISSING_REQUIRED"], f["name"], "a non-blank value (required field)", None))
    return out


def divergences(fields: list[dict], body: dict, read: Callable[[str], Any]) -> list[dict]:
    """Read-back backstop: which non-blank requested values failed to land? A
    write-only field (a password) is never read back, so it is exempt."""
    by_name = {f["name"]: f for f in fields}
    out: list[dict] = []
    for key, requested in body.items():
        f = by_name.get(key)
        if f is None or f.get("readOnly") or f.get("writeOnly"):
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
    if _is_number(f.get("max")):
        parts.append(f"max={number_text(f['max'])}")
    if f.get("entity"):
        parts.append(f"entity={f['entity']}")
    if f.get("values"):
        # JavaScript's default sort: by each value's string form, so numeric
        # enum values fingerprint (and order) as they do in @a2app/rules.
        parts.append("values=" + "|".join(sorted((js_string(v) for v in f["values"]), key=_utf16)))
    return ":".join(parts)


def _stable_json(value: Any) -> str:
    """JSON with keys sorted at every depth, so declaration order cannot move the hash."""
    return _json_text(value, sort_keys=True, canonical=False)


def _operation_print(o: dict) -> str:
    flags = "".join(c for c, k in (("d", "destructive"), ("r", "readOnly"), ("i", "idempotent")) if o.get(k))
    parts = [f"{o['name']}:{flags}" if flags else o["name"]]
    parts.append(f"mod={o.get('module')}")
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
        attrs = [f"{name}({','.join(sorted((_field_print(f) for f in value['fields']), key=_utf16))})"]
        if value.get("auth"):
            attrs.append("auth")
        attrs.append(f"mod={value['module']}")
        parts.append(":".join(attrs))
    parts.sort(key=_utf16)
    ops = sorted((_operation_print(o) for o in (operations or [])), key=_utf16)
    joined = _utf16(";".join(parts) + "|" + ",".join(ops))
    h = 5381
    for i in range(0, len(joined), 2):  # charCodeAt: one UTF-16 code unit at a time
        h = ((h * 33) ^ int.from_bytes(joined[i:i + 2], "big")) & 0xFFFFFFFF
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
    if declared_type == "number" and isinstance(value, str):
        n = js_number(value)
        return _js_value(n) if math.isfinite(n) else value
    return value


def _strictly_equal(a: Any, b: Any) -> bool:
    """`a === b` for JSON values: same kind and value; never two containers."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return a is None and b is None


def _same_value(a: Any, b: Any) -> bool:
    """Equality after declared-type reading. Arrays and objects compare by
    their JSON, so `list<ref>` membership is well defined."""
    if _strictly_equal(a, b):
        return True
    if a is None or b is None:
        return False
    if isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
        return js_stringify(a) == js_stringify(b)
    return False


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
        return js_stringify(v)
    return js_string(v)


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
        subject = "the record" if any(k in inner for k in ("all", "any", "not")) else inner.get("field")
        return f"the condition on {subject} is not met"

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
        + v["expected"] + "; got " + js_stringify(v["got"])
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


RATE_WINDOW_MS = 60_000


class _RateLimiter:
    """A fixed-window counter per (caller, route class). Parity oracle:
    adapters/adapter-core/src/rate.ts."""

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
        if now - ws >= RATE_WINDOW_MS:
            ws, count = now, 0
        count += 1
        self.windows[key] = [ws, count]
        if count > limit:
            wait = -(-(RATE_WINDOW_MS - (now - ws)) // 1000)  # whole seconds, rounded up
            return {"allowed": False, "limit": limit, "retryAfterSeconds": max(1, wait)}
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


def _tz_offset_minutes(ms: int) -> int:
    """The server's UTC offset at `ms`, in minutes east (`-getTimezoneOffset()`)."""
    offset = datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone().utcoffset()
    return round(offset.total_seconds() / 60) if offset is not None else 0


def _level_size(level: Any) -> int:
    """A describe level's size in the units the budget is stated in:
    `JSON.stringify(level).length`."""
    return js_length(js_stringify(level))


def _base36(n: int) -> str:
    """`n.toString(36)` for a non-negative integer."""
    digits = ""
    while True:
        n, r = divmod(n, 36)
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + digits
        if n == 0:
            return digits


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


# ------------------------------------------------------------- static files
#
# A file the app serves a browser (the account page), with real validators: a
# reload always re-checks, and an unchanged file costs a bodyless 304. Parity
# oracle: adapters/adapter-core/src/static.ts.


def _etag_matches(header: Optional[str], etag: str) -> bool:
    """An If-None-Match list: `*` matches anything, and the comparison is the
    weak one a conditional GET uses (RFC 9110 13.1.2)."""
    if header is None:
        return False
    strip = lambda value: re.sub(r"^W/", "", value.strip())  # noqa: E731
    return any(strip(candidate) in ("*", strip(etag)) for candidate in header.split(","))


def static_reply(method: str, headers: dict, body: bytes, modified: float, content_type: str) -> tuple[int, dict, bytes]:
    """`(status, headers, body)` for a request naming one file the app serves.

    GET and HEAD only (the server drops the body of a HEAD reply). An ETag
    over the content wins over If-Modified-Since, whose whole-second clock an
    edit within the same second cannot move.
    """
    if method.upper() not in ("GET", "HEAD"):
        refusal = {"a2app": True, "ok": False, "code": "method_not_allowed", "message": "Static assets are GET-only."}
        return 405, {"content-type": "application/json", "allow": "GET, HEAD"}, to_json(refusal).encode()
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    reply = {"content-type": content_type, "cache-control": "no-cache", "etag": etag, "last-modified": formatdate(modified, usegmt=True)}
    inm = headers.get("if-none-match")
    fresh = _etag_matches(inm, etag)
    if not fresh and inm is None and headers.get("if-modified-since"):
        try:
            fresh = int(modified) <= parsedate_to_datetime(headers["if-modified-since"]).timestamp()
        except (TypeError, ValueError):
            fresh = False
    if fresh:
        return 304, reply, b""
    return 200, {**reply, "content-length": str(len(body))}, body


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
    return "" if value is None else js_string(value)


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
    """A validated raw value in its stored form: a number or boolean sent as
    text becomes one, as `Number(text)` reads it. The guard already accepted it."""
    if value is None or value == "":
        return value
    if field["type"] == "number" and isinstance(value, str):
        return _js_value(js_number(value))
    if field["type"] == "boolean" and isinstance(value, str):
        return value == "true"
    return value


def _sort_order(a: Any, b: Any) -> int:
    """The reference binding's sort comparison: equal, then a blank first, then
    by each value's string form (`cmp` in adapter-core's memory.ts)."""
    if _strictly_equal(a, b):
        return 0
    if a is None:
        return -1
    if b is None:
        return 1
    return -1 if _utf16(js_string(a)) < _utf16(js_string(b)) else 1


def _slice_at(x: Any, length: int) -> int:
    """Where `Array.prototype.slice` puts a bound: NaN is 0, a fraction is
    truncated, a negative counts back from the end."""
    if isinstance(x, float):
        if math.isnan(x):
            x = 0
        elif math.isinf(x):
            return length if x > 0 else 0
        else:
            x = math.trunc(x)
    return max(length + x, 0) if x < 0 else min(x, length)


class Store:
    """In-memory record store plus the adapter's own state: credentials,
    accounts, tasks, events, approvals, idempotency keys and the audit log.
    The blueprint's live store is ``SqliteStore`` below (same interface, every
    table durable); this base class is the disposable variant for tests and
    tooling.

    The rules -- how long an idempotency or approval key lives, the event and
    audit rings, a task's lifecycle, one task per occurrence -- are written here
    once, against a few storage primitives (the ``_``-prefixed methods) that a
    durable subclass implements. Parity oracle: adapters/adapter-core/src/store.ts.
    """

    def __init__(self, seed: Optional[dict] = None):
        self.seed = seed or {}
        # A fresh in-memory store is always empty, so it always takes the seed.
        # SqliteStore sets this False when the database file already existed:
        # re-seeding an existing database on every boot would resurrect a seed
        # record the user deleted.
        self.wants_seed = True
        self.rows: dict[str, dict[str, dict]] = {}
        # credentialId -> grant, and tokenHash -> credentialId
        self.grants: dict[str, dict] = {}
        self.grant_tokens: dict[str, str] = {}
        # The auth layer's keyed tables: users, sessions, invites, devices.
        self.tables: dict[str, dict[str, dict]] = {}
        self.idem: dict[tuple, tuple] = {}  # (scope, key) -> (record id, at ms)
        self.approvals: dict[str, int] = {}  # key -> expires at ms
        self.events: list[dict] = []
        self.tasks: dict[str, dict] = {}
        self.dedup: dict[str, str] = {}  # occurrence key -> task id
        self.audit: list[dict] = []
        self._event_seq = 0
        # Set by the Adapter that serves this store (`bind`).
        self.app_id: Optional[str] = None
        self.now_ms: Callable[[], int] = lambda: int(time.time() * 1000)
        self.event_types: set[str] = set()

    def bind(self, app_id: str, now_ms: Callable[[], int], event_types: set) -> None:
        """Called by the Adapter serving this store: the app its tasks and
        events name, its clock, and the event types the app declares (empty
        means none were declared)."""
        self.app_id = app_id
        self.now_ms = now_ms
        self.event_types = event_types

    # records ---------------------------------------------------------------
    def _all_records(self, entity: str) -> list[dict]:
        """Every record of one entity — the single hook a durable subclass
        overrides for reads; list_records keeps the shared filter/sort/page."""
        return list(self.rows.get(entity, {}).values())

    def list_records(self, entity: str, query: dict) -> dict:
        """One page of an entity's records. `page` and `perPage` are numbers as
        JavaScript's Number() read them from the query (NaN included), and page
        exactly as the reference binding does: no `perPage` is every row, a
        page past the end is empty."""
        items = self._all_records(entity)
        # `where` (field = value) comes from the adapter: a member sees only the
        # records it owns. Applied before filtering, sorting and paging like any
        # other constraint -- after them, a page would come back short and the
        # total would count other people's records.
        for field, value in (query.get("where") or {}).items():
            items = [r for r in items if r.get(field) == value]
        flt = query.get("filter")
        if flt:
            match = _match_filter(flt)
            items = [r for r in items if match(r)]
        sort = query.get("sort")
        if sort:
            desc = sort.startswith("-")
            key = sort[1:] if desc else sort
            sign = -1 if desc else 1
            items.sort(key=functools.cmp_to_key(lambda a, b: _sort_order(a.get(key), b.get(key)) * sign))
        total = len(items)
        per_page = total if query.get("perPage") is None else query["perPage"]
        page = 1 if query.get("page") is None else query["page"]
        start = (page - 1) * per_page
        return {
            "items": items[_slice_at(start, total):_slice_at(start + per_page, total)],
            "page": page, "perPage": per_page, "totalItems": total,
        }

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

    # idempotency -----------------------------------------------------------
    # `scope` is the entity for a create, `entity#id` for an update, and
    # `op:<name>` for an operation, so the three can never collide.
    def idem_get(self, scope: str, key: str) -> Optional[str]:
        """What this key already produced (a record id, or the operation's
        name), or None. A key is honoured for 24 hours."""
        found = self._idem_row(scope, key)
        if found is None:
            return None
        if self.now_ms() - found[1] > IDEMPOTENCY_TTL_MS:
            self._idem_delete(scope, key)
            return None
        return found[0]

    def idem_put(self, scope: str, key: str, produced: str) -> None:
        self._idem_write(scope, key, produced, self.now_ms())

    # approvals -------------------------------------------------------------
    def approval_issue(self, key: str) -> None:
        self._approval_write(key, self.now_ms() + APPROVAL_TTL_MS)

    def approval_consume(self, key: str) -> bool:
        """Single use: a key is spent by its first presentation, and only a
        key issued within the last 10 minutes approves anything."""
        expires = self._approval_take(key)
        return expires is not None and expires >= self.now_ms()

    # events ----------------------------------------------------------------
    def append_event(self, etype: str, payload: dict) -> dict:
        ev = {"seq": 0, "id": new_id("evt"), "app": self.app_id, "type": etype, "payload": payload, "createdAt": _iso(self.now_ms())}
        ev["seq"] = self._event_insert(ev)
        return ev

    def events_since(self, cursor: Optional[str]) -> dict:
        """Events after a cursor (an event's `seq`). A cursor that is not a
        number reads from the beginning, as `Number(cursor) || 0` does."""
        start = js_number(cursor) if cursor else 0
        if math.isnan(start) or start == 0:
            start = 0
        events = self._events_after(start)
        return {"events": events, "nextCursor": number_text(events[-1]["seq"] if events else start)}

    # tasks -----------------------------------------------------------------
    def enqueue_task(
        self, event_id: Optional[str], capability: str, payload: dict, dedup_key: Optional[str] = None,
        principal: Optional[str] = None,
    ) -> dict:
        # The same request firing twice while its task is open is one task. Once
        # that task is completed, failed or canceled, asking again is a new
        # request: returning the finished task would leave the person no way to
        # ask again. The dedup entry then points at the new task.
        if dedup_key:
            existing_id = self._dedup_get(dedup_key)
            existing = None if existing_id is None else self.get_task(existing_id)
            if existing is not None and existing["status"] in OPEN_TASK:
                return existing
        now = _iso(self.now_ms())
        task = {
            # A random id: a task credential names its task, so an id must never
            # come round again for a different task.
            "id": new_id("tsk"), "app": self.app_id, "event": event_id, "status": "submitted",
            # `principal`: who queued it (spec/v0_2/auth.md §6.1); None for work
            # the app queued on its own.
            "request": {"capability": capability, "payload": payload, "principal": principal}, "claim": None,
            "progress": {"step": None, "percent": 0}, "result": None, "reason": None, "ask": None,
            "createdAt": now, "updatedAt": now, "dedupKey": dedup_key, "deliveries": 1,
        }
        self._task_write(task)
        if dedup_key:
            self._dedup_write(dedup_key, task["id"])
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
            # what the app asked for (type, capability, payload), canonicalized
            # so key order cannot tell two identical triggers apart.
            occurrence = {"type": etype, "capability": capability, "payload": payload}
            # Who asked is part of the occurrence: the same request from two
            # people is two tasks, each run as the person who asked.
            if principal:
                occurrence["principal"] = principal
            key = sha256_prefixed(canonicalize(occurrence))
            task_id = self.enqueue_task(ev["id"], capability, payload, key, principal)["id"]
        return {"eventId": ev["id"], "taskId": task_id}

    def sweep(self, timeout_ms: int, max_deliveries: int) -> None:
        """Return abandoned claims to the queue.

        A ``working`` task with no update for ``timeout_ms`` goes back to
        ``submitted`` so another agent can take it, and fails with
        ``redelivery_exhausted`` once it has been handed out ``max_deliveries``
        times. Never a silent drop.
        """
        now = self.now_ms()
        for task in self._task_rows():
            if task["status"] != "working" or now - _ms(task["updatedAt"]) < timeout_ms:
                continue
            if task["deliveries"] >= max_deliveries:
                task["status"] = "failed"
                task["reason"] = "redelivery_exhausted"
            else:
                task["status"] = "submitted"
                task["claim"] = None
                task["deliveries"] += 1
            task["updatedAt"] = _iso(now)
            self._task_write(task)

    def list_tasks(self, status: Optional[str]) -> list[dict]:
        return [t for t in self._task_rows() if not status or t["status"] == status]

    def get_task(self, task_id: str) -> Optional[dict]:
        return self._task_row(task_id)

    def save_task(self, task: dict) -> None:
        task["updatedAt"] = _iso(self.now_ms())
        self._task_write(task)

    # audit -----------------------------------------------------------------
    def append_audit(self, entry: dict) -> None:
        self._audit_insert(entry)

    def audit_tail(self, n: int) -> list[dict]:
        return self._audit_rows()[-n:]

    # storage primitives (in memory) ----------------------------------------
    def _idem_row(self, scope: str, key: str) -> Optional[tuple]:
        return self.idem.get((scope, key))

    def _idem_write(self, scope: str, key: str, produced: str, at: int) -> None:
        self.idem[(scope, key)] = (produced, at)

    def _idem_delete(self, scope: str, key: str) -> None:
        self.idem.pop((scope, key), None)

    def _approval_write(self, key: str, expires: int) -> None:
        self.approvals[key] = expires

    def _approval_take(self, key: str) -> Optional[int]:
        return self.approvals.pop(key, None)

    def _event_insert(self, ev: dict) -> int:
        self._event_seq += 1
        ev["seq"] = self._event_seq
        self.events.append(ev)
        del self.events[:-EVENT_RETENTION]
        return self._event_seq

    def _events_after(self, seq: float) -> list[dict]:
        return [e for e in self.events if e["seq"] > seq]

    def _task_row(self, task_id: str) -> Optional[dict]:
        return self.tasks.get(task_id)

    def _task_rows(self) -> list[dict]:
        return list(self.tasks.values())

    def _task_write(self, task: dict) -> None:
        self.tasks[task["id"]] = task

    def _dedup_get(self, key: str) -> Optional[str]:
        return self.dedup.get(key)

    def _dedup_write(self, key: str, task_id: str) -> None:
        self.dedup[key] = task_id

    def _audit_insert(self, entry: dict) -> None:
        self.audit.append(entry)
        del self.audit[:-AUDIT_RETENTION]

    def _audit_rows(self) -> list[dict]:
        return list(self.audit)


class SqliteStore(Store):
    """The blueprint's live store: records and every table of the adapter's
    own state in SQLite (stdlib ``sqlite3`` -- still dependency-free).

    Records are JSON rows in one table keyed (entity, id): the schema stays
    declarative and additive (a new field simply appears in the JSON) while the
    DATABASE is a real on-disk file inside the toolkit's declared lifecycle
    dataDir -- which is what backup/restore/promote protect. WAL keeps a reader
    and a writer from blocking each other.

    The adapter's own state lives in tables of its own, never as records, and
    all of it survives a restart, because a restart is exactly when it is
    needed: a retried write arrives with its idempotency key, an agent resumes
    from its event cursor, a person approves the destructive call they were
    shown, and a task -- and the credential its agent runs with -- carries on.
    Task ids are random, so one is never reused for a different task.

    Writes are durable when the call returns -- there is no separate persist()
    step. A dict read from this store is a COPY: mutate it, then put it back
    (put_record(), save_task()), or the change never happened.
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
            db = self._db
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS records ("
                "entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (entity, id))"
            )
            # `entity` is the key's scope; `at` is when it was recorded (ms).
            db.execute(
                "CREATE TABLE IF NOT EXISTS idem ("
                "entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0, "
                "PRIMARY KEY (entity, key))"
            )
            if "at" not in {row[1] for row in db.execute("PRAGMA table_info(idem)")}:
                # A database from before keys expired: its keys start their 24
                # hours now rather than being dropped.
                db.execute("ALTER TABLE idem ADD COLUMN at INTEGER NOT NULL DEFAULT 0")
                db.execute("UPDATE idem SET at = ?", (int(time.time() * 1000),))
            # A grant row holds the token's hash, never the token.
            db.execute(
                "CREATE TABLE IF NOT EXISTS grants ("
                "credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, data TEXT NOT NULL)"
            )
            db.execute("CREATE INDEX IF NOT EXISTS grants_by_token ON grants (token_hash)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS auth ("
                "tbl TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, key))"
            )
            db.execute("CREATE TABLE IF NOT EXISTS approvals (key TEXT PRIMARY KEY, expires INTEGER NOT NULL)")
            # AUTOINCREMENT: a sequence number is never reused, even once the
            # ring has dropped the rows below it, so a saved cursor stays valid.
            db.execute("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS dedup (key TEXT PRIMARY KEY, task_id TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)")
            db.commit()
        self.wants_seed = fresh

    def close(self) -> None:
        """Release the database file (the last connection closing checkpoints
        the WAL into the main file)."""
        self._db.close()

    def _read(self, sql: str, params: tuple = ()) -> list[tuple]:
        with self._lock:
            return self._db.execute(sql, params).fetchall()

    def _write(self, *statements: tuple) -> sqlite3.Cursor:
        """Run statements as one transaction; returns the first one's cursor."""
        with self._lock:
            first = None
            for sql, params in statements:
                cursor = self._db.execute(sql, params)
                first = first or cursor
            self._db.commit()
        return first

    # records ---------------------------------------------------------------
    def _all_records(self, entity: str) -> list[dict]:
        return [json.loads(data) for (data,) in self._read("SELECT data FROM records WHERE entity = ?", (entity,))]

    def get_record(self, entity: str, rec_id: str) -> Optional[dict]:
        found = self._read("SELECT data FROM records WHERE entity = ? AND id = ?", (entity, rec_id))
        return json.loads(found[0][0]) if found else None

    def put_record(self, entity: str, rec: dict) -> None:
        self._write((
            "INSERT INTO records (entity, id, data) VALUES (?, ?, ?) "
            "ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data",
            (entity, rec["id"], to_json(rec)),
        ))

    def delete_record(self, entity: str, rec_id: str) -> bool:
        return self._write(("DELETE FROM records WHERE entity = ? AND id = ?", (entity, rec_id))).rowcount > 0

    # auth rows -------------------------------------------------------------
    def auth_row(self, table: str, key: str) -> Optional[dict]:
        found = self._read("SELECT data FROM auth WHERE tbl = ? AND key = ?", (table, key))
        return json.loads(found[0][0]) if found else None

    def put_auth_row(self, table: str, key: str, row: dict) -> None:
        self._write((
            "INSERT INTO auth (tbl, key, data) VALUES (?, ?, ?) ON CONFLICT (tbl, key) DO UPDATE SET data = excluded.data",
            (table, key, to_json(row)),
        ))

    def delete_auth_row(self, table: str, key: str) -> None:
        self._write(("DELETE FROM auth WHERE tbl = ? AND key = ?", (table, key)))

    def auth_rows(self, table: str) -> list[tuple[str, dict]]:
        return [(key, json.loads(data)) for key, data in self._read("SELECT key, data FROM auth WHERE tbl = ? ORDER BY rowid", (table,))]

    # grants ----------------------------------------------------------------
    def grant_by_token_hash(self, token_hash: str) -> Optional[dict]:
        found = self._read("SELECT data FROM grants WHERE token_hash = ?", (token_hash,))
        return json.loads(found[0][0]) if found else None

    def grant_by_id(self, credential_id: str) -> Optional[dict]:
        found = self._read("SELECT data FROM grants WHERE credential_id = ?", (credential_id,))
        return json.loads(found[0][0]) if found else None

    def put_grant(self, grant: dict) -> None:
        self._write((
            "INSERT INTO grants (credential_id, token_hash, data) VALUES (?, ?, ?) "
            "ON CONFLICT (credential_id) DO UPDATE SET token_hash = excluded.token_hash, data = excluded.data",
            (grant["credentialId"], grant["tokenHash"], to_json(grant)),
        ))

    def delete_grant(self, credential_id: str) -> None:
        self._write(("DELETE FROM grants WHERE credential_id = ?", (credential_id,)))

    def list_grants(self) -> list[dict]:
        return [json.loads(data) for (data,) in self._read("SELECT data FROM grants ORDER BY rowid")]

    # storage primitives ----------------------------------------------------
    def _idem_row(self, scope: str, key: str) -> Optional[tuple]:
        found = self._read("SELECT rec_id, at FROM idem WHERE entity = ? AND key = ?", (scope, key))
        return found[0] if found else None

    def _idem_write(self, scope: str, key: str, produced: str, at: int) -> None:
        self._write((
            "INSERT INTO idem (entity, key, rec_id, at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id, at = excluded.at",
            (scope, key, produced, at),
        ))

    def _idem_delete(self, scope: str, key: str) -> None:
        self._write(("DELETE FROM idem WHERE entity = ? AND key = ?", (scope, key)))

    def _approval_write(self, key: str, expires: int) -> None:
        self._write((
            "INSERT INTO approvals (key, expires) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET expires = excluded.expires",
            (key, expires),
        ))

    def _approval_take(self, key: str) -> Optional[int]:
        with self._lock:
            found = self._db.execute("SELECT expires FROM approvals WHERE key = ?", (key,)).fetchone()
            if found is not None:
                self._db.execute("DELETE FROM approvals WHERE key = ?", (key,))
                self._db.commit()
        return None if found is None else found[0]

    def _event_insert(self, ev: dict) -> int:
        with self._lock:
            seq = self._db.execute("INSERT INTO events (data) VALUES (?)", (to_json({k: v for k, v in ev.items() if k != "seq"}),)).lastrowid
            self._db.execute("DELETE FROM events WHERE seq <= ?", (seq - EVENT_RETENTION,))
            self._db.commit()
        return seq

    def _events_after(self, seq: float) -> list[dict]:
        rows = self._read("SELECT seq, data FROM events WHERE seq > ? ORDER BY seq", (seq,))
        return [{**json.loads(data), "seq": n} for n, data in rows]

    def _task_row(self, task_id: str) -> Optional[dict]:
        found = self._read("SELECT data FROM tasks WHERE id = ?", (task_id,))
        return json.loads(found[0][0]) if found else None

    def _task_rows(self) -> list[dict]:
        return [json.loads(data) for (data,) in self._read("SELECT data FROM tasks ORDER BY rowid")]

    def _task_write(self, task: dict) -> None:
        self._write((
            "INSERT INTO tasks (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
            (task["id"], to_json(task)),
        ))

    def _dedup_get(self, key: str) -> Optional[str]:
        found = self._read("SELECT task_id FROM dedup WHERE key = ?", (key,))
        return found[0][0] if found else None

    def _dedup_write(self, key: str, task_id: str) -> None:
        self._write(("INSERT OR REPLACE INTO dedup (key, task_id) VALUES (?, ?)", (key, task_id)))

    def _audit_insert(self, entry: dict) -> None:
        with self._lock:
            seq = self._db.execute("INSERT INTO audit (data) VALUES (?)", (to_json(entry),)).lastrowid
            self._db.execute("DELETE FROM audit WHERE seq <= ?", (seq - AUDIT_RETENTION,))
            self._db.commit()

    def _audit_rows(self) -> list[dict]:
        return [json.loads(data) for (data,) in self._read("SELECT data FROM audit ORDER BY seq")]


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


class OperationError(Exception):
    """Raised by an operation runner to refuse with its own code: the caller
    gets ``status`` (default 400) and ``{code, message, **extra}`` instead of a
    500 ``operation_failed``. Parity: adapter-core's OperationError."""

    def __init__(self, code: str, message: str, status: int = 400, extra: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}


# ----------------------------------------------------------------- adapter

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
        self.now_ms = clock or (lambda: int(time.time() * 1000))
        # The declared event types are what keep the app->agent queue from being
        # an open channel: `trigger` refuses a type that is not declared, so the
        # set of things this app can ever ask an agent to react to is fixed by
        # its author rather than by whatever a runner passes at the moment of
        # firing.
        store.bind(app_id, self.now_ms, {e["type"] for e in events or []})
        self.auth_mode = "multi-user" if auth_mode == "multi-user" else "none"
        self.multi_user = self.auth_mode == "multi-user"
        self.permissions_of = permissions_of
        # The public URL (A2APP_PUBLIC_URL, resolved by network_policy) is one
        # more of the app's own origins, and the hosts this app answers to are
        # derived from those origins: reached at its public URL, it answers
        # there and nowhere new.
        self.public_url = public_url
        self.own_origins = list(allowed_origins or []) + ([public_url] if public_url else [])
        self.allowed_origins = set(self.own_origins)
        self.allowed_hosts = {urlsplit(o).netloc.lower() for o in self.own_origins} - {""}
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
        # App text forwarded into every refused agent's context: one bounded line.
        self.credential_hint = bound_app_text(credential_hint) or CREDENTIAL_HINT
        self.env = env
        self.limiter = _RateLimiter(dict(DEFAULT_RATE_LIMITS), self.now_ms)
        # `dataVersion`, the marker that moves when RECORDS change, so an open
        # page can re-read data without reloading. appVersion and schemaVersion
        # stay the same when an agent adds a record, which is exactly when every
        # open tab is stale. The boot part makes a restart count as a change: a
        # server that came back may have been restored under the page.
        self._boot_mark = _base36(self.now_ms())
        self._data_writes = 0
        # Connected viewers, by the opaque per-tab id a page's update watcher
        # sends with its identity poll: a count for "is anyone looking?", never
        # identities, held in memory only.
        self._viewers: dict[str, int] = {}
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

    # -- identity -----------------------------------------------------------
    def identity(self) -> dict:
        now = self.now_ms()
        doc = {
            "a2app": True, "protocol": PROTOCOL_VERSION, "adapterVersion": ADAPTER_VERSION,
            "app": {"id": self.app_id, "name": self.app_name}, "schemaVersion": self._schema_version(),
            # Moves on every record write. A page compares it separately from
            # schemaVersion: a data change means re-read, not reload.
            "dataVersion": f"{self._boot_mark}.{self._data_writes}",
            "serverNow": _iso(now), "serverTzOffsetMinutes": _tz_offset_minutes(now),
            "authMode": self.auth_mode, "accountUrl": ACCOUNT_URL,
        }
        if self.env:
            doc["env"] = self.env
        return doc

    def _data_changed(self) -> None:
        self._data_writes += 1

    # -- viewers ------------------------------------------------------------
    def _note_viewer(self, headers: dict, q: dict) -> None:
        """Record a heartbeat, if this request carried one. A page's update
        watcher sends it on its identity poll (a header), and says goodbye with
        `?viewer=…&leaving` on a beacon, which cannot carry headers."""
        viewer = headers.get("x-a2app-viewer")
        if viewer is None:
            viewer = q.get("viewer")
        if not isinstance(viewer, str) or viewer == "" or js_length(viewer) > 64:
            return
        if "x-a2app-viewer-leaving" in headers or "leaving" in q:
            self._viewers.pop(viewer, None)
            return
        self._viewers[viewer] = self.now_ms()
        # A reload is a fresh id, so the table would otherwise grow per reload.
        if len(self._viewers) > VIEWER_CAP:
            self._count_viewers()

    def _count_viewers(self) -> int:
        """Live viewers, pruning the expired as it goes."""
        cutoff = self.now_ms() - VIEWER_TTL_MS
        for viewer, seen in list(self._viewers.items()):
            if seen < cutoff:
                del self._viewers[viewer]
        return len(self._viewers)

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
        if f.get("values") is not None:
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

    @staticmethod
    def _fit_list(build: Callable[[list, int], dict], items: list) -> dict:
        """Trim a list until the level fits the budget, always reporting what
        was dropped. Entries go from the end, so the declared order decides
        what survives. The budget is measured as JSON.stringify's length."""
        whole = build(list(items), 0)
        if _level_size(whole) <= DESCRIBE_BUDGET_CHARS:
            return whole
        lo, hi = 0, len(items)
        while lo < hi:
            mid = -(-(lo + hi) // 2)
            if _level_size(build(items[:mid], len(items) - mid)) <= DESCRIBE_BUDGET_CHARS:
                lo = mid
            else:
                hi = mid - 1
        return build(items[:lo], len(items) - lo)

    def _entities_of(self, module: str) -> list[tuple]:
        return [(n, d) for n, d in self.entity_defs.items() if d.get("module") == module]

    def _describe_root(self, access: dict, show_all: bool) -> dict:
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

        def build(rows: list, truncated: int, summaries: bool) -> dict:
            level = {
                "level": "root",
                "app": {"id": self.app_id, "name": self.app_name},
                "modules": rows if summaries else [{k: v for k, v in r.items() if k != "summary"} for r in rows],
                "conventions": self._conventions(),
                "next": ["describe/{module}", "describe?find={term}"] + (["describe?all=true"] if truncated else []),
            }
            if truncated:
                level["truncated"] = truncated
            return level

        whole = build(modules, 0, True)
        if show_all or _level_size(whole) <= DESCRIBE_BUDGET_CHARS:
            return whole
        # Shed detail before existence: summaries go first and every module
        # stays named; only if bare names still do not fit are rows dropped,
        # counted, and returned by `?all=true`.
        bare = build(modules, 0, False)
        if _level_size(bare) <= DESCRIBE_BUDGET_CHARS:
            return bare
        return self._fit_list(lambda rows, truncated: build(rows, truncated, False), modules)

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

    def _describe_entity(self, module: str, name: str, d: dict, access: dict, show_all: bool) -> dict:
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
        path = f"{module}/{name}"
        base_next = [f"describe/{path}/{{id}}", f"data {name} list"]

        def build(operations: list, truncated: int) -> dict:
            level = {
                "level": "entity",
                "path": path,
                "label": label_field_of(d["fields"]),
                "records": f"/api/collections/{name}/records",
                "fields": fields,
                "operations": operations,
                "next": base_next + ([f"describe/{path}?all=true"] if truncated else []),
            }
            if d.get("auth"):
                level["auth"] = True
            if d.get("ownedBy"):
                level["ownedBy"] = d["ownedBy"]
            if truncated:
                level["truncated"] = truncated
            return level

        # FIELDS ARE NEVER TRIMMED: a client treats a field absent from describe
        # as write-only and exempts it from the read-back check. Operations can
        # be -- they are also reachable from search -- and the count is reported.
        return build(ops, 0) if show_all else self._fit_list(build, ops)

    @staticmethod
    def _target_param(o: dict, entity: str) -> Optional[str]:
        """The parameter that takes THIS record, when the operation names one
        unambiguously: exactly one required `ref` to this entity. Two candidates
        (a `move` taking `from` and `to`) name none -- never a guess."""
        candidates = [
            p for p, spec in (o.get("params") or {}).items()
            if spec.get("type") == "ref" and spec.get("entity") == entity and spec.get("required") is True
        ]
        return candidates[0] if len(candidates) == 1 else None

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
            target = self._target_param(o, name)
            if target is not None:
                row["targetParam"] = target
            when = o.get("appliesWhen")
            if when and not evaluate_predicate(when, record, fields):
                row["available"] = False
                row["blocked"] = explain_predicate(when, record, fields)
            ops.append(row)

        # Sub-resources are the record's own list<ref> fields: a forward relation
        # is derivable from the type vocabulary alone, with no query grammar.
        relations = []
        for f in fields:
            if f["type"] != "list<ref>" or f.get("entity") is None:
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
            "label": label if isinstance(label, str) or label is None else js_string(label),
            "operations": ops,
        }
        if relations:
            level["relations"] = relations
        level["next"] = (
            [f"describe/{path}/{r['name']}" for r in relations]
            + [f"{path} {o['name']}" for o in ops if o["available"]]
            + [f"data {name} get {record['id']}"]
        )
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
        """Over the limit answers 429 before any work. Keyed by the credential
        token presented, else the page's origin, else one anonymous bucket."""
        token = headers.get("x-a2app-token")
        if token is None:
            token = headers.get("x-lui-token")
        caller = token if token is not None else ("origin:" + headers["origin"] if headers.get("origin") else "anon")
        decision = self.limiter.check(caller, cls)
        if decision["allowed"]:
            return None
        # A refusal comes before the credential is resolved, but a flood must
        # stay traceable: the caller and the route class go in the audit ring.
        # A token is recorded as its hash (how its grant is keyed), never as
        # itself -- the ring is on disk.
        who = caller if token is None else "token:" + hash_secret(token)
        self._audit({"credentialId": who}, f"rate:{cls}", None, "rejected", ERROR_CODES["RATE_LIMITED"])
        return self._err(429, ERROR_CODES["RATE_LIMITED"], f"Rate limit exceeded ({decision['limit']} per window). Slow down and retry.", retryAfterSeconds=decision["retryAfterSeconds"])

    def _audit(self, ctx: Optional[dict], target: str, record_id: Optional[str], outcome: str, code: Optional[str] = None) -> None:
        """One row in the audit ring: who acted, on what, and how it ended.
        Written for every refused or completed write, operation and task
        action; persisted, never served."""
        entry = {
            "at": _iso(self.now_ms()),
            "credentialId": ctx.get("credentialId") if ctx else None,
            "agentName": ctx.get("agentName") if ctx else None,
            "principal": ctx.get("principal") if ctx else None,
            "target": target, "recordId": record_id, "outcome": outcome,
        }
        if code:
            entry["code"] = code
        self.store.append_audit(entry)

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

        show_all = q.get("all") == "true"
        if not segments:
            return 200, self._describe_root(access, show_all)

        module_name = segments[0]
        module = next((m for m in self.modules if m["name"] == module_name), None)
        if module is None:
            return self._err(404, "unknown_module", f'No module "{module_name}".',
                             modules=[m["name"] for m in self.modules])
        if len(segments) == 1:
            return 200, self._describe_module(module, access, show_all)

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
            return 200, self._describe_entity(module_name, entity, d, access, show_all)

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
            return self._err(404, "unknown_relation", f'"{relation}" is not a sub-resource of {entity}.',
                             relations=[f["name"] for f in d["fields"] if f["type"] == "list<ref>" and not f.get("writeOnly")])
        target = field["entity"]
        if not access["read"](target):
            return self._err(403, ERROR_CODES["INSUFFICIENT_SCOPE"],
                             f"This credential does not hold data:{target}:read.",
                             required=f"data:{target}:read")
        target_def = self.entity_defs.get(target)
        target_label = label_field_of(target_def["fields"]) if target_def else None
        items = []
        ids = record.get(relation)
        for rid in ids if isinstance(ids, list) else []:
            # A dangling reference is reported as the id it is, not dropped.
            referenced = self.store.get_record(target, js_string(rid))
            label = referenced.get(target_label) if (referenced and target_label) else None
            items.append({"id": js_string(rid), "label": label if isinstance(label, str) or label is None else js_string(label)})

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

    def dispatch(self, method: str, path: str, headers: dict, body: Any, query: Optional[dict] = None):
        """Route one request, as adapter-core's `handle` does.

        `path` is the path as sent, still percent-encoded: routes match on it
        and each segment is decoded after the split, so an escaped `/` stays
        inside the id it belongs to. `body` is the parsed JSON, None when there
        was none. Returns ``(status, json, headers)`` -- the headers the reply
        sets (a session cookie), usually none -- or None for a path outside the
        adapter's namespaces, which the host app serves once it has passed the
        same Host check. Anything a handler raises is a 500 ``adapter_error``
        in the a2app envelope, never a framework error page.
        """
        try:
            with self._lock:
                reply = self._route(method, path, headers, body, query)
        except Exception as e:  # noqa: BLE001
            return 500, {"a2app": True, "ok": False, "code": "adapter_error", "message": str(e)}, {}
        if reply is None:
            return None
        return reply[0], reply[1], (reply[2] if len(reply) > 2 else {})

    def _route(self, method: str, path: str, headers: dict, body: Any, query: Optional[dict]):
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        method = method.upper()
        q = dict(query or {})
        if "?" in path:
            path, qs = path.split("?", 1)
            q.update({k: v[-1] for k, v in parse_qs(qs, keep_blank_values=True).items()})
        path = path.rstrip("/") or "/"

        # Before any route, including the unauthenticated identity document,
        # which is otherwise a free fingerprint of the app for a rebound page.
        refused = self.host_refusal(headers)
        if refused is not None:
            return refused
        if path in IDENTITY_PATHS:
            # A page's update watcher polls this anyway, so its "still here"
            # rides along rather than doubling every tab's request rate.
            self._note_viewer(headers, q)
            return 200, self.identity()
        if not any(path == ns or path.startswith(ns + "/") for ns in ADAPTER_NAMESPACES):
            return None  # not the adapter's: the host app's own route
        # How many people have this app open: a count only, and behind a
        # credential -- a deployed app does not hand that to anyone who asks.
        if path == "/api/_a2app/viewers":
            _, reply = self._authorize(headers, None, False)
            if reply:
                return reply
            return 200, {"a2app": True, "viewers": self._count_viewers(), "ttlMs": VIEWER_TTL_MS}
        # Describe is navigational: the bare path is the root level, and each
        # extra segment moves one level inward (A2APP-SPEC 3).
        if path == "/api/_a2app/describe":
            return self._handle_describe(headers, [], q)
        if path.startswith("/api/_a2app/describe/"):
            segments = [decode_uri_component(s) for s in path[len("/api/_a2app/describe/"):].split("/")]
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
            _, reply = self._authorize(headers, None, False)
            if reply:
                return reply
            return 200, {"a2app": True, "view": None, "selected": []}
        if path == "/api/_a2app/events":
            return self._handle_events(headers, q)
        if path == "/api/_a2app/tasks" or path.startswith("/api/_a2app/tasks/"):
            rest = [] if path == "/api/_a2app/tasks" else path[len("/api/_a2app/tasks/"):].split("/")
            return self._handle_tasks(method, headers, rest, body, q)

        m = re.fullmatch(r"/api/collections/([^/]+)/records(?:/([^/]+))?", path)
        if m:
            rec_id = decode_uri_component(m.group(2)) if m.group(2) else None
            return self._handle_records(method, headers, decode_uri_component(m.group(1)), rec_id, body, q)

        m = re.fullmatch(r"/api/ops/([^/]+)", path)
        if m:
            if method != "POST":
                return self._err(405, "usage", "Operations are POST-only.")
            return self._handle_operation(headers, decode_uri_component(m.group(1)), body)

        # A miss inside the adapter's own namespaces is the adapter's to answer.
        return self._err(404, "not_found", UNKNOWN_ROUTE_MESSAGE)

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
        server_now = _iso(self.now_ms())

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
            # Paging values are numbers as JavaScript's Number() reads them.
            list_query = {k: query[k] for k in ("filter", "sort") if k in query}
            for k in ("perPage", "page"):
                if k in query:
                    list_query[k] = _js_value(js_number(query[k]))
            if self._owned_only(d, ctx):
                list_query["where"] = {d["ownedBy"]: ctx["principal"]}
            try:
                return 200, self.store.list_records(entity, list_query)
            except UnsupportedFilter as e:
                # Refuse, never ignore: unfiltered rows under a filter would be
                # a 200 with the wrong records (see the grammar's comment).
                return self._err(400, ERROR_CODES["INVALID_FILTER"], str(e), got=e.expression)

        ctx, reply = self._authorize(headers, f"data:{entity}:write", True)
        if reply:
            self._audit(None, f"data:{entity}", rec_id, "rejected", reply[1]["code"])
            return reply

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
                self._audit(ctx, f"data:{entity}", rec_id, "rejected", ERROR_CODES["RECORD_REFERENCED"])
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
            self._audit(ctx, f"data:{entity}", rec_id, "ok" if ok else "rejected")
            if not ok:
                return self._err(404, "record_not_found", f'No {entity} record "{rec_id}".')
            self._data_changed()
            return 200, {"a2app": True, "ok": True, "deleted": rec_id}

        if method not in ("POST", "PATCH"):
            return self._err(405, "usage", f"{method} not allowed on records.")
        body = object_view(body)

        # Idempotency: a replayed key answers 409 naming what it produced, on a
        # create AND on an update -- a retried PATCH after a lost response must
        # not re-apply. A create's key is scoped to the entity, an update's to
        # the row it targeted, so the two can never collide.
        idem = headers.get("idempotency-key")
        idem_active = bool(idem) and (method == "POST" or bool(rec_id))
        idem_scope = f"{entity}#{rec_id}" if method == "PATCH" else entity
        if idem_active:
            prior = self.store.idem_get(idem_scope, idem)
            if prior:
                return self._err(409, ERROR_CODES["DUPLICATE_REQUEST"], "This idempotency key was already applied.", id=prior)

        # Guard the RAW body before any coercion. A required field absent is
        # refused on a create only: a PATCH is a legitimate partial write.
        allow = {k: True for k in d.get("writeAllow", [])}
        violations = validate(fields, body, allow, require_required=method == "POST")
        if violations:
            self._audit(ctx, f"data:{entity}", rec_id, "rejected", violations[0]["code"])
            return self._guard_reply(violations, server_now)

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
            self._audit(ctx, f"data:{entity}", stored["id"], "rejected", ERROR_CODES["NOT_STORED"])
            return 422, {
                "a2app": True, "ok": False, "code": ERROR_CODES["NOT_STORED"],
                "message": describe_incomplete(lost),
                "violations": [{"code": ERROR_CODES["NOT_STORED"], "field": l["field"]} for l in lost],
                "id": stored["id"],
            }

        if idem_active:
            self.store.idem_put(idem_scope, idem, stored["id"])
        self._audit(ctx, f"data:{entity}", stored["id"], "ok")
        self._data_changed()
        return 200, stored

    @staticmethod
    def _guard_reply(violations: list[dict], server_now: str):
        """The guard's 400: the first violation up front, and every one listed."""
        first = violations[0]
        return 400, {
            "a2app": True, "ok": False, "code": first["code"], "field": first["field"],
            "expected": first["expected"], "got": first["got"],
            "message": describe_violation(first, server_now),
            "violations": [{"code": v["code"], "field": v["field"], "expected": v["expected"], "got": v["got"]} for v in violations],
        }

    # -- operations ---------------------------------------------------------
    @staticmethod
    def _param_fields(decl: dict) -> list[dict]:
        """A declared operation's parameters, in the shape the guard validates.

        An operation IS a write -- many of them destructive -- so its arguments
        meet the same rules as a record write: an undeclared parameter, a value
        outside a declared enum or a missing required one is refused before
        anything acts on it, and before an approval key is minted.
        """
        out = []
        for name, p in (decl.get("params") or {}).items():
            field = {"name": name, "type": p.get("type")}
            for k in ("required", "max", "values", "entity"):
                if p.get(k) is not None:
                    field[k] = p[k]
            out.append(field)
        return out

    def _handle_operation(self, headers, name, body):
        limited = self._rate_gate(headers, "ops")
        if limited:
            return limited
        decl = self.op_by_name.get(name)
        if not decl:
            return self._err(404, "unknown_operation", f'No declared operation "{name}".')
        ctx, reply = self._authorize(headers, f"op:{name}", not decl.get("readOnly"))
        if reply:
            return reply
        args = object_view(body)

        # Every parameter is supplied fresh on each call, so a declared
        # `required` is always enforced. A person must never be asked to approve
        # a call that cannot run.
        violations = validate(self._param_fields(decl), args, require_required=True)
        if violations:
            self._audit(ctx, f"op:{name}", None, "rejected", violations[0]["code"])
            return self._guard_reply(violations, _iso(self.now_ms()))

        # A replayed Idempotency-Key must not run the operation twice. Checked
        # before approval; recorded only after a success, so a first call that
        # asked for approval or failed leaves the retry free to run.
        idem = headers.get("idempotency-key")
        idem_scope = f"op:{name}"
        if idem and self.store.idem_get(idem_scope, idem):
            return self._err(409, ERROR_CODES["DUPLICATE_REQUEST"], "This idempotency key already ran this operation.", operation=name)

        if decl.get("destructive"):
            # The key addresses this exact call: the operation and its args as
            # sent (RFC 8785), so approving one call approves no variant of it.
            key = approval_key(name, body)
            provided = headers.get("x-a2app-approval")
            if provided is None:
                provided = headers.get("x-lui-approval")
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
        except OperationError as e:
            # The runner's own refusal: its status, code and message.
            self._audit(ctx, f"op:{name}", None, "rejected", e.code)
            return e.status, {"a2app": True, "ok": False, "code": e.code, "message": e.message, **e.extra}
        except Exception as e:  # noqa: BLE001
            self._audit(ctx, f"op:{name}", None, "rejected", "operation_failed")
            return self._err(500, "operation_failed", f'Operation "{name}" threw: {e}')
        if idem:
            self.store.idem_put(idem_scope, idem, name)
        # Only a declared read-only operation promises no side effects; the
        # adapter cannot see into a runner, so anything else counts as a change.
        if not decl.get("readOnly"):
            self._data_changed()
        self._audit(ctx, f"op:{name}", None, "ok")
        return 200, {"a2app": True, "ok": True, "operation": name, "result": result}

    # -- tasks / events -----------------------------------------------------
    def _handle_events(self, headers, query):
        limited = self._rate_gate(headers, "data")
        if limited:
            return limited
        _, reply = self._authorize(headers, None, False)
        if reply:
            return reply
        res = self.store.events_since(query.get("since"))
        return 200, {
            "a2app": True,
            "events": [{"id": e["id"], "app": e["app"], "type": e["type"], "payload": e["payload"], "createdAt": e["createdAt"]} for e in res["events"]],
            "nextCursor": res["nextCursor"], "pollAfterMs": 3000,
        }

    def _handle_tasks(self, method, headers, rest, body, query):
        limited = self._rate_gate(headers, "data")
        if limited:
            return limited
        caller = self._resolve(headers, method != "GET")
        if "reply" in caller:
            return caller["reply"]
        ctx, grant = caller["ctx"], caller["grant"]
        run_of = grant["task"] if grant is not None else None

        def reaches(t: dict) -> bool:
            """A task holds who asked and what was asked and answered, so it is
            reached like a record (spec auth §6.3): an owner reaches every task,
            a task credential its own, anyone else the tasks they queued."""
            if run_of:
                return run_of == t["id"]
            return ctx["role"] == "owner" or t["request"].get("principal") == ctx["principal"]

        def runs(t: dict) -> bool:
            """Progress and completion come from whoever runs the task."""
            claim = t["claim"]
            return (
                ctx["role"] == "owner" or run_of == t["id"]
                or (claim is not None and claim["credentialId"] == ctx["credentialId"] and claim["principal"] == ctx["principal"])
            )

        self.store.sweep(TASK_TIMEOUT_MS, TASK_MAX_DELIVERIES)

        if not rest and method == "GET":
            tasks = [self._task_wire(t) for t in self.store.list_tasks(query.get("status")) if reaches(t)]
            return 200, {"a2app": True, "tasks": tasks, "pollAfterMs": 2000}
        task_id = rest[0] if rest else None
        if not task_id:
            return self._err(400, "usage", "Task id required.")
        action = rest[1] if len(rest) > 1 else None
        # A task out of reach answers as one that does not exist: its existence
        # is itself something the caller may not learn.
        task = self.store.get_task(task_id)
        if not task or not reaches(task):
            return self._err(404, ERROR_CODES["TASK_NOT_FOUND"], f'No task "{task_id}".')
        if action is None and method == "GET":
            return 200, self._task_wire(task)
        if method != "POST":
            return self._err(405, "usage", f"{method} not allowed here.")
        body = object_view(body)

        def not_held():
            self._audit(ctx, f"task:{action}", task_id, "rejected", ERROR_CODES["TASK_NOT_HELD"])
            return self._err(403, ERROR_CODES["TASK_NOT_HELD"], f"Task {task_id} is held by another credential; only the run that holds it reports on it.")

        if action == "claim":
            if task["status"] != "submitted":
                self._audit(ctx, "task:claim", task_id, "rejected", ERROR_CODES["TASK_NOT_CLAIMABLE"])
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} is {task["status"]}, not claimable.')
            # `agent` (the SDK sends its credential id) may only name the caller:
            # a body naming anyone else is a claim-as-someone-else attempt, and is
            # refused rather than recorded under the true caller.
            requested = body.get("agent") if isinstance(body.get("agent"), str) and body.get("agent") else None
            if requested and requested != ctx["credentialId"] and requested != ctx["agentName"]:
                self._audit(ctx, "task:claim", task_id, "rejected", "principal_mismatch")
                return self._err(
                    403, "principal_mismatch",
                    f'Cannot claim task {task_id} as "{requested}": the credential presented is {ctx["credentialId"]}.',
                    requested=requested, actual=ctx["credentialId"],
                )
            task["status"] = "working"
            task["claim"] = {"credentialId": ctx["credentialId"], "principal": ctx["principal"], "claimedAt": _iso(self.now_ms())}
            self.store.save_task(task)
            self._audit(ctx, "task:claim", task_id, "ok")
            return 200, self._task_wire(task)
        if action == "progress":
            if task["status"] == "canceled":
                return self._err(409, ERROR_CODES["TASK_CANCELED"], f"Task {task_id} was canceled.")
            if task["status"] not in ("working", "input-required"):
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} is {task["status"]}.')
            if not runs(task):
                return not_held()
            if isinstance(body.get("step"), str):
                task["progress"]["step"] = body["step"]
            if _is_number(body.get("percent")):
                task["progress"]["percent"] = body["percent"]
            if "ask" in body:
                task["ask"] = body["ask"]
                task["status"] = "input-required"
            elif task["status"] == "input-required":
                task["status"] = "working"
            self.store.save_task(task)
            self._audit(ctx, "task:progress", task_id, "ok")
            return 200, self._task_wire(task)
        if action == "complete":
            if task["status"] == "canceled":
                return self._err(409, ERROR_CODES["TASK_CANCELED"], f"Task {task_id} was canceled.")
            # A terminal write belongs to a live claim. Once the sweeper has
            # returned a task to the queue, a late completion from the run that
            # abandoned it must not close work someone else may now be doing.
            if task["status"] not in ("working", "input-required"):
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} is {task["status"]}, not in progress.')
            if not runs(task):
                return not_held()
            status = body.get("status")
            if status == "completed":
                task["status"] = "completed"
                task["result"] = {} if body.get("result") is None else body["result"]
            elif status == "failed":
                task["status"] = "failed"
                task["reason"] = body["reason"] if isinstance(body.get("reason"), str) else "unspecified"
            else:
                return self._err(400, "usage", 'complete requires status "completed" or "failed".')
            self.store.save_task(task)
            self._audit(ctx, "task:complete", task_id, "ok", "failed" if task["status"] == "failed" else None)
            return 200, self._task_wire(task)
        if action == "cancel":
            # Terminal is terminal: relabelling finished work as canceled would
            # move it backwards and rewrite its recorded outcome.
            if task["status"] in TERMINAL_TASK:
                return self._err(409, ERROR_CODES["TASK_NOT_CLAIMABLE"], f'Task {task_id} already reached {task["status"]}.')
            task["status"] = "canceled"
            self.store.save_task(task)
            self._audit(ctx, "task:cancel", task_id, "ok")
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
            self._audit(ctx, "task:credential", task_id, "ok")
            return 201, {"a2app": True, "token": token, "credential": credential_wire(grant, info["name"])}
        return self._err(404, "usage", f'Unknown task action "{action}".')

    @staticmethod
    def _task_wire(t: dict) -> dict:
        """A task as served: never its `ask`, delivery count or dedup key."""
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
            return self._handle_invites(method, headers, body, decode_uri_component(path[len("/api/_a2app/invites/"):]))
        if path == "/api/_a2app/users":
            return self._handle_users(method, headers, body, None)
        if path.startswith("/api/_a2app/users/"):
            return self._handle_users(method, headers, body, decode_uri_component(path[len("/api/_a2app/users/"):]))
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

        body = object_view(body)
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
            role = object_view(body).get("role")
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

        body = object_view(body)
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
        body = object_view(body)
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
        return self._revoke_credential(headers, decode_uri_component(path[len("/api/_a2app/credentials/"):]))

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
        body = object_view(body)
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
    #
    # Approving is not enough on its own: anyone can start a request and send
    # the person its link. So approval issues a one-time confirmation code, and
    # the credential goes only to whoever presents it. An agent on the person's
    # own computer receives it on a loopback port (RFC 8252) when the page
    # returns the browser there; an agent elsewhere is given it by the person.

    def _handle_device(self, method, headers, body, path):
        """Route one request under /api/_a2app/auth/, or None."""
        if path == "/api/_a2app/auth/device":
            return self._device_start(headers, body) if method == "POST" else self._err(405, "usage", "Start a sign-in with POST.")
        if path == "/api/_a2app/auth/token":
            return self._device_poll(body) if method == "POST" else self._err(405, "usage", "Poll with POST.")
        if path.startswith("/api/_a2app/auth/device/"):
            code = decode_uri_component(path[len("/api/_a2app/auth/device/"):])
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
        body = object_view(body)
        scopes, expires_in, problem = parse_grant_request(body, self._all_scopes())
        if problem:
            return self._err(400, "usage", problem)
        agent_name = body.get("agentName")
        if "agentName" in body and (not isinstance(agent_name, str) or agent_name.strip() == "" or js_length(agent_name) > 100):
            return self._err(400, "usage", "agentName is 1–100 characters.")
        # Where the agent waits on 127.0.0.1, when it runs on the person's computer.
        loopback_port = body.get("loopbackPort")
        if loopback_port is not None and (
            not _is_number(loopback_port) or not float(loopback_port).is_integer()
            or not LOOPBACK_PORT_MIN <= loopback_port <= LOOPBACK_PORT_MAX
        ):
            return self._err(400, "usage", f"loopbackPort is the port, {LOOPBACK_PORT_MIN} to {LOOPBACK_PORT_MAX}, where the agent waits on 127.0.0.1.")
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
            "loopbackPort": None if loopback_port is None else int(loopback_port),
            "confirmationHash": None,  # SHA-256 of the code approval issues
            "confirmAttempts": 0,
        })
        approve = f"{self._public_origin(headers)}{ACCOUNT_URL}#approve"
        return 200, {
            "a2app": True, "deviceCode": device_code, "userCode": user_code,
            "verificationUri": approve, "verificationUriComplete": f"{approve}/{user_code}",
            "expiresIn": CODE_TTL_SECONDS, "interval": POLL_INTERVAL_SECONDS,
        }

    def _device_poll(self, body):
        body = object_view(body)
        device_code = body.get("deviceCode")
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
        if (
            row["status"] == "approved" and row["approvedBy"] is not None and row["approvedScopes"] is not None
            and row.get("confirmationHash") is not None
        ):
            # Answered at once, whatever the interval: wrong guesses are bounded
            # by CONFIRM_ATTEMPTS instead.
            confirmation = normalize_user_code(body["confirmation"]) if isinstance(body.get("confirmation"), str) else ""
            if confirmation == "":
                return self._err(400, "confirmation_required", "Approved. Present the confirmation code the approval produced.", interval=row["interval"])
            if not hmac.compare_digest(hash_secret(confirmation), row["confirmationHash"]):
                attempts = row["confirmAttempts"] + 1
                if attempts >= CONFIRM_ATTEMPTS:
                    self.store.delete_auth_row("devices", key)
                    return self._err(400, "access_denied", "Too many wrong confirmation codes: this request is void. Start again.")
                self.store.put_auth_row("devices", key, {**row, "confirmAttempts": attempts})
                return self._err(400, "confirmation_invalid", f"That is not this request's confirmation code ({CONFIRM_ATTEMPTS - attempts} tries left).")
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
            # When it was asked for, and whether the agent waits on this
            # computer: what lets a person tell their own agent's request
            # from one someone sent them.
            "requestedAt": row["createdAt"], "loopback": row.get("loopbackPort") is not None,
        }

    def _device_decide(self, headers, body, user_code):
        manager, reply = self._manager_of(headers, write=True)
        if reply:
            return reply
        found = self._device_by_user_code(user_code)
        if found is None:
            return self._err(404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.")
        key, row = found
        body = object_view(body)
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
        confirmation = new_user_code()
        self.store.put_auth_row("devices", key, {
            **row, "status": "approved", "approvedBy": manager["principal"], "approvedScopes": scopes,
            "confirmationHash": hash_secret(confirmation),
        })
        port = row.get("loopbackPort")
        return 200, {
            "a2app": True, "ok": True, "status": "approved", "confirmation": confirmation,
            # The page sends the browser here, so the code reaches only the
            # computer that approved; otherwise the person hands it over.
            "redirect": None if port is None else (
                f"http://127.0.0.1:{port}{LOOPBACK_CALLBACK}?confirmation={quote(confirmation, safe=_URI_COMPONENT_SAFE)}"
            ),
        }

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
    asked_again = q_store.trigger("task.needs_triage", {"task": "t1"}, "triage")["taskId"]
    check("once its task is finished, the same occurrence queues a new one", asked_again != tid, True)
    check("…which the next repeat joins", q_store.trigger("task.needs_triage", {"task": "t1"}, "triage")["taskId"], asked_again)

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

    started_at = clock[0]
    started = call("POST", "/api/_a2app/auth/device", body={"agentName": "cli", "scopes": ["data:notes:read", "data:notes:write"]})[1]

    def poll(request: dict, confirmation: Optional[str] = None) -> dict:
        body = {"deviceCode": request["deviceCode"]}
        if confirmation is not None:
            body["confirmation"] = confirmation
        return call("POST", "/api/_a2app/auth/token", body=body)[1]

    user_code = re.compile(r"[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}")
    check("device sign-in links to the approve screen", started["verificationUriComplete"], f"http://127.0.0.1:9931{ACCOUNT_URL}#approve/{started['userCode']}")
    check("polling waits for the person", poll(started)["code"], "authorization_pending")
    check("…and slows a poll that comes too soon", poll(started)["interval"], POLL_INTERVAL_SECONDS + SLOW_DOWN_STEP_SECONDS)
    review = call("GET", f"/api/_a2app/auth/device/{started['userCode']}", alice)[1]
    check("the person sees when it was asked, and that no agent waits on this computer", [review["requestedAt"], review["loopback"]], [_iso(started_at), False])
    check(
        "approval can only narrow",
        call("POST", f"/api/_a2app/auth/device/{started['userCode'].lower()}", alice, {"approve": True, "scopes": ["*"]})[1]["code"],
        "usage",
    )
    approved = call("POST", f"/api/_a2app/auth/device/{started['userCode']}", alice, {"approve": True, "scopes": ["data:notes:read"]})[1]
    check(
        "approving issues a confirmation code, with nowhere to send it",
        [approved["status"], user_code.fullmatch(approved["confirmation"]) is not None, approved["redirect"]],
        ["approved", True, None],
    )
    check("approval alone hands nothing over, however soon the poll", [poll(started)["code"], poll(started)["code"]], ["confirmation_required", "confirmation_required"])
    check("…nor does a wrong confirmation code", poll(started, "BBBB-BBBB")["code"], "confirmation_invalid")
    issued = poll(started, approved["confirmation"].lower().replace("-", ""))
    check(
        "the code, in any case and without its dash, gets a credential for the approver, as approved",
        [issued["credential"]["principal"], issued["credential"]["scopes"]], ["usr_alice", ["data:notes:read"]],
    )
    check("…once", poll(started, approved["confirmation"])["code"], "expired_token")

    guessed = call("POST", "/api/_a2app/auth/device", body={})[1]
    call("POST", f"/api/_a2app/auth/device/{guessed['userCode']}", alice, {"approve": True})
    wrong = [poll(guessed, "BBBB-BBBB")["code"] for _ in range(CONFIRM_ATTEMPTS)]
    check("five wrong confirmation codes void the request", wrong, ["confirmation_invalid"] * (CONFIRM_ATTEMPTS - 1) + ["access_denied"])
    check("…for good", poll(guessed)["code"], "expired_token")
    check(
        "a loopback port is a whole number from 1024 to 65535",
        [call("POST", "/api/_a2app/auth/device", body={"loopbackPort": port})[1].get("code") for port in (80, 65536, 5000.5, True, "8080", 1e400)],
        ["usage"] * 6,
    )
    local = call("POST", "/api/_a2app/auth/device", body={"agentName": "local", "loopbackPort": 53682.0})[1]
    check("an agent on this computer is shown as such", call("GET", f"/api/_a2app/auth/device/{local['userCode']}", alice)[1]["loopback"], True)
    sent = call("POST", f"/api/_a2app/auth/device/{local['userCode']}", alice, {"approve": True})[1]
    check("approval sends the browser back to the agent's port with the code", sent["redirect"], f"http://127.0.0.1:53682/a2app/callback?confirmation={sent['confirmation']}")
    check("…which completes the sign-in", poll(local, sent["confirmation"])["credential"]["principal"], "usr_alice")

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

    # Who reaches a task (spec auth §6.3): an owner every task, a task
    # credential its own, anyone else the tasks they asked for.
    bob_in = call("POST", "/api/_a2app/session", body={"login": "bob", "password": "correct horse battery staple"}, origin=origin)
    bob = {"cookie": bob_in[2]["set-cookie"].split(";")[0], "origin": origin}
    bobs = mu.trigger("note.triage", {"note": "b"}, "triage", principal="usr_bob")["taskId"]
    alices_task = mu.trigger("note.triage", {"note": "a"}, "triage", principal="usr_alice")["taskId"]

    def listed(who) -> list:
        return [t["id"] for t in call("GET", "/api/_a2app/tasks", who)[1]["tasks"]]

    check("an owner lists every task", listed(alice), [queued, bobs, alices_task])
    check("a member lists only the tasks they asked for", listed(bob), [queued, bobs])
    check("…another's answers as one that does not exist", call("GET", f"/api/_a2app/tasks/{alices_task}", bob)[1]["code"], "task_not_found")
    check(
        "…and can be neither claimed nor canceled by them",
        [call("POST", f"/api/_a2app/tasks/{alices_task}/{action}", bob, {})[1]["code"] for action in ("claim", "cancel")],
        ["task_not_found", "task_not_found"],
    )
    check("an owner reads anyone's", call("GET", f"/api/_a2app/tasks/{bobs}", alice)[0], 200)
    call("POST", f"/api/_a2app/tasks/{bobs}/claim", admin, {})
    run = call("POST", f"/api/_a2app/tasks/{bobs}/credential", admin)[1]["token"]
    check(
        "a task credential reaches its own task and no other",
        [call("GET", f"/api/_a2app/tasks/{bobs}", run)[0], call("GET", f"/api/_a2app/tasks/{alices_task}", run)[1]["code"], listed(run)],
        [200, "task_not_found", [bobs]],
    )
    check(
        "the person who asked cannot report on a run they do not hold",
        call("POST", f"/api/_a2app/tasks/{bobs}/complete", bob, {"status": "completed", "result": {}})[1]["code"], "task_not_held",
    )
    check("…which is audited", [mu_store.audit_tail(1)[0].get(k) for k in ("target", "outcome", "code")], ["task:complete", "rejected", "task_not_held"])
    check("…but can cancel it", call("POST", f"/api/_a2app/tasks/{bobs}/cancel", bob, {})[0], 200)
    again = mu.trigger("note.triage", {"note": "b"}, "triage", principal="usr_bob")["taskId"]
    check("once a task is finished, the same request queues a new one", again != bobs, True)
    check(
        "a member who claims their own task holds it, and reports on it",
        [call("POST", f"/api/_a2app/tasks/{again}/claim", bob, {})[0], call("POST", f"/api/_a2app/tasks/{again}/complete", bob, {"status": "completed"})[0]],
        [200, 200],
    )

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
    # 10. JavaScript's reading of values, RFC 8785 and the approval key. Each
    #     expected value below was produced by adapter-core (canon.ts) or
    #     @a2app/rules from the same input.
    emoji, last_bmp = chr(0x1F600), chr(0xFFFF)
    check(
        "canonical JSON: UTF-16 key order, ECMAScript numbers, minimal escapes",
        canonicalize({"b": [1, 1.5, 1e21, 1e-7, 0.1, 100.0, -0.0, 123456789012345680000], "a": "é" + chr(0x2028) + "\n" + chr(0x1F) + '"',
                      emoji: True, last_bmp: None, "A": {}}),
        '{"A":{},"a":"é' + chr(0x2028) + '\\n\\u001f\\"","b":[1,1.5,1e+21,1e-7,0.1,100,0,123456789012345680000],"' + emoji + '":true,"' + last_bmp + '":null}',
    )
    check("the approval key is sha256 of the canonical {operation, args}", approval_key("clear-done", {}), "7d745c845ebc004f343ea667d5b6e711ae3a8b842858cb0e79e4d3026519c00c")
    check("…absent args are {}", approval_key("clear-done", None), approval_key("clear-done", {}))
    check(
        "…whatever the key order of the args",
        approval_key("bulk-archive", {"limit": 25, "ids": ["a", "b"], "force": False, "before": "2026-01-01"}),
        "1b2de2e268a85eedf53f5ba71b7c7d33e55edc1b6358445bd68c9d21d4415fa0",
    )
    check(
        "an occurrence's dedup key matches adapter-core's",
        sha256_prefixed(canonicalize({"type": "task.needs_triage", "capability": "triage", "payload": {"task": "t1"}, "principal": "usr_x"})),
        "sha256:55882591394d2f267b2c8320f1d14240833d345c4de1952a8311cfed6a639430",
    )
    check(
        "the fingerprint matches @a2app/rules, numeric enum values included",
        schema_fingerprint(
            {"tasks": {"module": "planning", "fields": [
                {"name": "title", "type": "string", "required": True, "max": 200},
                {"name": "size", "type": "enum", "values": [10, 2, 1.5]},
                {"name": "owner", "type": "string", "readOnly": True}]}},
            [{"name": "clear-done", "destructive": True, "module": "planning", "params": {}},
             {"name": "tag", "module": "planning", "entity": "tasks", "params": {"label": {"type": "enum", "values": ["café", "z"], "required": True}},
              "appliesWhen": {"field": "size", "in": [1.5, 2]}}],
        ),
        "sv_1dad3320",
    )
    check(
        "numbers print as JavaScript prints them",
        [number_text(x) for x in (0.1, 1e-7, 1e-6, 1e21, 1e20, 5e-324, -2.5, 100.0, 12345678901234567890)],
        ["0.1", "1e-7", "0.000001", "1e+21", "100000000000000000000", "5e-324", "-2.5", "100", "12345678901234567000"],
    )
    check(
        "text reads as a number as Number() reads it",
        [js_number(t) for t in ("1e3", "0x1A", " 5 ", "Infinity", ".5", "")],
        [1000.0, 26.0, 5.0, math.inf, 0.5, 0.0],
    )
    check("…and NaN is NaN", [math.isnan(js_number(t)) for t in ("inf", "1_000", "0x", "²", "five")], [True] * 5)
    check("a body reads as Object.keys sees it", [object_view([]), object_view(["a"]), list(object_view({"b": 1, "1": 2})), object_view(None), object_view(7)],
          [{}, {"0": "a"}, ["1", "b"], {}, {}])
    check("app text is one line, bounded", [bound_app_text(" a \n\n b "), bound_app_text("  "), js_length(bound_app_text("x" * 400))], ["a b", None, APP_TEXT_MAX])

    # 11. The guard's current rules (@a2app/rules validate).
    codes = lambda vs: [(v["code"], v["field"]) for v in vs]  # noqa: E731
    check("a create without a required field is missing_required", codes(validate(fields, {}, require_required=True)), [("missing_required", "title")])
    check("…and so is blanking it, on any write", codes(validate(fields, {"title": ""})), [("missing_required", "title")])
    check("…but an update may leave it out", validate(fields, {"status": "todo"}), [])
    check(
        "text past its max, counted as JavaScript counts",
        [(v["code"], v["expected"]) for v in validate(fields, {"title": emoji * 101})],
        [("invalid_string", "text of at most 200 characters")],
    )
    check(
        "a list is an array, never a wrapped scalar",
        [v["expected"] for v in validate([{"name": "tags", "type": "list<enum>", "values": ["a", "b"]}], {"tags": "a"})],
        ["an array of: a | b"],
    )
    check(
        "with nothing writable, unknown_field says so",
        validate([{"name": "id", "type": "string", "readOnly": True}], {"x": 1})[0]["expected"],
        "nothing — no writable fields are declared",
    )
    numbers = [{"name": "n", "type": "number"}]
    check(
        "a number is a number or numeric text, never a boolean",
        [bool(validate(numbers, {"n": v})) for v in (1, 1.5, "1e3", "0x1A", " 5 ", "Infinity", True, "inf", "1_000", " ")],
        [False, False, False, False, False, False, True, True, True, True],
    )
    check("numeric text is stored as Number() reads it", [_coerce(numbers[0], v) for v in ("1e3", "0x1A", "5.0", "2.5")], [1000, 26, 5, 2.5])
    check(
        "enum values compare by their string form",
        [bool(validate([{"name": "e", "type": "enum", "values": [1, 2]}], {"e": v})) for v in (1.0, "2", True, 3)],
        [False, False, True, True],
    )
    check(
        "dates are ASCII digits to the end",
        [looks_like_date("２０２６-01-01"), is_day_key_value("2026-01-01\n"), looks_like_date("2026-01-01T10:00:00 Z")],
        [False, False, True],
    )
    check(
        "a write-only field is not expected back",
        divergences([{"name": "password", "type": "string", "writeOnly": True}], {"password": "x"}, lambda n: None),
        [],
    )
    check(
        "a negated compound explains itself generically",
        explain_predicate({"not": {"any": [{"field": "status", "eq": "doing"}]}}, record, fields),
        "the condition on the record is not met",
    )

    # 12. Every table of the adapter's state survives a restart.
    tmp = tempfile.mkdtemp(prefix="a2app-selftest-")
    tick = [_ms("2026-10-28T09:00:00.000Z")]
    try:
        db_path = os.path.join(tmp, "data", "db.sqlite")
        before = SqliteStore(db_path)
        before.bind("selftest", lambda: tick[0], {"task.needs_triage"})
        fired = before.trigger("task.needs_triage", {"task": "t1"}, "triage", principal="usr_x")
        kept_task = before.get_task(fired["taskId"])
        check("a task id is random", re.fullmatch(r"tsk_[0-9a-f]{16}", fired["taskId"]) is not None, True)
        check(
            "a new task names its app and has made no progress",
            [kept_task["app"], kept_task["progress"], kept_task["request"]["principal"]], ["selftest", {"step": None, "percent": 0}, "usr_x"],
        )
        cursor = before.events_since(None)["nextCursor"]
        before.approval_issue("ak")
        before.idem_put("tasks", "k", "t1")
        before.append_audit({"target": "data:tasks", "outcome": "ok"})
        before.close()

        after = SqliteStore(db_path)
        after.bind("selftest", lambda: tick[0], {"task.needs_triage"})
        check("tasks survive a restart", after.get_task(fired["taskId"]), kept_task)
        check("…and one occurrence is still one task", after.trigger("task.needs_triage", {"task": "t1"}, "triage", principal="usr_x")["taskId"], fired["taskId"])
        newer = after.events_since(cursor)
        check("a saved cursor reads only newer events, and the sequence carries on", [len(newer["events"]), newer["nextCursor"]], [1, "2"])
        check("a cursor that is not one reads from the beginning", after.events_since("abc"), after.events_since(None))
        check("the audit log survives", after.audit_tail(1), [{"target": "data:tasks", "outcome": "ok"}])
        check("so does an idempotency key, for 24 hours", after.idem_get("tasks", "k"), "t1")
        check("…and an approval key, used once", [after.approval_consume("ak"), after.approval_consume("ak")], [True, False])
        after.approval_issue("late")
        tick[0] += APPROVAL_TTL_MS + 1
        check("an approval key expires after 10 minutes", after.approval_consume("late"), False)
        tick[0] += IDEMPOTENCY_TTL_MS
        check("an idempotency key expires after 24 hours", after.idem_get("tasks", "k"), None)
        global EVENT_RETENTION
        kept_retention, EVENT_RETENTION = EVENT_RETENTION, 3
        try:
            for i in range(5):
                after.append_event("task.needs_triage", {"n": i})
            ring = after.events_since(None)["events"]
        finally:
            EVENT_RETENTION = kept_retention
        check("the event log is a ring that keeps counting", [e["seq"] for e in ring], [5, 6, 7])
        finished = after.get_task(fired["taskId"])
        finished["status"] = "canceled"
        after.save_task(finished)
        renewed = after.trigger("task.needs_triage", {"task": "t1"}, "triage", principal="usr_x")["taskId"]
        check(
            "once it is finished, the same occurrence queues a new task, which the next repeat joins",
            [renewed != fired["taskId"], after.trigger("task.needs_triage", {"task": "t1"}, "triage", principal="usr_x")["taskId"]],
            [True, renewed],
        )
        after.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    small = Store()
    for i in range(EVENT_RETENTION + 3):
        small.append_event("x", {})
    check("…of 5000 events", [len(small.events), small.events[0]["seq"]], [EVENT_RETENTION, 4])

    # 13. The served surface end to end on authMode none, with a fixed clock.
    now = [_ms("2026-10-28T09:00:00.000Z")]
    plan_fields = [
        {"name": "title", "type": "string", "required": True, "max": 20},
        {"name": "status", "type": "enum", "values": ["todo", "done"]},
        {"name": "owner", "type": "string", "readOnly": True},
    ]

    def refuse(args, ctx, store):
        raise OperationError("over_quota", "No more today.", 409, {"limit": 3})

    def explode(args, ctx, store):
        raise RuntimeError("boom")

    def clear_done(args, ctx, store):
        done = [r for r in store.list_records("tasks", {})["items"] if r.get("status") == "done"]
        for r in done:
            store.delete_record("tasks", r["id"])
        return {"removed": len(done)}

    ops = [
        {"name": "clear-done", "destructive": True, "module": "planning", "params": {}},
        {"name": "count", "readOnly": True, "module": "planning", "params": {}},
        {"name": "tag", "module": "planning", "entity": "tasks", "appliesWhen": {"field": "status", "ne": "done"},
         "params": {"task": {"type": "ref", "entity": "tasks", "required": True}, "label": {"type": "enum", "values": ["a", "b"]}}},
        {"name": "move", "module": "planning", "entity": "tasks",
         "params": {"from": {"type": "ref", "entity": "tasks", "required": True}, "to": {"type": "ref", "entity": "tasks", "required": True}}},
        {"name": "refuse", "module": "planning", "params": {}},
        {"name": "explode", "module": "planning", "params": {}},
    ]
    app_store = Store()
    app = Adapter(
        app_id="plan", app_name="Plan", entities={"tasks": {"module": "planning", "fields": plan_fields, "ownedBy": "owner"}},
        operations=ops, store=app_store, token="tok", modules=[{"name": "planning"}], allowed_origins=[origin],
        operation_runners={"clear-done": clear_done, "count": lambda a, c, s: {"n": 1}, "tag": lambda a, c, s: {"ok": True},
                           "move": lambda a, c, s: {}, "refuse": refuse, "explode": explode},
        events=[{"type": "task.needs_triage"}], clock=lambda: now[0],
    )
    tok = {"x-a2app-token": "tok"}

    def do(method, path, body=None, **headers):
        return app.dispatch(method, path, {**tok, **headers}, body)

    ident = app.identity()
    check(
        "identity: dataVersion and the server's real offset",
        [ident["dataVersion"], ident["serverTzOffsetMinutes"]],
        [f"{_base36(now[0])}.0", round(datetime.fromtimestamp(now[0] / 1000).astimezone().utcoffset().total_seconds() / 60)],
    )
    made = do("POST", "/api/collections/tasks/records", {"title": "One", "status": "todo"})
    check("a create succeeds and dataVersion moves", [made[0], app.identity()["dataVersion"]], [200, f"{_base36(now[0])}.1"])
    check("…a refused write does not move it", [do("POST", "/api/collections/tasks/records", {})[1]["code"], app.identity()["dataVersion"]], ["missing_required", f"{_base36(now[0])}.1"])
    check("…and it is audited", app_store.audit_tail(1)[0]["outcome"], "rejected")
    check("a body that is not an object is refused", [do("POST", "/api/collections/tasks/records", [])[1]["code"], do("POST", "/api/collections/tasks/records", ["x"])[1]["code"]],
          ["missing_required", "unknown_field"])
    rid = made[1]["id"]
    once = {"idempotency-key": "k1"}
    do("PATCH", f"/api/collections/tasks/records/{rid}", {"title": "Two"}, **once)
    check("a repeated update is duplicate_request", do("PATCH", f"/api/collections/tasks/records/{rid}", {"title": "Two"}, **once)[1]["code"], "duplicate_request")
    check("…its key scoped to that record, apart from creates", do("POST", "/api/collections/tasks/records", {"title": "Three"}, **once)[0], 200)
    bad = app.dispatch("GET", "/api/collections/tasks/records?filter=title%20~~%20x", tok, None)[1]
    check("…invalid_filter with the expression", [bad["code"], bad["got"]], ["invalid_filter", "title ~~ x"])
    do("POST", "/api/collections/tasks/records", {"title": "Blank status"})
    listed = lambda qs: app.dispatch("GET", "/api/collections/tasks/records?" + qs, tok, None)[1]  # noqa: E731
    check("sorting puts a blank first", [r.get("status") for r in listed("sort=status")["items"]][:1], [None])
    check(
        "paging reads its numbers as JavaScript does",
        [len(listed("perPage=0")["items"]), len(listed("perPage=abc")["items"]), len(listed("page=0&perPage=2")["items"]), len(listed("perPage=1.5")["items"])],
        [0, 0, 0, 1],
    )
    check("…and a page that is not a number is null on the wire", to_json(listed("page=abc")["page"]), "null")
    check("an escaped id is decoded, then looked up", do("GET", "/api/collections/tasks/records/no%20such")[1]["message"], 'No tasks record "no such".')
    check("…an escaped slash stays inside the id", do("GET", "/api/_a2app/describe/planning/tasks/a%2Fb")[1]["message"], 'No tasks record "a/b".')
    check("an escaped operation name is decoded", do("POST", "/api/ops/c%6Funt", {})[0], 200)
    check("a malformed escape is an adapter_error, in the envelope", do("GET", "/api/collections/tasks/records/%zz")[:2],
          (500, {"a2app": True, "ok": False, "code": "adapter_error", "message": "URI malformed: %zz"}))
    check("a path outside the adapter is the host app's", app.dispatch("GET", "/no-such-page", {}, None), None)
    check("…after the Host check", app.dispatch("GET", "/no-such-page", {"host": "evil.example"}, None)[1]["code"], "forbidden_host")
    check("a miss inside the adapter is its own 404", do("GET", "/api/_a2app/nope")[1]["code"], "not_found")
    check("the identity path tolerates a trailing slash", do("POST", "/.well-known/a2app.json/")[0], 200)

    check("an operation's required parameter is enforced", do("POST", "/api/ops/tag", {})[1]["code"], "missing_required")
    check("…an undeclared one refused", do("POST", "/api/ops/tag", {"task": rid, "x": 1})[1]["code"], "unknown_field")
    check("…a declared enum held to its values", do("POST", "/api/ops/tag", {"task": rid, "label": "c"})[1]["code"], "invalid_enum")
    asked = do("POST", "/api/ops/clear-done", {})
    check("a destructive operation asks for approval with the reference's key", [asked[0], asked[1]["approvalKey"]], [428, approval_key("clear-done", {})])
    check("…a key for another call does not run it", do("POST", "/api/ops/clear-done", {}, **{"x-a2app-approval": approval_key("clear-done", [])})[0], 428)
    do("POST", "/api/ops/clear-done", {})
    ran = do("POST", "/api/ops/clear-done", {}, **{"x-a2app-approval": asked[1]["approvalKey"]})
    check("…the right one runs it once", [ran[0], ran[1]["result"], do("POST", "/api/ops/clear-done", {}, **{"x-a2app-approval": asked[1]["approvalKey"]})[0]], [200, {"removed": 0}, 428])
    do("POST", "/api/ops/clear-done", {})
    now[0] += APPROVAL_TTL_MS + 1
    check("…and only within 10 minutes", do("POST", "/api/ops/clear-done", {}, **{"x-a2app-approval": asked[1]["approvalKey"]})[0], 428)
    do("POST", "/api/ops/count", {}, **{"idempotency-key": "op1"})
    check("a repeated operation is duplicate_request", do("POST", "/api/ops/count", {}, **{"idempotency-key": "op1"})[1], {
        "a2app": True, "ok": False, "code": "duplicate_request", "message": "This idempotency key already ran this operation.", "operation": "count"})
    check("a runner refuses with its own status and code", do("POST", "/api/ops/refuse", {})[:2],
          (409, {"a2app": True, "ok": False, "code": "over_quota", "message": "No more today.", "limit": 3}))
    check("…any other failure is operation_failed", do("POST", "/api/ops/explode", {})[1]["message"], 'Operation "explode" threw: boom')

    described = do("GET", f"/api/_a2app/describe/planning/tasks/{rid}")[1]
    check(
        "a record's operations name the parameter that takes the record, when exactly one does",
        {o["name"]: o.get("targetParam") for o in described["operations"]}, {"tag": "task", "move": None},
    )
    check("an unknown relation lists the real ones", do("GET", f"/api/_a2app/describe/planning/tasks/{rid}/nope")[1]["relations"], [])

    queued = app.trigger("task.needs_triage", {"task": rid}, "triage")["taskId"]
    task_wire = do("GET", f"/api/_a2app/tasks/{queued}")[1]
    check("a task names its app and starts with no progress", [task_wire["app"], task_wire["progress"]], ["plan", {"step": None, "percent": 0}])
    check("claiming as someone else is principal_mismatch", do("POST", f"/api/_a2app/tasks/{queued}/claim", {"agent": "someone"})[1]["code"], "principal_mismatch")
    check("…as yourself is fine", do("POST", f"/api/_a2app/tasks/{queued}/claim", {"agent": ADMIN_CREDENTIAL_ID})[1]["status"], "working")
    check("a percent is a number, never a boolean", do("POST", f"/api/_a2app/tasks/{queued}/progress", {"percent": True})[1]["progress"]["percent"], 0)
    check("an ask, even null, waits for input", do("POST", f"/api/_a2app/tasks/{queued}/progress", {"ask": None})[1]["status"], "input-required")
    check("a result of 0 is kept", do("POST", f"/api/_a2app/tasks/{queued}/complete", {"status": "completed", "result": 0})[1]["result"], 0)
    check("a finished task cannot be canceled", do("POST", f"/api/_a2app/tasks/{queued}/cancel", {})[1]["code"], "task_not_claimable")
    check("events name their app", {e["app"] for e in do("GET", "/api/_a2app/events")[1]["events"]}, {"plan"})
    check("a cursor that is not one reads from the beginning", do("GET", "/api/_a2app/events?since=%C2%B2")[1]["events"], do("GET", "/api/_a2app/events")[1]["events"])
    check("task actions are audited", [e["target"] for e in app_store.audit_tail(4)], ["task:claim", "task:progress", "task:progress", "task:complete"])

    app.dispatch("GET", "/api/_a2app", {"x-a2app-viewer": "tab-1"}, None)
    app.dispatch("GET", "/api/_a2app?viewer=tab-2", {}, None)
    check("an identity poll counts its viewer", do("GET", "/api/_a2app/viewers")[1], {"a2app": True, "viewers": 2, "ttlMs": VIEWER_TTL_MS})
    app.dispatch("GET", "/api/_a2app?viewer=tab-2&leaving=1", {}, None)
    now[0] += VIEWER_TTL_MS + 1
    check("…a goodbye or a minute's silence drops it", do("GET", "/api/_a2app/viewers")[1]["viewers"], 0)

    app.limiter = _RateLimiter({"data": 1, "ops": 1}, lambda: now[0])
    do("GET", "/api/collections/tasks/records")
    now[0] += 1_500
    limited = do("GET", "/api/collections/tasks/records")[1]
    check("over the limit: 429 with the wait rounded up", [limited["code"], limited["retryAfterSeconds"]], ["rate_limited", 59])
    check("…audited under the token's hash, never the token", app_store.audit_tail(1)[0]["credentialId"], "token:" + hash_secret("tok"))

    def root_of(count: int, query: str = "") -> dict:
        wide = Adapter(app_id="wide", app_name=None, entities={}, operations=[], store=Store(), token="t",
                       modules=[{"name": f"module-{i}", "summary": "a module with a summary of some length"} for i in range(count)])
        return wide.dispatch("GET", "/api/_a2app/describe" + query, {}, None)[1]

    shed = root_of(15)
    check("a root over budget sheds summaries before modules", [len(shed["modules"]), "summary" in shed["modules"][0], "truncated" in shed], [15, False, False])
    cut = root_of(80)
    check(
        "…then drops rows from the end, counted, within budget",
        [len(cut["modules"]) + cut["truncated"], cut["next"][-1], _level_size(cut) <= DESCRIBE_BUDGET_CHARS],
        [80, "describe?all=true", True],
    )
    check("…and ?all=true returns every one", [len(root_of(80, "?all=true")["modules"]), "summary" in root_of(80, "?all=true")["modules"][0]], [80, True])

    # 14. The account page, served with validators.
    page = b"<!doctype html>"
    served = static_reply("GET", {}, page, 1_700_000_000, "text/html; charset=utf-8")
    etag = served[1]["etag"]
    check("a file is served with an ETag and Last-Modified", [served[0], served[1]["last-modified"], served[2]], [200, "Tue, 14 Nov 2023 22:13:20 GMT", page])
    check(
        "…and a revalidation costs a bodyless 304",
        [static_reply("GET", {"if-none-match": f"W/{etag}"}, page, 1_700_000_000, "text/html")[0],
         static_reply("GET", {"if-none-match": '"other", *'}, page, 1_700_000_000, "text/html")[0],
         static_reply("GET", {"if-modified-since": "Tue, 14 Nov 2023 22:13:20 GMT"}, page, 1_700_000_000, "text/html")[0],
         static_reply("GET", {"if-none-match": '"other"', "if-modified-since": "Tue, 14 Nov 2023 22:13:20 GMT"}, page, 1_700_000_000, "text/html")[0]],
        [304, 304, 304, 200],
    )
    check("…GET and HEAD only", [static_reply("POST", {}, page, 0, "text/html")[0], static_reply("POST", {}, page, 0, "text/html")[1]["allow"]], [405, "GET, HEAD"])
    check(
        "the public URL is reduced to its origin, as a browser sends it",
        [policy(None, "https://crm.example.com:443/x")[1], policy(None, "https://u:p@crm.example.com:8443")[1], policy(None, "mailto:x")],
        ["https://crm.example.com", "https://crm.example.com:8443", "refused"],
    )

    if failures:
        print("a2app_adapter selftest FAILED:\n  - " + "\n  - ".join(failures))
        return 1
    print(
        "a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store, "
        "task queue, host and network policy, auth primitives, ceiling, ownership, accounts, device sign-in and "
        "confirmation, task credentials, JCS and approval keys, persistence across a restart, operation guard, "
        "idempotency, typed refusals, describe, decoding, viewers, rate limits, static files)"
    )
    return 0


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    print("a2app_adapter is a library; run main.py to serve. Use --selftest to check rules parity.")
