//! A2App adapter (SYSTEM-OWNED — hash-locked in the ownership canon).
//!
//! A native Rust port of the A2App served surface: identity, describe, whoami,
//! context, guarded records CRUD, declared operations (with approval for
//! destructive ops), and the app->agent task/event plane. It enforces the fixed
//! validation chain: origin -> credential -> scope -> guard -> backend ->
//! read-back. Records persist in SQLite (rusqlite with the bundled engine —
//! see `Store::sqlite`), so the live database is a real on-disk file inside the
//! toolkit's declared lifecycle dataDir.
//!
//! Protocol 0.2 (spec/v0_2/auth.md) adds who a request acts for: delegated
//! agent credentials stored only as hashes and always expiring, the user
//! ceiling (a credential never does more than its person may do now), and on
//! `authMode: multi-user` accounts, sessions, invites, record ownership and
//! device-code sign-in. Parity oracle: adapters/adapter-core/src (auth.ts,
//! accounts.ts, credentials.ts, device.ts, server.ts).
//!
//! The pure validation rules below MUST match `@a2app/rules` (behavioral
//! oracle: the python-fastapi blueprint's `a2app_adapter.py`) so a Rust app and
//! a Node app reject identical payloads identically — verified by the
//! conformance suite. HTTP wiring lives in `main.rs`; this file never touches
//! the network. An agent evolves the app by editing `schema.rs`, never this
//! file.
//!
//! Everything is plumbed as owned `serde_json::Value`s on serde_json's DEFAULT
//! map (BTreeMap-backed, keys sorted) — sorted keys are what makes the stable
//! JSON the fingerprint and approval key need trivial. Do not enable
//! `preserve_order`.

// The port is kept whole — every error code, and the app->agent trigger — even
// where this starter does not exercise a corner yet; dead-code warnings on a
// deliberately complete protocol surface would train readers to ignore them.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL};
use base64::Engine;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const RULES_VERSION: &str = "0.1.0";
pub const PROTOCOL_VERSION: &str = "0.2";
pub const ADAPTER_VERSION: &str = "0.1.0";

// Error codes — identical strings to ERROR_CODES in the python oracle and
// @a2app/rules. Every rejection envelope carries one of these.
pub const ERR_UNKNOWN_FIELD: &str = "unknown_field";
pub const ERR_READ_ONLY_FIELD: &str = "read_only_field";
pub const ERR_INVALID_DATE: &str = "invalid_date";
pub const ERR_INVALID_DAYKEY: &str = "invalid_daykey";
pub const ERR_INVALID_STRING: &str = "invalid_string";
pub const ERR_INVALID_NUMBER: &str = "invalid_number";
pub const ERR_INVALID_BOOLEAN: &str = "invalid_boolean";
pub const ERR_INVALID_ENUM: &str = "invalid_enum";
pub const ERR_NOT_STORED: &str = "not_stored";
pub const ERR_DUPLICATE_REQUEST: &str = "duplicate_request";
pub const ERR_APPROVAL_REQUIRED: &str = "approval_required";
pub const ERR_INSUFFICIENT_SCOPE: &str = "insufficient_scope";
pub const ERR_AMBIGUOUS_REF: &str = "ambiguous_ref";
pub const ERR_INVALID_EVENT: &str = "invalid_event";
pub const ERR_TASK_NOT_FOUND: &str = "task_not_found";
pub const ERR_TASK_NOT_CLAIMABLE: &str = "task_not_claimable";
pub const ERR_TASK_CANCELED: &str = "task_canceled";
pub const ERR_AGENT_TOKEN_REQUIRED: &str = "agent_token_required";
pub const ERR_RATE_LIMITED: &str = "rate_limited";
// The record is still referenced, and a `ref` pointing at it says `restrict`.
pub const ERR_RECORD_REFERENCED: &str = "record_referenced";

// What a `ref` does when nothing says otherwise: refuse the delete. Silently
// orphaning is the worse default — it is invisible at the moment it happens, and
// the app that has to cope with it is the one reading the record weeks later. A
// field opts out with `onDelete: "ignore"`.
//
// There is deliberately no `cascade` or `detach`: both would let one delete write
// to records the caller never named, which an agent cannot approve in advance and
// an audit log cannot explain afterwards. That belongs in a declared operation.
pub const DEFAULT_ON_DELETE: &str = "restrict";

// Page size for the referential scan a delete runs before it commits.
pub const REFERENCE_SCAN_PAGE: i64 = 500;
// How many blocking record ids are reported per field: the answer is "yes, and
// here are examples", not a dump of every row in the way.
pub const REFERENCE_SCAN_LIMIT: usize = 10;
// Hard stop on paging, so a store that ignores `page` cannot spin forever.
pub const REFERENCE_SCAN_MAX_PAGES: i64 = 200;

// A claimed task with no progress for this long is presumed abandoned and goes
// back to the queue, so a dead agent's work is redelivered rather than lost.
// Anything that delivers work from this queue (`agent-app <dir> bridge`)
// heartbeats well inside it; the value matches adapter-core.
pub const TASK_TIMEOUT_MS: i64 = 60_000;
// Redelivery is bounded: a task handed out this many times without finishing
// fails with `redelivery_exhausted` instead of cycling forever.
pub const TASK_MAX_DELIVERIES: u64 = 5;
/// A task in one of these states is over: its credential is dead, and none is
/// issued for it.
const TERMINAL_TASK: [&str; 3] = ["completed", "failed", "canceled"];

pub const DESCRIBE_BUDGET_CHARS: usize = 2000;

// --- principals, credentials, accounts (spec/v0_2/auth.md); the values are
// adapter-core's.

/// The account page every starter serves (`a2app-account.html`): sign in,
/// accept an invite, people, the agents acting for you, device approval.
pub const ACCOUNT_URL: &str = "/_a2app/account";
/// The app's administrator: the admin credential's principal, and the only
/// principal of an `authMode: none` app.
pub const OWNER: &str = "owner";
/// The admin credential's id: the app's own `.agent-token`.
const ADMIN_CREDENTIAL_ID: &str = "cred_local";
/// Said to an agent whose credential stopped working (revoked, expired, or its
/// person deactivated): a new one is the person's to give. A fact, never an
/// instruction — it lands in an agent's context.
const RENEW_HINT: &str = "Ask the person this agent acts for to approve it again (a2app <app> login), \
                          or the app's owner for a new credential.";

/// An issued credential's lifetime: 30 days unless asked, 60 s to 365 days.
pub const DEFAULT_EXPIRES_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const MIN_EXPIRES_SECONDS: i64 = 60;
pub const MAX_EXPIRES_SECONDS: i64 = 365 * 24 * 60 * 60;
/// A task credential's lifetime (spec §6.2); its task ending kills it sooner.
pub const TASK_CREDENTIAL_SECONDS: i64 = 60 * 60;
/// How long a revoked or expired credential is remembered, so its token is told
/// why it stopped rather than that it is unknown.
const GRANT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// `lastUsedAt` is written at most this often, so use is not a write per request.
const LAST_USED_RESOLUTION_MS: i64 = 60_000;

const SESSION_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const SIGN_IN_FAILURES: u32 = 10;
const SIGN_IN_WINDOW_MS: i64 = 15 * 60 * 1000;
const LOGIN_MAX: usize = 254;
const NAME_MAX: usize = 100;
const AGENT_NAME_MAX: usize = 100;

/// Device-code sign-in (spec §7): codes live 10 minutes; agents poll every 5 s,
/// and 5 s more each time they poll too soon.
const DEVICE_CODE_TTL_SECONDS: i64 = 600;
const DEVICE_POLL_INTERVAL_SECONDS: i64 = 5;
const DEVICE_SLOW_DOWN_STEP_SECONDS: i64 = 5;

/// One protocol reply: HTTP status plus the JSON payload.
pub type Reply = (u16, Value);

/// What [`Adapter::dispatch`] answers: a reply plus the headers it sets beyond
/// Content-Type — today only a session's `Set-Cookie`.
pub struct Answer {
    pub status: u16,
    pub json: Value,
    pub headers: Vec<(String, String)>,
}

// ------------------------------------------------------------ small helpers

/// Python truthiness for a JSON value — the oracle leans on `if x.get(...)` in
/// many places, so the port needs the same notion of "present and non-empty".
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}

fn get_str<'a>(v: &'a Value, key: &str) -> &'a str {
    get(v, key).as_str().unwrap_or("")
}

/// Python's `str()` for the JSON values that reach it in the oracle (enum
/// comparison, sort keys, blocker ids). Floats that carry no fraction render
/// "1.0" the way Python does; containers fall back to stable JSON — the oracle
/// would render Python repr there, but no declared vocabulary puts a container
/// through these paths.
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".to_string(),
        Value::Bool(b) => (if *b { "True" } else { "False" }).to_string(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 {
                    format!("{f:.1}")
                } else {
                    format!("{f}")
                }
            } else {
                n.to_string()
            }
        }
        Value::String(s) => s.clone(),
        other => stable_json(other),
    }
}

fn is_blank(v: &Value) -> bool {
    v.is_null() || v.as_str() == Some("")
}

// --------------------------------------------------------------- pure rules

const MONTH_DAYS: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

fn valid_ymd(y: i64, m: u32, d: u32) -> bool {
    if !(1..=12).contains(&m) || d < 1 {
        return false;
    }
    let mut mx = MONTH_DAYS[(m - 1) as usize];
    if m == 2 && y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
        mx = 29;
    }
    d <= mx
}

/// Hand-rolled equivalent of the oracle's `_DATE_RE`:
/// `^(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$`
/// plus the calendar check. Hand-parsed so the stack needs no regex crate.
pub fn looks_like_date(v: &Value) -> bool {
    let s = match v.as_str() {
        Some(s) => s,
        None => return false,
    };
    let b = s.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        if from + n > b.len() || !b[from..from + n].iter().all(u8::is_ascii_digit) {
            return None;
        }
        s[from..from + n].parse().ok()
    };
    let (y, m, d) = match (digits(0, 4), b.get(4), digits(5, 2), b.get(7), digits(8, 2)) {
        (Some(y), Some(&b'-'), Some(m), Some(&b'-'), Some(d)) => (y, m as u32, d as u32),
        _ => return false,
    };
    let mut i = 10;
    // Optional time part: [ T]HH:MM, then optionally :SS, then optionally .frac.
    if matches!(b.get(i), Some(&b' ') | Some(&b'T')) && digits(i + 1, 2).is_some() {
        if b.get(i + 3) != Some(&b':') || digits(i + 4, 2).is_none() {
            return false;
        }
        i += 6;
        if b.get(i) == Some(&b':') {
            if digits(i + 1, 2).is_none() {
                return false;
            }
            i += 3;
            if b.get(i) == Some(&b'.') {
                let start = i + 1;
                let mut j = start;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    return false;
                }
                i = j;
            }
        }
    }
    // Optional whitespace, then an optional zone (Z, +HH:MM or +HHMM), then end.
    while i < b.len() && (b[i] as char).is_ascii_whitespace() {
        i += 1;
    }
    if i < b.len() {
        if b[i] == b'Z' {
            i += 1;
        } else if b[i] == b'+' || b[i] == b'-' {
            if digits(i + 1, 2).is_none() {
                return false;
            }
            i += 3;
            if b.get(i) == Some(&b':') {
                i += 1;
            }
            if digits(i, 2).is_none() {
                return false;
            }
            i += 2;
        } else {
            return false;
        }
    }
    i == b.len() && valid_ymd(y, m, d)
}

/// `^\d{4}-\d{2}-\d{2}$` plus the calendar check.
pub fn is_day_key_value(v: &Value) -> bool {
    let s = match v.as_str() {
        Some(s) => s,
        None => return false,
    };
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let ok = b[0..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit);
    if !ok {
        return false;
    }
    let y: i64 = s[0..4].parse().unwrap_or(0);
    let m: u32 = s[5..7].parse().unwrap_or(0);
    let d: u32 = s[8..10].parse().unwrap_or(0);
    valid_ymd(y, m, d)
}

fn violation(code: &str, field: &str, expected: String, got: &Value) -> Value {
    json!({ "code": code, "field": field, "expected": expected, "got": got })
}

fn is_number_string(s: &str) -> bool {
    // Mirrors Python's float(): leading/trailing whitespace tolerated.
    !s.trim().is_empty() && s.trim().parse::<f64>().is_ok()
}

/// Validate a RAW body against normalized fields; returns every violation.
///
/// One quirk is ported deliberately: the oracle's number check is
/// `isinstance(value, (int, float))`, and a Python bool IS an int — so a JSON
/// boolean passes a `number` field's guard there, and it passes here too.
pub fn validate(fields: &Value, body: &Value, allow: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    let body_map = body.as_object().unwrap_or(&empty);
    let field_list: Vec<&Value> = fields.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let by_name: HashMap<&str, &Value> = field_list.iter().map(|f| (get_str(f, "name"), *f)).collect();
    let writable: Vec<&str> = field_list
        .iter()
        .filter(|f| !truthy(get(f, "readOnly")))
        .map(|f| get_str(f, "name"))
        .collect();
    let mut out = Vec::new();
    for (key, value) in body_map {
        if allow.map_or(false, |a| truthy(get(a, key))) {
            continue;
        }
        let f = match by_name.get(key.as_str()) {
            Some(f) => *f,
            None => {
                out.push(violation(ERR_UNKNOWN_FIELD, key, format!("one of: {}", writable.join(", ")), value));
                continue;
            }
        };
        if truthy(get(f, "readOnly")) {
            out.push(violation(ERR_READ_ONLY_FIELD, key, "not writable (server-managed)".to_string(), value));
            continue;
        }
        if is_blank(value) {
            continue;
        }
        let ftype = get_str(f, "type");
        let values = get(f, "values");
        if ftype == "datetime" && !looks_like_date(value) {
            out.push(violation(ERR_INVALID_DATE, key, "an ISO 8601 date".to_string(), value));
        } else if truthy(get(f, "dayKey")) && !is_day_key_value(value) {
            out.push(violation(ERR_INVALID_DAYKEY, key, "a day key \"YYYY-MM-DD\"".to_string(), value));
        } else if ftype == "string" && !value.is_string() {
            out.push(violation(ERR_INVALID_STRING, key, "text".to_string(), value));
        } else if ftype == "number"
            && !value.is_number()
            && !value.is_boolean()
            && !value.as_str().map_or(false, is_number_string)
        {
            out.push(violation(ERR_INVALID_NUMBER, key, "a number".to_string(), value));
        } else if ftype == "boolean"
            && !value.is_boolean()
            && value.as_str() != Some("true")
            && value.as_str() != Some("false")
        {
            out.push(violation(ERR_INVALID_BOOLEAN, key, "true or false".to_string(), value));
        } else if ftype == "enum" && truthy(values) {
            let allowed: Vec<String> = values.as_array().map(|a| a.iter().map(py_str).collect()).unwrap_or_default();
            if !allowed.contains(&py_str(value)) {
                out.push(violation(ERR_INVALID_ENUM, key, format!("one of: {}", allowed.join(" | ")), value));
            }
        } else if ftype == "list<enum>" && truthy(values) {
            let allowed: Vec<String> = values.as_array().map(|a| a.iter().map(py_str).collect()).unwrap_or_default();
            let items: Vec<&Value> = match value.as_array() {
                Some(a) => a.iter().collect(),
                None => vec![value],
            };
            if items.iter().any(|i| !allowed.contains(&py_str(i))) {
                out.push(violation(ERR_INVALID_ENUM, key, format!("each of: {}", allowed.join(" | ")), value));
            }
        }
    }
    out
}

/// Read-back backstop: which non-blank requested values failed to land?
pub fn divergences<F: Fn(&str) -> Value>(fields: &Value, body: &Value, read: F) -> Vec<Value> {
    let empty = Map::new();
    let body_map = body.as_object().unwrap_or(&empty);
    let field_list: Vec<&Value> = fields.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let by_name: HashMap<&str, &Value> = field_list.iter().map(|f| (get_str(f, "name"), *f)).collect();
    let mut out = Vec::new();
    for (key, requested) in body_map {
        let f = match by_name.get(key.as_str()) {
            Some(f) if !truthy(get(f, "readOnly")) => *f,
            _ => continue,
        };
        if is_blank(requested) {
            continue;
        }
        let stored = read(key);
        if is_blank(&stored) {
            out.push(json!({ "field": key, "type": get_str(f, "type"), "stored": py_str(&stored) }));
        }
    }
    out
}

pub fn label_field_of(fields: &Value) -> Option<String> {
    let list = fields.as_array()?;
    let names: Vec<&str> = list.iter().map(|f| get_str(f, "name")).collect();
    for pref in ["title", "name", "label"] {
        if names.contains(&pref) {
            return Some(pref.to_string());
        }
    }
    for f in list {
        if get_str(f, "type") == "string" && truthy(get(f, "required")) && !truthy(get(f, "readOnly")) {
            return Some(get_str(f, "name").to_string());
        }
    }
    None
}

/// Every published attribute of a field, rendered deterministically.
///
/// Must match `fieldPrint` in @a2app/rules exactly: a client that caches
/// describe against this value is told never to write against a stale schema,
/// so narrowing an enum or tightening a max has to move the hash.
fn field_print(f: &Value) -> String {
    let mut parts = vec![format!("{}:{}", get_str(f, "name"), get_str(f, "type"))];
    if truthy(get(f, "required")) {
        parts.push("req".to_string());
    }
    if truthy(get(f, "readOnly")) {
        parts.push("ro".to_string());
    }
    if truthy(get(f, "writeOnly")) {
        parts.push("wo".to_string());
    }
    if truthy(get(f, "dayKey")) {
        parts.push("day".to_string());
    }
    if !get(f, "max").is_null() {
        parts.push(format!("max={}", py_str(get(f, "max"))));
    }
    if truthy(get(f, "entity")) {
        parts.push(format!("entity={}", get_str(f, "entity")));
    }
    if truthy(get(f, "values")) {
        let mut vals: Vec<String> = get(f, "values")
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap_or_default().to_string()).collect())
            .unwrap_or_default();
        vals.sort();
        parts.push(format!("values={}", vals.join("|")));
    }
    parts.join(":")
}

/// JSON with keys sorted at every depth, so declaration order cannot move the
/// hash. serde_json's default map is sorted, so plain serialization IS the
/// stable form — the reason this port must never enable `preserve_order`.
pub fn stable_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn operation_print(o: &Value) -> String {
    let mut flags = String::new();
    for (c, k) in [("d", "destructive"), ("r", "readOnly"), ("i", "idempotent")] {
        if truthy(get(o, k)) {
            flags.push_str(c);
        }
    }
    let name = get_str(o, "name");
    let mut parts = vec![if flags.is_empty() { name.to_string() } else { format!("{name}:{flags}") }];
    if truthy(get(o, "module")) {
        parts.push(format!("mod={}", get_str(o, "module")));
    }
    if truthy(get(o, "entity")) {
        parts.push(format!("on={}", get_str(o, "entity")));
    }
    if truthy(get(o, "params")) {
        parts.push(format!("params={}", stable_json(get(o, "params"))));
    }
    if truthy(get(o, "appliesWhen")) {
        parts.push(format!("when={}", stable_json(get(o, "appliesWhen"))));
    }
    parts.join(":")
}

/// Stable fingerprint of everything describe publishes.
///
/// Parity oracle: @a2app/rules `schemaFingerprint`. `entities` maps a name to
/// `{"fields": [...], "module": str, "auth"?: bool}`. `module` is required for
/// the same reason it is required there: an entity that could move between
/// modules without moving the hash would leave caches placing it in the old
/// one. The hash is djb2-xor over Unicode scalar values, matching Python's
/// `ord` and the JS `codePointAt` walk.
pub fn schema_fingerprint(entities: &Value, operations: Option<&Value>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(map) = entities.as_object() {
        for (name, value) in map {
            let mut prints: Vec<String> = get(value, "fields")
                .as_array()
                .map(|a| a.iter().map(field_print).collect())
                .unwrap_or_default();
            prints.sort();
            let mut attrs = vec![format!("{}({})", name, prints.join(","))];
            if truthy(get(value, "auth")) {
                attrs.push("auth".to_string());
            }
            attrs.push(format!("mod={}", get_str(value, "module")));
            parts.push(attrs.join(":"));
        }
    }
    parts.sort();
    let mut ops: Vec<String> = operations
        .and_then(Value::as_array)
        .map(|a| a.iter().map(operation_print).collect())
        .unwrap_or_default();
    ops.sort();
    let joined = format!("{}|{}", parts.join(";"), ops.join(","));
    let mut h: u32 = 5381;
    for ch in joined.chars() {
        h = h.wrapping_mul(33) ^ (ch as u32);
    }
    format!("sv_{h:x}")
}

// -- availability predicates (A2APP-SPEC 3.4) -------------------------------
// Parity oracle: adapters/rules/src/predicate.ts. Same predicate + same record
// must yield the same availability and the same blocked reason on every stack.

/// Read a value as its field's DECLARED type.
///
/// A backend is only obliged to return what it stored, so `done: "true"` and
/// `done: true` are the same boolean. Deciding from the runtime type instead
/// would make availability depend on the storage engine.
fn as_declared(value: &Value, declared_type: Option<&str>) -> Value {
    if is_blank(value) {
        return Value::Null;
    }
    match declared_type {
        Some("boolean") => match value {
            Value::Bool(_) => value.clone(),
            Value::String(s) if s == "true" => Value::Bool(true),
            Value::String(s) if s == "false" => Value::Bool(false),
            _ => value.clone(),
        },
        Some("number") => match value {
            Value::Bool(_) | Value::Number(_) => value.clone(),
            Value::String(s) => match s.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64) {
                Some(n) => Value::Number(n),
                None => value.clone(),
            },
            _ => value.clone(),
        },
        _ => value.clone(),
    }
}

fn same_value(a: &Value, b: &Value) -> bool {
    if a.is_array() || a.is_object() || b.is_array() || b.is_object() {
        return stable_json(a) == stable_json(b);
    }
    if a.is_boolean() != b.is_boolean() {
        return false;
    }
    if let (Some(x), Some(y)) = (a.as_f64(), b.as_f64()) {
        return x == y;
    }
    a == b
}

fn field_type<'a>(index: &'a HashMap<&str, &Value>, name: &str) -> Option<&'a str> {
    index.get(name).map(|f| get_str(f, "type"))
}

fn read_field(record: &Value, name: &str, index: &HashMap<&str, &Value>) -> Value {
    as_declared(get(record, name), field_type(index, name))
}

fn field_index(fields: &Value) -> HashMap<&str, &Value> {
    fields
        .as_array()
        .map(|a| a.iter().map(|f| (get_str(f, "name"), f)).collect())
        .unwrap_or_default()
}

pub fn evaluate_predicate(predicate: &Value, record: &Value, fields: &Value) -> bool {
    evaluate(predicate, record, &field_index(fields))
}

fn evaluate(p: &Value, record: &Value, index: &HashMap<&str, &Value>) -> bool {
    if let Some(all) = p.get("all").and_then(Value::as_array) {
        return all.iter().all(|sub| evaluate(sub, record, index));
    }
    if let Some(any) = p.get("any").and_then(Value::as_array) {
        return any.iter().any(|sub| evaluate(sub, record, index));
    }
    if let Some(not) = p.get("not") {
        return !evaluate(not, record, index);
    }

    let field = get_str(p, "field");
    let actual = read_field(record, field, index);
    let declared = field_type(index, field);
    if let Some(is_blank_flag) = p.get("isBlank").and_then(Value::as_bool) {
        return actual.is_null() == is_blank_flag;
    }
    if let Some(eq) = p.get("eq") {
        return same_value(&actual, &as_declared(eq, declared));
    }
    if let Some(ne) = p.get("ne") {
        return !same_value(&actual, &as_declared(ne, declared));
    }
    if let Some(candidates) = p.get("in").and_then(Value::as_array) {
        return candidates.iter().any(|c| same_value(&actual, &as_declared(c, declared)));
    }
    if let Some(candidates) = p.get("notIn").and_then(Value::as_array) {
        return !candidates.iter().any(|c| same_value(&actual, &as_declared(c, declared)));
    }
    // Unrecognised form: refuse rather than default to available. An unknown
    // condition must never silently unblock an action.
    false
}

fn render_value(v: &Value) -> String {
    match v {
        Value::Null => "blank".to_string(),
        Value::String(s) => format!("\"{s}\""),
        Value::Array(_) | Value::Object(_) => stable_json(v),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Every field name a predicate reads, for declaration-time validation.
fn predicate_fields(predicate: &Value) -> Vec<String> {
    fn collect(p: &Value, out: &mut Vec<String>) {
        if let Some(all) = p.get("all").and_then(Value::as_array) {
            for sub in all {
                collect(sub, out);
            }
        } else if let Some(any) = p.get("any").and_then(Value::as_array) {
            for sub in any {
                collect(sub, out);
            }
        } else if let Some(not) = p.get("not") {
            collect(not, out);
        } else {
            let field = get_str(p, "field");
            if !field.is_empty() && !out.iter().any(|f| f.as_str() == field) {
                out.push(field.to_string());
            }
        }
    }
    let mut out = Vec::new();
    collect(predicate, &mut out);
    out
}

fn render_list(values: &[Value]) -> String {
    let parts: Vec<String> = values.iter().map(render_value).collect();
    if parts.len() <= 1 {
        return parts.join("");
    }
    format!("{} or {}", parts[..parts.len() - 1].join(", "), parts[parts.len() - 1])
}

/// Why this predicate does not hold, derived — never composed by a model.
pub fn explain_predicate(predicate: &Value, record: &Value, fields: &Value) -> String {
    let index = field_index(fields);
    if evaluate(predicate, record, &index) {
        return "the condition holds".to_string();
    }
    explain(predicate, record, &index)
}

fn explain(p: &Value, record: &Value, index: &HashMap<&str, &Value>) -> String {
    if let Some(all) = p.get("all").and_then(Value::as_array) {
        for sub in all {
            if !evaluate(sub, record, index) {
                return explain(sub, record, index);
            }
        }
        return "the condition holds".to_string();
    }
    if let Some(any) = p.get("any").and_then(Value::as_array) {
        return match any.first() {
            Some(first) => explain(first, record, index),
            None => "no condition is satisfiable".to_string(),
        };
    }
    if let Some(inner) = p.get("not") {
        if let Some(is_blank_flag) = inner.get("isBlank").and_then(Value::as_bool) {
            let field = get_str(inner, "field");
            return if is_blank_flag { format!("{field} is blank") } else { format!("{field} is set") };
        }
        if inner.get("eq").is_some() {
            let field = get_str(inner, "field");
            return format!("{} is {}", field, render_value(&read_field(record, field, index)));
        }
        return "the condition is not met".to_string();
    }

    let field = get_str(p, "field");
    let actual = read_field(record, field, index);
    if let Some(is_blank_flag) = p.get("isBlank").and_then(Value::as_bool) {
        if is_blank_flag {
            return format!("{} is set to {}, not blank", field, render_value(&actual));
        }
        return format!("{field} is blank");
    }
    if let Some(eq) = p.get("eq") {
        return format!("{} is {}, not {}", field, render_value(&actual), render_value(eq));
    }
    if p.get("ne").is_some() {
        return format!("{} is {}", field, render_value(&actual));
    }
    if let Some(candidates) = p.get("in").and_then(Value::as_array) {
        return format!("{} is {}, not {}", field, render_value(&actual), render_list(candidates));
    }
    if p.get("notIn").is_some() {
        return format!("{} is {}", field, render_value(&actual));
    }
    "the condition is not met".to_string()
}

pub fn describe_violation(v: &Value, server_now: Option<&str>) -> String {
    let code = get_str(v, "code");
    let mut msg = format!(
        "Rejected by a2app ({code}): field \"{}\" expects {}; got {}",
        get_str(v, "field"),
        get_str(v, "expected"),
        serde_json::to_string(get(v, "got")).unwrap_or_default()
    );
    if let Some(now) = server_now {
        if code == ERR_INVALID_DATE || code == ERR_INVALID_DAYKEY {
            msg.push_str(&format!(". Example: \"{}\"", &now[..10.min(now.len())]));
        }
        msg.push_str(&format!(". Server time is {now}"));
    }
    msg + "."
}

pub fn describe_incomplete(lost: &[Value]) -> String {
    let names: Vec<&str> = lost.iter().map(|l| get_str(l, "field")).collect();
    format!(
        "Rejected by a2app (not_stored): the database did not store {}. Do NOT report this as done.",
        names.join(", ")
    )
}

// --------------------------------------------------------------- rate limiter

// data 1200/min, ops 300/min — per-caller fixed windows.
const RATE_LIMIT_DATA: u32 = 1200;
const RATE_LIMIT_OPS: u32 = 300;

struct RateDecision {
    allowed: bool,
    limit: u32,
    retry_after_seconds: u64,
}

struct RateLimiter {
    limits: HashMap<String, u32>,
    windows: HashMap<(String, String), (u64, u32)>,
}

impl RateLimiter {
    fn new() -> Self {
        let mut limits = HashMap::new();
        limits.insert("data".to_string(), RATE_LIMIT_DATA);
        limits.insert("ops".to_string(), RATE_LIMIT_OPS);
        RateLimiter { limits, windows: HashMap::new() }
    }

    fn check(&mut self, caller: &str, class: &str) -> RateDecision {
        let limit = *self.limits.get(class).unwrap_or(&0);
        if limit == 0 {
            return RateDecision { allowed: true, limit, retry_after_seconds: 0 };
        }
        let now = now_ms();
        let key = (caller.to_string(), class.to_string());
        let (mut ws, mut count) = *self.windows.get(&key).unwrap_or(&(now, 0));
        if now.saturating_sub(ws) >= 60_000 {
            ws = now;
            count = 0;
        }
        count += 1;
        self.windows.insert(key, (ws, count));
        if count > limit {
            let retry = (60_000u64.saturating_sub(now - ws)) / 1000;
            return RateDecision { allowed: false, limit, retry_after_seconds: retry.max(1) };
        }
        RateDecision { allowed: true, limit, retry_after_seconds: 0 }
    }
}

// ----------------------------------------------------------------- time

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Days-since-epoch to (year, month, day) — Howard Hinnant's civil-from-days,
/// so the stack needs no chrono.
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (year, month, day) to days-since-epoch — the inverse, for parsing
/// If-Modified-Since in the static handler.
pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

/// ISO 8601 UTC with milliseconds, "…Z" — what the oracle's `_now_iso` emits.
pub fn now_iso() -> String {
    iso_of_ms(epoch_ms_now())
}

/// Epoch milliseconds as ISO 8601 UTC with milliseconds (JS `toISOString`).
fn iso_of_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let (y, m, day) = civil_from_days(secs.div_euclid(86_400));
    let tod = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Milliseconds since the epoch, now.
fn epoch_ms_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Parse what `now_iso` emits ("YYYY-MM-DDTHH:MM:SS.mmmZ") back to epoch
/// milliseconds; None for anything else.
fn iso_epoch_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 24
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[23] != b'Z'
    {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se, ms) = (num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    let days = days_from_civil(y, mo as u32, d as u32);
    Some((days * 86_400 + h * 3600 + mi * 60 + se) * 1000 + ms)
}

// ----------------------------------------------------------------- entropy

/// `n` bytes from the operating system's CSPRNG. Every secret this app hands
/// out comes from here; a machine that cannot supply randomness cannot serve
/// safely, so failing loudly is the only honest answer.
fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).expect("the operating system's random source failed");
    buf
}

/// `n` random bytes as lowercase hex (record ids, the app's `.agent-token`).
pub fn random_hex(n: usize) -> String {
    hex_of(&random_bytes(n))
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/* ------------------------------------------------------------ secrets
 *
 * The security primitives behind accounts, sessions, invites, device codes and
 * credentials (spec/v0_2/auth.md; oracle: adapter-core auth.ts). Every secret
 * the app hands out (tokens, session ids, invite codes, device codes) is 256
 * random bits, returned once, and stored only as its SHA-256. Passwords are
 * PBKDF2-SHA256 at 600 000 iterations (OWASP), compared in constant time.
 */

/// 256 random bits, base64url (43 chars).
pub fn new_secret() -> String {
    BASE64URL.encode(random_bytes(32))
}

/// An agent credential token: `a2a_` + 256 random bits.
pub fn new_token() -> String {
    format!("a2a_{}", new_secret())
}

/// How a secret is stored and looked up: hex SHA-256 of the whole string.
pub fn hash_secret(secret: &str) -> String {
    hex_of(&Sha256::digest(secret.as_bytes()))
}

/// An id that is not a secret: `prefix_` + 64 random bits, hex.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", random_hex(8))
}

pub const PBKDF2_ITERATIONS: u32 = 600_000;
const PBKDF2_KEY_BYTES: usize = 32;
const PBKDF2_SALT_BYTES: usize = 16;
pub const PASSWORD_MIN: usize = 10;
pub const PASSWORD_MAX: usize = 256;

/// `pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>` — byte-compatible with
/// adapter-core's `hashPassword`, so an account store moves between stacks.
pub fn hash_password(password: &str, iterations: u32) -> String {
    let salt = random_bytes(PBKDF2_SALT_BYTES);
    let mut key = [0u8; PBKDF2_KEY_BYTES];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut key);
    format!("pbkdf2_sha256${iterations}${}${}", BASE64.encode(&salt), BASE64.encode(key))
}

/// Constant-time check of `password` against a stored hash. A malformed hash
/// never matches.
pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2_sha256" {
        return false;
    }
    let Some(iterations) = parts[1].parse::<u32>().ok().filter(|i| *i >= 1) else { return false };
    let (Ok(salt), Ok(expected)) = (BASE64.decode(parts[2]), BASE64.decode(parts[3])) else { return false };
    if expected.is_empty() {
        return false;
    }
    let mut actual = vec![0u8; expected.len()];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut actual);
    actual.ct_eq(&expected).into()
}

/// Consonants only (RFC 8628 §6.1): no vowels, so no words; no look-alikes.
const USER_CODE_ALPHABET: &str = "BCDFGHJKLMNPQRSTVWXZ";

/// `XXXX-XXXX` from [`USER_CODE_ALPHABET`], each letter uniform.
pub fn new_user_code() -> String {
    let alphabet = USER_CODE_ALPHABET.as_bytes();
    // Rejection sampling: 240 is the largest multiple of 20 a byte reaches, so
    // `% 20` over the bytes below it favours no letter.
    let limit = (256 / alphabet.len() * alphabet.len()) as u8;
    let mut letters = String::with_capacity(9);
    while letters.len() < 8 {
        for b in random_bytes(16) {
            if b < limit && letters.len() < 8 {
                letters.push(alphabet[b as usize % alphabet.len()] as char);
            }
        }
    }
    format!("{}-{}", &letters[..4], &letters[4..])
}

/// A user code as typed: case and the dash do not matter. "" when it cannot be
/// one.
pub fn normalize_user_code(input: &str) -> String {
    let letters: String = input.to_uppercase().chars().filter(|c| USER_CODE_ALPHABET.contains(*c)).collect();
    if letters.len() == 8 {
        format!("{}-{}", &letters[..4], &letters[4..])
    } else {
        String::new()
    }
}

/// A login as stored and compared: trimmed, lower-cased.
pub fn normalize_login(login: &str) -> String {
    login.trim().to_lowercase()
}

/// A string's length as JavaScript counts it (UTF-16 code units), so a limit
/// means the same on every stack.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/* ------------------------------------------------------------ cookies */

/// `decodeURIComponent`: None for a malformed escape or bytes that are not
/// UTF-8, which is not a value this app wrote.
fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let pair = s.get(i + 1..i + 3).filter(|p| p.bytes().all(|c| c.is_ascii_hexdigit()))?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `Cookie` header -> name/value pairs (the first occurrence of a name wins).
pub fn parse_cookies(header: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for part in header.split(';') {
        let Some(eq) = part.find('=').filter(|eq| *eq > 0) else { continue };
        let name = part[..eq].trim().to_string();
        if out.contains_key(&name) {
            continue;
        }
        if let Some(value) = decode_uri_component(part[eq + 1..].trim()) {
            out.insert(name, value);
        }
    }
    out
}

/// A `Set-Cookie` value for the session cookie. `max_age_seconds: 0` clears it.
pub fn session_cookie(name: &str, value: &str, max_age_seconds: i64, secure: bool) -> String {
    let mut attrs = vec![
        format!("{name}={}", encode_uri_component(value)),
        "Path=/".to_string(),
        "HttpOnly".to_string(),
        "SameSite=Lax".to_string(),
        format!("Max-Age={max_age_seconds}"),
    ];
    if secure {
        attrs.push("Secure".to_string());
    }
    attrs.join("; ")
}

/* -------------------------------------------------- failure limiting */

/// Counts failures per key in a fixed window (sign-in failures per login). In
/// memory: a restart forgets them, which costs an attacker nothing they could
/// not get by waiting out the window. The clock is passed in, so the rule is
/// testable.
pub struct FailureLimiter {
    max: u32,
    window_ms: i64,
    windows: HashMap<String, (u32, i64)>,
}

impl FailureLimiter {
    pub fn new(max: u32, window_ms: i64) -> Self {
        FailureLimiter { max, window_ms, windows: HashMap::new() }
    }

    /// Seconds until `key` may try again, or 0 when it may now.
    pub fn retry_after(&mut self, key: &str, now: i64) -> i64 {
        let Some(&(count, start)) = self.windows.get(key) else { return 0 };
        let elapsed = now - start;
        if elapsed >= self.window_ms {
            self.windows.remove(key);
            return 0;
        }
        if count >= self.max {
            (self.window_ms - elapsed + 999) / 1000
        } else {
            0
        }
    }

    pub fn fail(&mut self, key: &str, now: i64) {
        match self.windows.get_mut(key) {
            Some((count, start)) if now - *start < self.window_ms => *count += 1,
            _ => {
                self.windows.insert(key.to_string(), (1, now));
            }
        }
    }

    pub fn reset(&mut self, key: &str) {
        self.windows.remove(key);
    }
}

/* --------------------------------------------------- grant requests */

/// The optional agent name a caller gave a credential, checked: absent or
/// null is none; otherwise 1–100 characters, trimmed.
pub fn parse_agent_name(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if !name.trim().is_empty() && js_len(name) <= AGENT_NAME_MAX => {
            Ok(Some(name.trim().to_string()))
        }
        Some(_) => Err(format!("agentName is 1–{AGENT_NAME_MAX} characters.")),
    }
}

/// The scopes and lifetime a caller asked for, checked; or the reason they
/// cannot be granted. `scopes` defaults to `*`; every entry must be `*` or a
/// scope the app declares. Duplicates collapse, first occurrence kept.
pub fn parse_grant_request(body: &Value, declared: &BTreeSet<String>) -> Result<(Vec<String>, i64), String> {
    let scopes = match body.get("scopes").filter(|s| !s.is_null()) {
        None => vec!["*".to_string()],
        Some(Value::Array(list)) if !list.is_empty() && list.iter().all(Value::is_string) => {
            list.iter().map(py_str).collect()
        }
        Some(_) => return Err("scopes is a non-empty list of scope names (or [\"*\"]).".to_string()),
    };
    let unknown: Vec<&str> =
        scopes.iter().map(String::as_str).filter(|s| *s != "*" && !declared.contains(*s)).collect();
    if !unknown.is_empty() {
        return Err(format!("Not scopes this app declares: {}.", unknown.join(", ")));
    }
    let expires_in = match body.get("expiresIn").filter(|e| !e.is_null()) {
        None => Some(DEFAULT_EXPIRES_SECONDS),
        // A whole number of seconds, however JSON spelled it (3600 or 3600.0).
        Some(v) => v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64),
    };
    let Some(expires_in) = expires_in.filter(|e| (MIN_EXPIRES_SECONDS..=MAX_EXPIRES_SECONDS).contains(e)) else {
        return Err(format!(
            "expiresIn is a whole number of seconds from {MIN_EXPIRES_SECONDS} to {MAX_EXPIRES_SECONDS} (365 days)."
        ));
    };
    let mut unique: Vec<String> = Vec::with_capacity(scopes.len());
    for s in scopes {
        if !unique.contains(&s) {
            unique.push(s);
        }
    }
    Ok((unique, expires_in))
}

// ------------------------------------------------------------------- store

/// Raised when a `filter` expression falls outside the single-clause grammar.
#[derive(Debug)]
pub struct UnsupportedFilter {
    pub expression: String,
}

impl fmt::Display for UnsupportedFilter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "filter expression is not supported by this backend: {}", self.expression)
    }
}

impl std::error::Error for UnsupportedFilter {}

fn filter_str(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => (if *b { "true" } else { "false" }).to_string(),
        Value::String(s) => s.clone(),
        Value::Number(_) => py_str(value),
        other => stable_json(other),
    }
}

/// The single-clause filter grammar this backend implements — `field = "v"`,
/// `field != "v"`, or `field ~ "v"` (contains), optionally wrapped in one pair
/// of parentheses; the value double-quoted (with backslash escapes),
/// single-quoted, or bare. Enough for label->id resolution; a richer backend
/// exposes its own query language. Anything outside it is REFUSED, never
/// ignored: a store that accepts `filter` and returns unfiltered rows answers
/// 200 with the wrong records, which turns every label lookup into a false
/// multi-match. Hand-parsed so the stack needs no regex crate; parity with the
/// oracle's `_FILTER_RE`.
fn match_filter(expr: &str) -> Result<(String, String, String), UnsupportedFilter> {
    let unsupported = || UnsupportedFilter { expression: expr.to_string() };
    let b = expr.as_bytes();
    let mut i = 0usize;
    let skip_ws = |i: &mut usize| {
        while *i < b.len() && (b[*i] as char).is_ascii_whitespace() {
            *i += 1;
        }
    };
    skip_ws(&mut i);
    if b.get(i) == Some(&b'(') {
        i += 1;
        skip_ws(&mut i);
    }
    // Identifier: [A-Za-z_]\w*
    let start = i;
    if i >= b.len() || !(b[i].is_ascii_alphabetic() || b[i] == b'_') {
        return Err(unsupported());
    }
    i += 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    let field = expr[start..i].to_string();
    skip_ws(&mut i);
    // Operator: != before =, then ~.
    let op = if b.get(i) == Some(&b'!') && b.get(i + 1) == Some(&b'=') {
        i += 2;
        "!="
    } else if b.get(i) == Some(&b'=') {
        i += 1;
        "="
    } else if b.get(i) == Some(&b'~') {
        i += 1;
        "~"
    } else {
        return Err(unsupported());
    };
    skip_ws(&mut i);
    // Value: double-quoted with escapes, single-quoted, or bare.
    let value: String;
    if b.get(i) == Some(&b'"') {
        i += 1;
        let mut out = String::new();
        loop {
            let rest = &expr[i..];
            let ch = rest.chars().next().ok_or_else(unsupported)?;
            if ch == '"' {
                i += 1;
                break;
            }
            if ch == '\\' {
                // Only the double-quoted form carries escapes; unescape exactly
                // what the escaping side wrote (backslash-x -> x).
                let escaped = expr[i + 1..].chars().next().ok_or_else(unsupported)?;
                out.push(escaped);
                i += 1 + escaped.len_utf8();
            } else {
                out.push(ch);
                i += ch.len_utf8();
            }
        }
        value = out;
    } else if b.get(i) == Some(&b'\'') {
        i += 1;
        let end = expr[i..].find('\'').ok_or_else(unsupported)? + i;
        value = expr[i..end].to_string();
        i = end + 1;
    } else {
        let start = i;
        while i < b.len() {
            let ch = expr[i..].chars().next().unwrap();
            if ch.is_ascii_whitespace() || matches!(ch, '"' | '\'' | '(' | ')') {
                break;
            }
            i += ch.len_utf8();
        }
        if i == start {
            return Err(unsupported());
        }
        value = expr[start..i].to_string();
    }
    skip_ws(&mut i);
    if b.get(i) == Some(&b')') {
        i += 1;
        skip_ws(&mut i);
    }
    if i != b.len() {
        return Err(unsupported());
    }
    Ok((field, op.to_string(), value))
}

fn coerce(field: &Value, value: &Value) -> Value {
    if value.is_null() || value.as_str() == Some("") {
        return value.clone();
    }
    let ftype = get_str(field, "type");
    if ftype == "number" {
        if let Some(s) = value.as_str() {
            // The oracle parses int-or-float on the "." heuristic; try integer
            // first and fall back to float so "1e5" coerces instead of erroring.
            if let Ok(i) = s.trim().parse::<i64>() {
                return json!(i);
            }
            if let Ok(f) = s.trim().parse::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(f) {
                    return Value::Number(n);
                }
            }
            return value.clone();
        }
    }
    if ftype == "boolean" {
        if let Some(s) = value.as_str() {
            return Value::Bool(s == "true");
        }
    }
    value.clone()
}

enum Backend {
    /// The disposable in-memory variant, for tests and tooling. A fresh one is
    /// always empty, so it always takes the seed.
    Memory {
        rows: BTreeMap<String, Vec<Value>>,
        idem: HashMap<(String, String), String>,
        /// adapter state: table -> key -> row (see `Store::row`)
        state: BTreeMap<String, BTreeMap<String, Value>>,
    },
    /// The blueprint's live store: records, idempotency keys and adapter state
    /// in SQLite. One connection behind one mutex keeps this correct without a
    /// pool.
    Sqlite(Mutex<Connection>),
}

/// Record store plus adapter-owned state (tasks, events, approvals,
/// credentials, accounts).
///
/// Records are JSON rows in one table keyed (entity, id): the schema stays
/// declarative and additive (a new field simply appears in the JSON) while the
/// DATABASE is a real on-disk file inside the toolkit's declared lifecycle
/// dataDir — which is what backup/restore/promote protect. WAL keeps a reader
/// and a writer from blocking each other.
///
/// Idempotency keys persist because a restart is exactly when a retried POST
/// arrives — an in-memory table would return a duplicate record instead of the
/// 409 the protocol promises. Credentials, accounts, sessions, invites and
/// device codes persist too (the `adapter_state` table): a restart must sign
/// nobody out and cut off no agent. They are adapter state, never records — no
/// record route reaches them, and a runner's `Store` methods cannot. The
/// task/event plane and approvals stay in memory: they are runtime queues.
///
/// Writes are durable when the call returns — there is no separate persist()
/// step. A record read from this store is a COPY: mutate it, then
/// `put_record()` it back, or the change never happened.
pub struct Store {
    backend: Backend,
    /// True only when this open CREATED the database file. Re-seeding an
    /// existing database on every boot would resurrect a seed record the user
    /// deleted.
    pub wants_seed: bool,
    pub seed: Value,
    tasks: Vec<Value>,
    events: Vec<Value>,
    approvals: HashSet<String>,
    event_seq: u64,
    /// The event types this app may emit, set by `Adapter::new` from the app's
    /// declarations. Empty means none were declared.
    event_types: BTreeSet<String>,
    /// occurrence key -> task id, so one occurrence makes one task
    dedup: HashMap<String, String>,
    /// Who the operation being run acts for. The adapter sets it around a
    /// runner, so a task the runner queues records who asked for it (spec/v0_2
    /// auth.md §6.1) without the runner having to say — or being able to say
    /// otherwise. None outside a runner: work the app queues on its own.
    caller: Option<String>,
}

impl Store {
    pub fn memory(seed: Value) -> Store {
        Store {
            backend: Backend::Memory { rows: BTreeMap::new(), idem: HashMap::new(), state: BTreeMap::new() },
            wants_seed: true,
            seed,
            tasks: Vec::new(),
            events: Vec::new(),
            approvals: HashSet::new(),
            event_seq: 0,
            event_types: BTreeSet::new(),
            dedup: HashMap::new(),
            caller: None,
        }
    }

    pub fn sqlite(path: &Path, seed: Value) -> Result<Store, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create data dir: {e}"))?;
        }
        let fresh = !path.exists();
        let db = Connection::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        db.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))
            .map_err(|e| format!("cannot set WAL: {e}"))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS records (
                entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (entity, id));
             CREATE TABLE IF NOT EXISTS idem (
                entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL,
                PRIMARY KEY (entity, key));
             CREATE TABLE IF NOT EXISTS adapter_state (
                tbl TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (tbl, key));",
        )
        .map_err(|e| format!("cannot create tables: {e}"))?;
        Ok(Store {
            backend: Backend::Sqlite(Mutex::new(db)),
            wants_seed: fresh,
            seed,
            tasks: Vec::new(),
            events: Vec::new(),
            approvals: HashSet::new(),
            event_seq: 0,
            event_types: BTreeSet::new(),
            dedup: HashMap::new(),
            caller: None,
        })
    }

    // records ---------------------------------------------------------------

    /// Every record of one entity — the single per-backend read;
    /// `list_records` keeps the shared filter/sort/page on top of it.
    fn all_records(&self, entity: &str) -> Vec<Value> {
        match &self.backend {
            Backend::Memory { rows, .. } => rows.get(entity).cloned().unwrap_or_default(),
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                let mut stmt = match db.prepare("SELECT data FROM records WHERE entity = ?1") {
                    Ok(s) => s,
                    Err(_) => return Vec::new(),
                };
                let rows = stmt.query_map([entity], |row| row.get::<_, String>(0));
                match rows {
                    Ok(iter) => iter
                        .filter_map(Result::ok)
                        .filter_map(|s| serde_json::from_str(&s).ok())
                        .collect(),
                    Err(_) => Vec::new(),
                }
            }
        }
    }

    /// `query`: `filter`, `sort`, `page`, `perPage`, and `where` — `{field:
    /// value}` constraints the adapter sets (a member sees only the records it
    /// owns), applied before sorting and paging like any other constraint, so
    /// pages and totals count only what the caller may see.
    pub fn list_records(&self, entity: &str, query: &Value) -> Result<Value, UnsupportedFilter> {
        let mut items = self.all_records(entity);
        if let Some(constraints) = query.get("where").and_then(Value::as_object) {
            items.retain(|r| constraints.iter().all(|(field, value)| get(r, field) == value));
        }
        if let Some(expr) = query.get("filter").and_then(Value::as_str) {
            if !expr.is_empty() {
                let (field, op, value) = match_filter(expr)?;
                items.retain(|r| {
                    let current = filter_str(get(r, &field));
                    match op.as_str() {
                        "=" => current == value,
                        "!=" => current != value,
                        _ => current.contains(&value),
                    }
                });
            }
        }
        if let Some(sort) = query.get("sort").and_then(Value::as_str) {
            if !sort.is_empty() {
                let desc = sort.starts_with('-');
                let key = if desc { &sort[1..] } else { sort };
                // The oracle sorts on (is-missing, str(value)) — missing values
                // last ascending — with a stable sort.
                items.sort_by(|a, b| {
                    let ka = (get(a, key).is_null(), py_str(get(a, key)));
                    let kb = (get(b, key).is_null(), py_str(get(b, key)));
                    let ord = ka.cmp(&kb);
                    if desc {
                        ord.reverse()
                    } else {
                        ord
                    }
                });
            }
        }
        let total = items.len() as i64;
        let per_page = query_int(query.get("perPage")).unwrap_or(total);
        let page = query_int(query.get("page")).unwrap_or(1);
        let paged: Vec<Value> = if per_page > 0 {
            let start = ((page - 1) * per_page).max(0) as usize;
            items.into_iter().skip(start).take(per_page as usize).collect()
        } else {
            items
        };
        Ok(json!({ "items": paged, "page": page, "perPage": per_page, "totalItems": total }))
    }

    pub fn get_record(&self, entity: &str, rec_id: &str) -> Option<Value> {
        match &self.backend {
            Backend::Memory { rows, .. } => rows
                .get(entity)
                .and_then(|list| list.iter().find(|r| get_str(r, "id") == rec_id))
                .cloned(),
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                db.query_row(
                    "SELECT data FROM records WHERE entity = ?1 AND id = ?2",
                    [entity, rec_id],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
            }
        }
    }

    pub fn put_record(&mut self, entity: &str, rec: Value) {
        match &mut self.backend {
            Backend::Memory { rows, .. } => {
                let list = rows.entry(entity.to_string()).or_default();
                let id = get_str(&rec, "id").to_string();
                match list.iter_mut().find(|r| get_str(r, "id") == id) {
                    Some(slot) => *slot = rec,
                    None => list.push(rec),
                }
            }
            Backend::Sqlite(db) => {
                let id = get_str(&rec, "id").to_string();
                let data = stable_json(&rec);
                let db = db.lock().expect("sqlite mutex poisoned");
                let _ = db.execute(
                    "INSERT INTO records (entity, id, data) VALUES (?1, ?2, ?3)
                     ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data",
                    params![entity, id, data],
                );
            }
        }
    }

    pub fn delete_record(&mut self, entity: &str, rec_id: &str) -> bool {
        match &mut self.backend {
            Backend::Memory { rows, .. } => {
                let list = match rows.get_mut(entity) {
                    Some(l) => l,
                    None => return false,
                };
                let before = list.len();
                list.retain(|r| get_str(r, "id") != rec_id);
                list.len() < before
            }
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                db.execute("DELETE FROM records WHERE entity = ?1 AND id = ?2", [entity, rec_id])
                    .map(|n| n > 0)
                    .unwrap_or(false)
            }
        }
    }

    // adapter state -----------------------------------------------------------
    // Keyed tables the auth layer owns: `users`, `sessions`, `invites`,
    // `devices` and `grants`. Rows are keyed by id or by the SHA-256 of the
    // secret that finds them; no secret is ever a key or a value. Private to
    // the adapter: a runner holds this `Store` too, and must not reach them.

    fn row(&self, table: &str, key: &str) -> Option<Value> {
        match &self.backend {
            Backend::Memory { state, .. } => state.get(table).and_then(|t| t.get(key)).cloned(),
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                db.query_row("SELECT data FROM adapter_state WHERE tbl = ?1 AND key = ?2", [table, key], |row| {
                    row.get::<_, String>(0)
                })
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
            }
        }
    }

    fn put_row(&mut self, table: &str, key: &str, row: &Value) {
        match &mut self.backend {
            Backend::Memory { state, .. } => {
                state.entry(table.to_string()).or_default().insert(key.to_string(), row.clone());
            }
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                let _ = db.execute(
                    "INSERT INTO adapter_state (tbl, key, data) VALUES (?1, ?2, ?3)
                     ON CONFLICT (tbl, key) DO UPDATE SET data = excluded.data",
                    params![table, key, stable_json(row)],
                );
            }
        }
    }

    fn delete_row(&mut self, table: &str, key: &str) {
        match &mut self.backend {
            Backend::Memory { state, .. } => {
                if let Some(t) = state.get_mut(table) {
                    t.remove(key);
                }
            }
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                let _ = db.execute("DELETE FROM adapter_state WHERE tbl = ?1 AND key = ?2", [table, key]);
            }
        }
    }

    fn rows(&self, table: &str) -> Vec<(String, Value)> {
        match &self.backend {
            Backend::Memory { state, .. } => state
                .get(table)
                .map(|t| t.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                let Ok(mut stmt) = db.prepare("SELECT key, data FROM adapter_state WHERE tbl = ?1") else {
                    return Vec::new();
                };
                let rows = stmt.query_map([table], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)));
                match rows {
                    Ok(iter) => iter
                        .filter_map(Result::ok)
                        .filter_map(|(k, s)| serde_json::from_str(&s).ok().map(|v| (k, v)))
                        .collect(),
                    Err(_) => Vec::new(),
                }
            }
        }
    }

    // credentials ---------------------------------------------------------------
    // A grant (spec/v0_2/auth.md §2.1): `{credentialId, tokenHash, principal,
    // agentName, scopes, createdAt, expiresAt, lastUsedAt, revokedAt, task,
    // admin}`, in the `grants` table keyed by `tokenHash` — the hex SHA-256 of
    // the token, the only form of it ever stored. A row without one (a token
    // kept in plaintext by an older store) is never served: the host re-seeds
    // its own credential at boot, hashed.

    fn grant_by_token_hash(&self, token_hash: &str) -> Option<Value> {
        self.row("grants", token_hash).filter(|g| get(g, "tokenHash").as_str() == Some(token_hash))
    }

    fn list_grants(&self) -> Vec<Value> {
        self.rows("grants")
            .into_iter()
            .filter(|(key, g)| get(g, "tokenHash").as_str() == Some(key.as_str()))
            .map(|(_, g)| g)
            .collect()
    }

    fn grant_by_id(&self, credential_id: &str) -> Option<Value> {
        self.list_grants().into_iter().find(|g| get_str(g, "credentialId") == credential_id)
    }

    fn put_grant(&mut self, grant: &Value) {
        let token_hash = get_str(grant, "tokenHash").to_string();
        // A rotated token moves its credential to a new key; the old one goes.
        if let Some(previous) = self.grant_by_id(get_str(grant, "credentialId")) {
            if get_str(&previous, "tokenHash") != token_hash {
                self.delete_row("grants", get_str(&previous, "tokenHash"));
            }
        }
        self.put_row("grants", &token_hash, grant);
    }

    fn delete_grant(&mut self, credential_id: &str) {
        if let Some(g) = self.grant_by_id(credential_id) {
            self.delete_row("grants", get_str(&g, "tokenHash"));
        }
    }

    // idempotency / approvals -------------------------------------------------
    pub fn idem_get(&self, entity: &str, key: &str) -> Option<String> {
        match &self.backend {
            Backend::Memory { idem, .. } => idem.get(&(entity.to_string(), key.to_string())).cloned(),
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                db.query_row(
                    "SELECT rec_id FROM idem WHERE entity = ?1 AND key = ?2",
                    [entity, key],
                    |row| row.get::<_, String>(0),
                )
                .ok()
            }
        }
    }

    pub fn idem_put(&mut self, entity: &str, key: &str, rec_id: &str) {
        match &mut self.backend {
            Backend::Memory { idem, .. } => {
                idem.insert((entity.to_string(), key.to_string()), rec_id.to_string());
            }
            Backend::Sqlite(db) => {
                let db = db.lock().expect("sqlite mutex poisoned");
                let _ = db.execute(
                    "INSERT INTO idem (entity, key, rec_id) VALUES (?1, ?2, ?3)
                     ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id",
                    params![entity, key, rec_id],
                );
            }
        }
    }

    pub fn approval_issue(&mut self, key: &str) {
        self.approvals.insert(key.to_string());
    }

    pub fn approval_consume(&mut self, key: &str) -> bool {
        self.approvals.remove(key)
    }

    // tasks / events ------------------------------------------------------------
    pub fn append_event(&mut self, etype: &str, payload: &Value) -> Value {
        self.event_seq += 1;
        let ev = json!({
            "id": format!("ev_{}", self.event_seq), "app": null, "type": etype,
            "payload": payload, "createdAt": now_iso(), "seq": self.event_seq,
        });
        self.events.push(ev.clone());
        ev
    }

    pub fn events_since(&self, cursor: Option<&str>) -> (Vec<Value>, String) {
        let after: u64 = match cursor {
            Some(c) if !c.is_empty() && c.bytes().all(|b| b.is_ascii_digit()) => c.parse().unwrap_or(0),
            _ => 0,
        };
        let fresh: Vec<Value> = self
            .events
            .iter()
            .filter(|e| get(e, "seq").as_u64().unwrap_or(0) > after)
            .cloned()
            .collect();
        let next = match fresh.last() {
            Some(last) => get(last, "seq").as_u64().unwrap_or(0).to_string(),
            None => cursor.unwrap_or("0").to_string(),
        };
        (fresh, next)
    }

    /// Queue a task. `principal` is who asked for the work (spec/v0_2 auth.md
    /// §6.1), null for work the app queues on its own.
    fn enqueue_task(
        &mut self,
        event_id: &str,
        capability: &str,
        payload: &Value,
        principal: Option<&str>,
        dedup_key: Option<&str>,
    ) -> Value {
        if let Some(existing) = dedup_key.and_then(|k| self.dedup.get(k)).and_then(|id| self.get_task(id)) {
            return existing;
        }
        // Random, never a counter: a task credential names its task, and
        // credentials outlive a restart that would reset a counter — a new
        // task must never revive an old task's credential.
        let id = new_id("tsk");
        let task = json!({
            "id": id, "app": null, "event": event_id,
            "status": "submitted",
            "request": { "capability": capability, "payload": payload, "principal": principal },
            "claim": null, "progress": {}, "result": null, "reason": null, "ask": null,
            "createdAt": now_iso(), "updatedAt": now_iso(), "deliveries": 1,
        });
        self.tasks.push(task.clone());
        if let Some(key) = dedup_key {
            self.dedup.insert(key.to_string(), id);
        }
        task
    }

    /// Emit a declared event and, when `capability` is given, queue a task for
    /// an agent. This is the app->agent seam an operation runner reaches
    /// through the `store` it is handed. Returns `{"eventId", "taskId"}`;
    /// `taskId` is null when no capability was named, because an event alone
    /// asks no agent for work. An undeclared event type is an error, and
    /// nothing is emitted.
    ///
    /// The task records who asked: the caller of the operation this runs in.
    /// The agent that takes it acts as them (spec/v0_2/auth.md §6).
    pub fn trigger(&mut self, etype: &str, payload: &Value, capability: Option<&str>) -> Result<Value, String> {
        let principal = self.caller.clone();
        self.trigger_as(etype, payload, capability, principal.as_deref())
    }

    /// The store lent to a runner, acting for `principal`.
    fn acting_for(&mut self, principal: &str) -> CallerScope<'_> {
        self.caller = Some(principal.to_string());
        CallerScope(self)
    }

    fn trigger_as(
        &mut self,
        etype: &str,
        payload: &Value,
        capability: Option<&str>,
        principal: Option<&str>,
    ) -> Result<Value, String> {
        if !self.event_types.is_empty() && !self.event_types.contains(etype) {
            return Err(format!("event type \"{etype}\" is not declared"));
        }
        let ev = self.append_event(etype, payload);
        let task_id = match capability.filter(|c| !c.is_empty()) {
            Some(cap) => {
                // Dedup is keyed on the OCCURRENCE, not on the event record: the
                // same trigger firing twice must make one task. The event id is
                // fresh per emit, so keying on it would deduplicate nothing. The
                // occurrence is what the app asked for (type, capability,
                // payload) and who asked — the same request from two people is
                // two tasks, each run as the person who asked. serde_json's
                // sorted map makes the serialization independent of key order.
                let mut occurrence = json!({ "type": etype, "capability": cap, "payload": payload });
                if let Some(p) = principal.filter(|p| !p.is_empty()) {
                    occurrence["principal"] = json!(p);
                }
                let key = format!("sha256:{}", hex_of(&Sha256::digest(stable_json(&occurrence).as_bytes())));
                let task = self.enqueue_task(get_str(&ev, "id"), cap, payload, principal, Some(key.as_str()));
                Some(get_str(&task, "id").to_string())
            }
            None => None,
        };
        Ok(json!({ "eventId": get(&ev, "id"), "taskId": task_id }))
    }

    /// Return abandoned claims to the queue: a `working` task with no update
    /// for `TASK_TIMEOUT_MS` goes back to `submitted` so another agent can take
    /// it, and fails with `redelivery_exhausted` once it has been handed out
    /// `TASK_MAX_DELIVERIES` times. Never a silent drop.
    pub fn sweep(&mut self) {
        let now = epoch_ms_now();
        for task in self.tasks.iter_mut() {
            if get_str(task, "status") != "working" {
                continue;
            }
            if let Some(updated) = iso_epoch_ms(get_str(task, "updatedAt")) {
                if now - updated < TASK_TIMEOUT_MS {
                    continue;
                }
            }
            let deliveries = get(task, "deliveries").as_u64().unwrap_or(0);
            if deliveries >= TASK_MAX_DELIVERIES {
                task["status"] = json!("failed");
                task["reason"] = json!("redelivery_exhausted");
            } else {
                task["status"] = json!("submitted");
                task["claim"] = Value::Null;
                task["deliveries"] = json!(deliveries + 1);
            }
            task["updatedAt"] = json!(now_iso());
        }
    }

    pub fn list_tasks(&self, status: Option<&str>) -> Vec<Value> {
        self.tasks
            .iter()
            .filter(|t| status.map_or(true, |s| get_str(t, "status") == s))
            .cloned()
            .collect()
    }

    pub fn get_task(&self, task_id: &str) -> Option<Value> {
        self.tasks.iter().find(|t| get_str(t, "id") == task_id).cloned()
    }

    pub fn save_task(&mut self, mut task: Value) {
        task["updatedAt"] = json!(now_iso());
        let id = get_str(&task, "id").to_string();
        match self.tasks.iter_mut().find(|t| get_str(t, "id") == id) {
            Some(slot) => *slot = task,
            None => self.tasks.push(task),
        }
    }
}

/// The store while a runner holds it (see `Store::acting_for`). Dropping it
/// clears the caller — on return or on a panic — so a task queued afterwards is
/// never recorded as that person's.
struct CallerScope<'a>(&'a mut Store);

impl Drop for CallerScope<'_> {
    fn drop(&mut self) {
        self.0.caller = None;
    }
}

fn query_int(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        // Python truthiness: an empty string means "absent"; a non-numeric
        // string would raise there — here it falls back to the default.
        Some(Value::String(s)) if !s.is_empty() => s.parse().ok(),
        _ => None,
    }
}

// ------------------------------------------------------------- referential

/// Who still points at this record.
///
/// Every `ref` and `list<ref>` names the entity it targets, so the app has
/// ALREADY declared where its references live — this reads that rather than
/// asking for a second declaration.
///
/// Pages through referencing entities instead of filtering in the store: a
/// filter grammar differs per backend, and a policy that silently did nothing
/// against one of them would be worse than no policy. Only entities that
/// actually declare a `restrict` ref to this one are read, so an entity
/// nothing points at costs nothing. A free function so the selftest can drive
/// it against a fixture store, exactly as the oracle does.
pub fn references_to(entity_defs: &Value, store: &Store, entity: &str, rec_id: &str) -> Vec<Value> {
    let mut blockers: Vec<Value> = Vec::new();
    let defs = match entity_defs.as_object() {
        Some(m) => m,
        None => return blockers,
    };
    for (other, d) in defs {
        let pointing: Vec<&Value> = get(d, "fields")
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|f| {
                        matches!(get_str(f, "type"), "ref" | "list<ref>")
                            && get_str(f, "entity") == entity
                            && get(f, "onDelete").as_str().unwrap_or(DEFAULT_ON_DELETE) == "restrict"
                    })
                    .collect()
            })
            .unwrap_or_default();
        if pointing.is_empty() {
            continue;
        }

        // Field name -> example ids, in first-hit order (the oracle's dict).
        let mut found: Vec<(String, Vec<String>)> = Vec::new();
        let mut page: i64 = 1;
        loop {
            let result = store
                .list_records(other, &json!({ "page": page, "perPage": REFERENCE_SCAN_PAGE }))
                .unwrap_or_else(|_| json!({ "items": [] }));
            let items: Vec<Value> = get(&result, "items").as_array().cloned().unwrap_or_default();
            for row in &items {
                for f in &pointing {
                    let name = get_str(f, "name");
                    let value = get(row, name);
                    let hit = match value.as_array() {
                        Some(list) => list.iter().any(|v| v == &json!(rec_id)),
                        None => value == &json!(rec_id),
                    };
                    if !hit {
                        continue;
                    }
                    let pos = match found.iter().position(|(n, _)| n.as_str() == name) {
                        Some(p) => p,
                        None => {
                            found.push((name.to_string(), Vec::new()));
                            found.len() - 1
                        }
                    };
                    let ids = &mut found[pos].1;
                    if ids.len() < REFERENCE_SCAN_LIMIT {
                        // The oracle renders str(row.get("id", "")): the id as
                        // text, an absent id as the empty string.
                        let id_text = match row.get("id") {
                            Some(v) => py_str(v),
                            None => String::new(),
                        };
                        ids.push(id_text);
                    }
                }
            }
            if (items.len() as i64) < REFERENCE_SCAN_PAGE {
                break;
            }
            page += 1;
            if page > REFERENCE_SCAN_MAX_PAGES {
                break;
            }
        }

        for (field, ids) in found {
            blockers.push(json!({ "entity": other, "field": field, "ids": ids }));
        }
    }
    blockers
}

// ----------------------------------------------------------------- adapter

fn approval_key(name: &str, args: &Value) -> String {
    // Canonical JSON with sorted keys — serde_json's default map sorts, and
    // "args" < "op", so plain serialization is the canonical form.
    let canonical = stable_json(&json!({ "op": name, "args": args }));
    let digest = Sha256::digest(canonical.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("ak_{}", &hex[..32])
}

/// What this caller may do, for rendering access on a describe level: the
/// scopes its request was given (see `Adapter::access_for`).
struct Access(BTreeSet<String>);

impl Access {
    fn read(&self, entity: &str) -> bool {
        self.0.contains(&format!("data:{entity}:read"))
    }
    fn write(&self, entity: &str) -> bool {
        self.0.contains(&format!("data:{entity}:write"))
    }
    fn run(&self, op: &str) -> bool {
        self.0.contains(&format!("op:{op}"))
    }
}

/// Who a request acts for, as `Adapter::resolve` found it.
struct Caller {
    /// `{credentialId, agentName, principal, role}` — what a runner receives.
    ctx: Value,
    /// The scopes this request may use; None for an anonymous read on a
    /// single-user app, which the scope check does not apply to.
    held: Option<BTreeSet<String>>,
    /// The credential presented, if one was.
    grant: Option<Value>,
}

/// A caller that may manage accounts and credentials (spec §2.4).
struct Manager {
    principal: String,
    role: String,
}

/// One operation runner: (args, ctx, store) -> JSON-able result or an error
/// string (surfaced as a 500 operation_failed envelope). `ctx` is who is
/// calling: `{credentialId, agentName, principal, role}`.
pub type Runner = fn(&Value, &Value, &mut Store) -> Result<Value, String>;
/// Runner resolution by operation name — `schema::operation_runner`.
pub type RunnerLookup = fn(&str) -> Option<Runner>;
/// What a principal may do (spec/v0_2/auth.md §3), as scopes (`*` is every
/// scope), given `{id, name, role, active}`. Evaluated on every request.
pub type PermissionsOf = fn(&Value) -> Vec<String>;

/// The app's optional hooks. `schema.rs` defines one as an inherent method,
/// `impl App { pub fn capabilities(&self) -> Value { … } }`; an inherent method
/// wins over a trait's, so `App.capabilities()` falls back to the default below
/// when the app defines none — and a schema written before 0.2 still compiles.
pub struct App;

pub trait AppDefaults {
    /// `{capability: {"scopes": [...]}}`: what each capability's agent may do.
    /// None declared: every capability's agent gets `*`, within its person's
    /// reach.
    fn capabilities(&self) -> Value {
        json!({})
    }
    /// What a principal may do. By default everyone active may use everything
    /// (their records still stay their own).
    fn permissions_of(&self, _principal: &Value) -> Vec<String> {
        vec!["*".to_string()]
    }
}

impl AppDefaults for App {}

pub struct AdapterConfig {
    pub app_id: String,
    pub app_name: Option<String>,
    /// `{name: {"fields": [...], "module": str, "summary"?, "auth"?,
    /// "writeAllow"?, "ownedBy"?}}`. `ownedBy` names a readOnly string field
    /// holding each record's owner (spec/v0_2/auth.md §5).
    pub entities: Value,
    pub operations: Value,
    pub store: Store,
    /// The app's own `.agent-token`: seeded, hashed, as the admin credential
    /// (spec/v0_2/auth.md §2.3).
    pub token: String,
    /// What each person may do; None means `*` for every active principal
    /// (their records still stay their own).
    pub permissions_of: Option<PermissionsOf>,
    /// `{capability: {"scopes": [...]}}`: what the agent taking each
    /// capability's tasks may do. A capability left out gets `*`.
    pub capabilities: Value,
    pub modules: Value,
    pub allowed_origins: Vec<String>,
    /// The origin people and agents reach the app at (A2APP_PUBLIC_URL,
    /// resolved by [`network_policy`]), or None for loopback only. It is one
    /// more of the app's own origins, and its host is answered.
    pub public_url: Option<String>,
    pub runner_lookup: RunnerLookup,
    /// The event types this app may emit (`[{"type": ...}]`). A runner's
    /// `store.trigger` refuses a type that is not declared here.
    pub events: Value,
    pub auth_mode: String,
    pub credential_hint: Option<String>,
    pub env: Option<String>,
    /// Re-derived per identity request, so it stays true for a server whose
    /// files changed under it — the same "derive, do not declare" rule
    /// schemaVersion follows. None omits appVersion (the selftest's adapters).
    pub app_version: Option<Box<dyn Fn() -> String>>,
}

pub struct Adapter {
    app_id: String,
    app_name: Option<String>,
    entity_defs: Value,
    operations: Value,
    modules: Value,
    pub store: Store,
    /// "none" or "multi-user"
    auth_mode: String,
    /// The app's own origins, the public URL's among them, in declared order.
    own_origins: Vec<String>,
    allowed_origins: HashSet<String>,
    allowed_hosts: HashSet<String>,
    public_url: Option<String>,
    runner_lookup: RunnerLookup,
    permissions_of: Option<PermissionsOf>,
    capabilities: Value,
    credential_hint: String,
    env: Option<String>,
    limiter: RateLimiter,
    app_version: Option<Box<dyn Fn() -> String>>,
    /// Per app: browsers do not separate cookies by port, so two apps on one
    /// machine would otherwise sign each other out.
    session_cookie_name: String,
    /// `Secure` on the session cookie when the public URL is https.
    secure_cookies: bool,
    sign_in_failures: FailureLimiter,
    /// Checked against when a login does not exist, so a missing account takes
    /// as long to refuse as a wrong password and the timing does not say which.
    dummy_hash: Option<String>,
}

/* ---------------------------------------------------------------- network
 *
 * Where an app listens, and the address the rest of the world uses for it. The
 * one rule: a bearer token must never cross a network in clear, so binding a
 * non-loopback address needs an https public URL, and a public URL may be
 * plain http only when it names this machine (an SSH tunnel ends on loopback).
 */

/// Is `name` a loopback name or address? Accepts a bracketed IPv6 literal.
pub fn is_loopback_name(name: &str) -> bool {
    let bare = name.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    bare == "localhost" || bare.parse::<IpAddr>().map_or(false, |ip| ip.is_loopback())
}

/// The host name in a Host value (`name`, `name:port`, `[v6]:port`), or None.
pub fn hostname_of(host: &str) -> Option<String> {
    url::Url::parse(&format!("http://{host}")).ok()?.host_str().map(str::to_ascii_lowercase)
}

/// The Host values an origin answers to: `name:port` and `name`.
fn origin_hosts(origin: &str) -> Vec<String> {
    let Ok(u) = url::Url::parse(origin) else { return vec![] };
    let Some(name) = u.host_str().map(str::to_ascii_lowercase) else { return vec![] };
    match u.port() {
        Some(port) => vec![format!("{name}:{port}"), name],
        None => vec![name],
    }
}

/// Resolve (bind host, public origin) from A2APP_HOST / A2APP_PUBLIC_URL, or
/// the reason the combination is unsafe.
pub fn network_policy(host_env: Option<String>, public_url_env: Option<String>) -> Result<(String, Option<String>), String> {
    let host = host_env
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let mut public = None;
    let mut https = false;
    if let Some(raw) = public_url_env.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
        let u = url::Url::parse(&raw).map_err(|_| format!("A2APP_PUBLIC_URL is not a URL: \"{raw}\"."))?;
        if u.scheme() != "https" && u.scheme() != "http" {
            return Err(format!("A2APP_PUBLIC_URL must be an http(s) URL, not \"{raw}\"."));
        }
        let Some(name) = u.host_str() else {
            return Err(format!("A2APP_PUBLIC_URL is not a URL: \"{raw}\"."));
        };
        https = u.scheme() == "https";
        if !https && !is_loopback_name(name) {
            return Err(format!(
                "A2APP_PUBLIC_URL must be https: \"{raw}\" would send the agent token across a network in clear. \
                 Put the app behind a TLS proxy, or reach it through an SSH tunnel to a loopback address."
            ));
        }
        public = Some(u.origin().ascii_serialization());
    }
    if !is_loopback_name(&host) && !https {
        return Err(format!(
            "A2APP_HOST={host} exposes the app to the network, so A2APP_PUBLIC_URL must name its https address \
             (the agent token must not cross a network in clear). To reach it through a tunnel instead, keep A2APP_HOST on 127.0.0.1."
        ));
    }
    Ok((host, public))
}

/// Everything wrong with the app part's module/operation declarations.
///
/// Parity oracle: `modelProblems` in adapters/adapter-core/src/describe.ts.
fn model_problems(modules: &Value, entity_defs: &Value, operations: &Value) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    let module_list: Vec<&Value> = modules.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let declared: HashSet<&str> = module_list.iter().map(|m| get_str(m, "name")).collect();
    if module_list.is_empty() {
        problems.push(
            "no modules declared: every entity and operation belongs to one, and the root screen lists them"
                .to_string(),
        );
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for m in &module_list {
        let name = get_str(m, "name");
        if seen.contains(name) {
            problems.push(format!("duplicate module \"{name}\""));
        }
        seen.insert(name);
    }

    if let Some(defs) = entity_defs.as_object() {
        for (name, d) in defs {
            let module = get_str(d, "module");
            if module.is_empty() {
                problems.push(format!("entity \"{name}\" declares no module"));
            } else if !declared.contains(module) {
                problems.push(format!("entity \"{name}\" names undeclared module \"{module}\""));
            }
            if let Some(owned_by) = d.get("ownedBy").filter(|v| !v.is_null()) {
                // The adapter writes the owner and the guard keeps clients from
                // doing so, which only holds for a declared, read-only string
                // field.
                let owned_by = owned_by.as_str().map_or_else(|| stable_json(owned_by), str::to_string);
                let owner = get(d, "fields")
                    .as_array()
                    .and_then(|a| a.iter().find(|f| get(f, "name").as_str() == Some(owned_by.as_str())));
                match owner {
                    None => problems.push(format!(
                        "entity \"{name}\" is ownedBy \"{owned_by}\", which is not one of its fields"
                    )),
                    Some(f) if get_str(f, "type") != "string" || get(f, "readOnly") != &json!(true) => problems.push(
                        format!("entity \"{name}\" is ownedBy \"{owned_by}\", which must be a readOnly string field"),
                    ),
                    Some(_) => {}
                }
            }
        }
    }

    for o in operations.as_array().map(|a| a.as_slice()).unwrap_or_default() {
        let op_name = get_str(o, "name");
        let module = get_str(o, "module");
        if module.is_empty() {
            problems.push(format!("operation \"{op_name}\" declares no module"));
        } else if !declared.contains(module) {
            problems.push(format!("operation \"{op_name}\" names undeclared module \"{module}\""));
        }
        if !get(o, "params").is_object() {
            problems.push(format!(
                "operation \"{op_name}\" declares no typed params (declare {{}} if it takes none)"
            ));
        }
        let entity = get(o, "entity");
        if let Some(entity_name) = entity.as_str() {
            match entity_defs.get(entity_name) {
                None => problems.push(format!("operation \"{op_name}\" acts on unknown entity \"{entity_name}\"")),
                Some(d) => {
                    let entity_module = get_str(d, "module");
                    if entity_module != module {
                        problems.push(format!(
                            "operation \"{op_name}\" is in module \"{module}\" but acts on entity \"{entity_name}\" in module \"{entity_module}\""
                        ));
                    }
                    let when = get(o, "appliesWhen");
                    if truthy(when) {
                        let names: HashSet<&str> = get(d, "fields")
                            .as_array()
                            .map(|a| a.iter().map(|f| get_str(f, "name")).collect())
                            .unwrap_or_default();
                        for referenced in predicate_fields(when) {
                            if !names.contains(referenced.as_str()) {
                                problems.push(format!(
                                    "operation \"{op_name}\" appliesWhen reads \"{referenced}\", not a field of \"{entity_name}\""
                                ));
                            }
                        }
                    }
                }
            }
        } else if truthy(get(o, "appliesWhen")) {
            problems.push(format!(
                "operation \"{op_name}\" declares appliesWhen but no entity: there is no record to evaluate it against"
            ));
        }
    }
    problems
}

impl Adapter {
    pub fn new(config: AdapterConfig) -> Result<Adapter, String> {
        let mut problems = model_problems(&config.modules, &config.entities, &config.operations);
        let mut store = config.store;
        // The declared event types are what keep the app->agent queue from
        // being an open channel: `store.trigger` refuses a type that is not
        // declared, so the set of things this app can ever ask an agent to react
        // to is fixed by its author rather than by whatever a runner passes at
        // the moment of firing.
        store.event_types = config
            .events
            .as_array()
            .map(|events| events.iter().map(|e| get_str(e, "type").to_string()).collect())
            .unwrap_or_default();
        // The hosts this app answers to are derived from its own origins, so an
        // app reached at its public URL answers there and nowhere new.
        let own_origins: Vec<String> = config.allowed_origins.iter().cloned().chain(config.public_url.clone()).collect();
        let auth_mode = if config.auth_mode == "multi-user" { "multi-user" } else { "none" };
        let mut adapter = Adapter {
            session_cookie_name: format!("a2app_session_{}", config.app_id),
            app_id: config.app_id,
            app_name: config.app_name,
            entity_defs: config.entities,
            operations: config.operations,
            modules: config.modules,
            store,
            auth_mode: auth_mode.to_string(),
            allowed_origins: own_origins.iter().cloned().collect(),
            allowed_hosts: own_origins.iter().flat_map(|o| origin_hosts(o)).collect(),
            own_origins,
            secure_cookies: config.public_url.as_deref().map_or(false, |u| u.starts_with("https:")),
            public_url: config.public_url,
            runner_lookup: config.runner_lookup,
            permissions_of: config.permissions_of,
            capabilities: config.capabilities,
            credential_hint: config
                .credential_hint
                .unwrap_or_else(|| "Read the app's .agent-token file (mode 0600) in the project directory.".to_string()),
            env: config.env,
            limiter: RateLimiter::new(),
            app_version: config.app_version,
            sign_in_failures: FailureLimiter::new(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS),
            dummy_hash: None,
        };

        // A capability's agent may hold only scopes the app declares.
        let declared = adapter.all_scopes();
        if let Some(caps) = adapter.capabilities.as_object() {
            for (capability, decl) in caps {
                let unknown: Vec<String> = get(decl, "scopes")
                    .as_array()
                    .map(|a| a.iter().map(py_str).filter(|s| s != "*" && !declared.contains(s)).collect())
                    .unwrap_or_default();
                if !unknown.is_empty() {
                    problems.push(format!(
                        "capability \"{capability}\" needs scopes this app does not declare: {}",
                        unknown.join(", ")
                    ));
                }
            }
        }
        if !problems.is_empty() {
            // Fail fast: a model whose entities or operations name a module that
            // was never declared cannot be walked, so serving it would answer 200
            // while omitting real capability.
            return Err(format!(
                "A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - {}",
                problems.join("\n  - ")
            ));
        }

        // The app's own .agent-token is its admin credential, hashed on the way
        // in. Re-seeding at every boot follows a rotated token file.
        let existing = adapter.store.grant_by_id(ADMIN_CREDENTIAL_ID);
        let kept = |field: &str| existing.as_ref().map_or(Value::Null, |g| get(g, field).clone());
        let created_at = match kept("createdAt") {
            Value::Null => json!(now_iso()),
            v => v,
        };
        let admin = json!({
            "credentialId": ADMIN_CREDENTIAL_ID, "tokenHash": hash_secret(&config.token),
            "principal": OWNER, "agentName": "local", "scopes": ["*"],
            "createdAt": created_at, "expiresAt": null, "lastUsedAt": kept("lastUsedAt"),
            "revokedAt": null, "task": null, "admin": true,
        });
        adapter.store.put_grant(&admin);
        // Revoked and expired credentials are kept a while so their tokens are
        // told why they stopped; after that they are gone.
        let now = epoch_ms_now();
        for g in adapter.store.list_grants() {
            let expired = get(&g, "expiresAt").as_str().filter(|e| iso_epoch_ms(e).map_or(true, |at| at <= now));
            let ended = get(&g, "revokedAt").as_str().or(expired);
            if ended.map_or(false, |at| now - iso_epoch_ms(at).unwrap_or(0) > GRANT_RETENTION_MS) {
                adapter.store.delete_grant(get_str(&g, "credentialId"));
            }
        }
        // Seed records (materialize server-managed read-only fields) — but only
        // into a store that is genuinely fresh. A durable store that already
        // holds a database refuses the seed: re-seeding on every boot would
        // resurrect seed records the user deleted.
        if adapter.store.wants_seed {
            let seed = adapter.store.seed.clone();
            if let Some(map) = seed.as_object() {
                for (name, records) in map {
                    for raw in records.as_array().map(|a| a.as_slice()).unwrap_or_default() {
                        let rec = adapter.materialize(name, raw);
                        adapter.store.put_record(name, rec);
                    }
                }
            }
        }
        Ok(adapter)
    }

    // -- schema helpers -----------------------------------------------------
    fn fields_of(&self, entity: &str) -> Option<Value> {
        self.entity_defs.get(entity).map(|d| get(d, "fields").clone())
    }

    fn op_decl(&self, name: &str) -> Option<Value> {
        self.operations
            .as_array()
            .and_then(|a| a.iter().find(|o| get_str(o, "name") == name))
            .cloned()
    }

    fn materialize(&self, entity: &str, body: &Value) -> Value {
        let fields = self.fields_of(entity).unwrap_or_else(|| json!([]));
        let rec_id = match body.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => format!("rec_{}", random_hex(8)),
        };
        let mut rec = Map::new();
        rec.insert("id".to_string(), json!(rec_id));
        for f in fields.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let name = get_str(f, "name");
            let value = get(body, name);
            if body.get(name).is_some() && !is_blank(value) {
                rec.insert(name.to_string(), coerce(f, value));
            } else if truthy(get(f, "readOnly")) && name == "created" {
                rec.insert(name.to_string(), json!(now_iso()));
            }
        }
        Value::Object(rec)
    }

    fn schema_version(&self) -> String {
        // Project the defs down to what the fingerprint reads: fields, auth
        // (as a real boolean), module.
        let mut prints = Map::new();
        if let Some(defs) = self.entity_defs.as_object() {
            for (n, d) in defs {
                prints.insert(
                    n.clone(),
                    json!({
                        "fields": get(d, "fields"),
                        "auth": truthy(get(d, "auth")),
                        "module": get(d, "module"),
                    }),
                );
            }
        }
        schema_fingerprint(&Value::Object(prints), Some(&self.operations))
    }

    // -- envelopes ----------------------------------------------------------
    fn err(status: u16, code: &str, message: &str) -> Reply {
        (status, json!({ "a2app": true, "ok": false, "code": code, "message": message }))
    }

    fn err_with(status: u16, code: &str, message: &str, extra: &[(&str, Value)]) -> Reply {
        let (s, mut v) = Self::err(status, code, message);
        for (k, val) in extra {
            v[*k] = val.clone();
        }
        (s, v)
    }

    // -- identity / describe ------------------------------------------------
    pub fn identity(&self) -> Value {
        let mut doc = json!({
            "a2app": true, "protocol": PROTOCOL_VERSION, "adapterVersion": ADAPTER_VERSION,
            "app": { "id": self.app_id, "name": self.app_name },
            "schemaVersion": self.schema_version(),
            "serverNow": now_iso(), "serverTzOffsetMinutes": 0,
            "authMode": self.auth_mode, "accountUrl": ACCOUNT_URL,
        });
        if let Some(env) = &self.env {
            doc["env"] = json!(env);
        }
        if let Some(version) = &self.app_version {
            doc["appVersion"] = json!(version());
        }
        doc
    }

    // -- navigational describe (A2APP-SPEC 3) -------------------------------
    // One request answers for one place in the app, never for the whole app.
    // Parity oracle: adapters/adapter-core/src/describe.ts.

    fn field_doc(f: &Value) -> Value {
        let mut field = Map::new();
        field.insert("type".to_string(), json!(get_str(f, "type")));
        if truthy(get(f, "required")) {
            field.insert("required".to_string(), json!(true));
        }
        if truthy(get(f, "readOnly")) {
            field.insert("readOnly".to_string(), json!(true));
        }
        if !get(f, "max").is_null() {
            field.insert("max".to_string(), get(f, "max").clone());
        }
        if truthy(get(f, "values")) {
            field.insert("values".to_string(), get(f, "values").clone());
        }
        if truthy(get(f, "entity")) {
            field.insert("entity".to_string(), get(f, "entity").clone());
        }
        if truthy(get(f, "dayKey")) {
            field.insert("format".to_string(), json!("YYYY-MM-DD"));
        }
        Value::Object(field)
    }

    /// Everything except write-only.
    ///
    /// Load-bearing beyond describe: a client treats a field absent here as
    /// write-only and exempts it from the read-back check, so dropping anything
    /// else would quietly disable that backstop.
    fn readable_fields(d: &Value) -> Vec<Value> {
        get(d, "fields")
            .as_array()
            .map(|a| a.iter().filter(|f| !truthy(get(f, "writeOnly"))).cloned().collect())
            .unwrap_or_default()
    }

    /// Trim a list until the level fits, always reporting what was dropped.
    /// Budget measured on the compact serialized form actually sent.
    fn fit_list<F: Fn(&[Value], usize) -> Value>(build: F, items: &[Value]) -> Value {
        let fits = |v: &Value| stable_json(v).chars().count() <= DESCRIBE_BUDGET_CHARS;
        let whole = build(items, 0);
        if fits(&whole) {
            return whole;
        }
        let (mut lo, mut hi) = (0usize, items.len());
        while lo < hi {
            let mid = (lo + hi + 1) / 2; // ceil, as the oracle computes it
            if fits(&build(&items[..mid], items.len() - mid)) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        build(&items[..lo], items.len() - lo)
    }

    fn entities_of(&self, module: &str) -> Vec<(String, Value)> {
        self.entity_defs
            .as_object()
            .map(|defs| {
                defs.iter()
                    .filter(|(_, d)| get_str(d, "module") == module)
                    .map(|(n, d)| (n.clone(), d.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn describe_root(&self, access: &Access) -> Value {
        let mut modules = Vec::new();
        for m in self.modules.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let name = get_str(m, "name");
            let owned = self.entities_of(name);
            let ops: Vec<&Value> = self
                .operations
                .as_array()
                .map(|a| a.iter().filter(|o| get_str(o, "module") == name).collect())
                .unwrap_or_default();
            let readable = owned.iter().filter(|(n, _)| access.read(n)).count();
            let writable = owned.iter().filter(|(n, _)| access.write(n)).count();
            let runnable = ops.iter().filter(|o| access.run(get_str(o, "name"))).count();
            let reach = if owned.is_empty() {
                if runnable == 0 {
                    "none"
                } else {
                    "full"
                }
            } else if readable == 0 && runnable == 0 {
                "none"
            } else if writable == owned.len() && runnable == ops.len() {
                "full"
            } else {
                "read-only"
            };
            let mut row = json!({
                "name": name, "entities": owned.len(), "operations": ops.len(), "access": reach,
            });
            if truthy(get(m, "summary")) {
                row["summary"] = get(m, "summary").clone();
            }
            modules.push(row);
        }
        json!({
            "level": "root",
            "app": { "id": self.app_id, "name": self.app_name },
            "modules": modules,
            "conventions": Self::conventions(),
            "next": ["describe/{module}", "describe?find={term}"],
        })
    }

    fn describe_module(&self, module: &Value, access: &Access, show_all: bool) -> Value {
        let module_name = get_str(module, "name").to_string();
        let mut owned = Vec::new();
        for (name, d) in self.entities_of(&module_name) {
            if !access.read(&name) {
                continue;
            }
            let mut row = json!({ "name": name });
            if truthy(get(&d, "summary")) {
                row["summary"] = get(&d, "summary").clone();
            }
            owned.push(row);
        }
        let mut ops = Vec::new();
        for o in self.operations.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            if get_str(o, "module") != module_name || !get(o, "entity").is_null() {
                continue;
            }
            if !access.run(get_str(o, "name")) {
                continue;
            }
            let mut row = json!({ "name": get_str(o, "name"), "destructive": truthy(get(o, "destructive")) });
            if truthy(get(o, "description")) {
                row["summary"] = get(o, "description").clone();
            }
            ops.push(row);
        }

        let mut base_next = vec![format!("describe/{module_name}/{{entity}}")];
        if !ops.is_empty() {
            base_next.push(format!("{module_name} <operation> [--params]"));
        }

        let summary = get(module, "summary").clone();
        let build = |entity_rows: &[Value], truncated: usize| -> Value {
            let mut next: Vec<Value> = base_next.iter().map(|s| json!(s)).collect();
            if truncated > 0 {
                next.push(json!(format!("describe/{module_name}?all=true")));
            }
            let mut level = json!({
                "level": "module",
                "path": module_name.clone(),
                "entities": entity_rows,
                "operations": ops.clone(),
                "next": next,
            });
            if truthy(&summary) {
                level["summary"] = summary.clone();
            }
            if truncated > 0 {
                level["truncated"] = json!(truncated);
            }
            level
        };

        if show_all {
            build(&owned, 0)
        } else {
            Self::fit_list(build, &owned)
        }
    }

    fn describe_entity(&self, module: &str, name: &str, d: &Value, access: &Access) -> Value {
        let mut fields = Map::new();
        for f in Self::readable_fields(d) {
            fields.insert(get_str(&f, "name").to_string(), Self::field_doc(&f));
        }
        let mut ops = Vec::new();
        for o in self.operations.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            if get(o, "entity").as_str() != Some(name) || !access.run(get_str(o, "name")) {
                continue;
            }
            let mut decl = json!({
                "name": get_str(o, "name"),
                "destructive": truthy(get(o, "destructive")),
                "params": if get(o, "params").is_object() { get(o, "params").clone() } else { json!({}) },
            });
            if truthy(get(o, "description")) {
                decl["description"] = get(o, "description").clone();
            }
            if truthy(get(o, "readOnly")) {
                decl["readOnly"] = json!(true);
            }
            if truthy(get(o, "idempotent")) {
                decl["idempotent"] = json!(true);
            }
            decl["entity"] = json!(name);
            ops.push(decl);
        }
        let mut level = json!({
            "level": "entity",
            "path": format!("{module}/{name}"),
            "label": label_field_of(get(d, "fields")),
            "records": format!("/api/collections/{name}/records"),
            "fields": fields,
            "operations": ops,
            "next": [format!("describe/{module}/{name}/{{id}}"), format!("data {name} list")],
        });
        if truthy(get(d, "auth")) {
            level["auth"] = json!(true);
        }
        if truthy(get(d, "ownedBy")) {
            level["ownedBy"] = get(d, "ownedBy").clone();
        }
        level
    }

    fn describe_record(&self, module: &str, name: &str, d: &Value, record: &Value, access: &Access) -> Value {
        let fields = Value::Array(Self::readable_fields(d));
        let label_field = label_field_of(get(d, "fields"));
        let label = label_field.as_ref().map(|lf| get(record, lf).clone()).unwrap_or(Value::Null);

        let mut ops = Vec::new();
        for o in self.operations.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            if get(o, "entity").as_str() != Some(name) || !access.run(get_str(o, "name")) {
                continue;
            }
            let mut row = json!({ "name": get_str(o, "name"), "available": true });
            if truthy(get(o, "destructive")) {
                row["destructive"] = json!(true);
            }
            let when = get(o, "appliesWhen");
            if truthy(when) && !evaluate_predicate(when, record, &fields) {
                row["available"] = json!(false);
                row["blocked"] = json!(explain_predicate(when, record, &fields));
            }
            ops.push(row);
        }

        // Sub-resources are the record's own list<ref> fields: a forward relation
        // is derivable from the type vocabulary alone, with no query grammar.
        let mut relations = Vec::new();
        for f in fields.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            if get_str(f, "type") != "list<ref>" || !truthy(get(f, "entity")) {
                continue;
            }
            let mut row = json!({ "name": get_str(f, "name"), "entity": get_str(f, "entity") });
            if let Some(list) = get(record, get_str(f, "name")).as_array() {
                row["count"] = json!(list.len());
            }
            relations.push(row);
        }

        let rec_id = get_str(record, "id");
        let path = format!("{module}/{name}/{rec_id}");
        let mut next: Vec<Value> = relations
            .iter()
            .map(|r| json!(format!("describe/{path}/{}", get_str(r, "name"))))
            .collect();
        for o in &ops {
            if truthy(get(o, "available")) {
                next.push(json!(format!("{path} {}", get_str(o, "name"))));
            }
        }
        next.push(json!(format!("data {name} get {rec_id}")));

        let label_out = match &label {
            Value::Null => Value::Null,
            Value::String(_) => label.clone(),
            other => json!(py_str(other)),
        };
        let mut level = json!({
            "level": "record",
            "path": path,
            "id": rec_id,
            "label": label_out,
            "operations": ops,
            "next": next,
        });
        if !relations.is_empty() {
            level["relations"] = json!(relations);
        }
        level
    }

    fn describe_find(&self, term: &str, access: &Access) -> Value {
        let needle = term.to_lowercase();
        let mut matches = Vec::new();
        for m in self.modules.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let name = get_str(m, "name");
            if name.to_lowercase().contains(&needle) {
                matches.push(json!({ "path": name, "level": "module" }));
            }
        }
        if let Some(defs) = self.entity_defs.as_object() {
            for (name, d) in defs {
                if access.read(name) && name.to_lowercase().contains(&needle) {
                    matches.push(json!({ "path": format!("{}/{name}", get_str(d, "module")), "level": "entity" }));
                }
            }
        }
        for o in self.operations.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let op_name = get_str(o, "name");
            if access.run(op_name) && op_name.to_lowercase().contains(&needle) {
                let path = match get(o, "entity").as_str() {
                    Some(entity) => format!("{}/{entity}", get_str(o, "module")),
                    None => get_str(o, "module").to_string(),
                };
                matches.push(json!({ "path": path, "operation": op_name }));
            }
        }

        let term_owned = term.to_string();
        let build = |items: &[Value], truncated: usize| -> Value {
            let mut level = json!({
                "level": "find", "term": term_owned.clone(), "matches": items, "next": ["describe/{path}"],
            });
            if truncated > 0 {
                level["truncated"] = json!(truncated);
            }
            level
        };
        Self::fit_list(build, &matches)
    }

    fn conventions() -> Value {
        json!({
            "writes": "Prefer a declared operation over a raw write where one exists.",
            "labels": "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
            "dates": "Relative words (\"tomorrow\") are rejected by the app; resolve them to ISO 8601 client-side.",
            "honesty": "If the app cannot express what was asked, say so instead of approximating into a wrong field.",
        })
    }

    // -- IAM ----------------------------------------------------------------
    // Who a request acts for (spec/v0_2/auth.md §9), in a fixed order: the
    // Host (in `dispatch`), a foreign Origin, the agent credential, then the
    // session (multi-user) or the app's own View (single-user), then nothing.
    // What it may do is its credential's scopes intersected with what its
    // person may do now (the ceiling, §3), evaluated on every request.

    fn multi_user(&self) -> bool {
        self.auth_mode == "multi-user"
    }

    /// Every scope the app declares: what `*` means.
    fn all_scopes(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        if let Some(defs) = self.entity_defs.as_object() {
            for name in defs.keys() {
                out.insert(format!("data:{name}:read"));
                out.insert(format!("data:{name}:write"));
            }
        }
        for o in self.operations.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            out.insert(format!("op:{}", get_str(o, "name")));
        }
        out
    }

    fn expand_scopes(&self, scopes: &[String]) -> BTreeSet<String> {
        if scopes.iter().any(|s| s == "*") {
            self.all_scopes()
        } else {
            scopes.iter().cloned().collect()
        }
    }

    /// Who a principal is — `{id, name, role, active}` — or None when unknown.
    fn principal_info(&self, id: &str) -> Option<Value> {
        if id == OWNER {
            return Some(json!({ "id": OWNER, "name": "Owner", "role": "owner", "active": true }));
        }
        if !self.multi_user() {
            return None;
        }
        self.store.row("users", id).map(|a| {
            json!({
                "id": get(&a, "id"), "name": get(&a, "name"), "role": get(&a, "role"), "active": get(&a, "active"),
            })
        })
    }

    /// What a principal may do now (spec §3), or None when it may do nothing.
    fn permissions(&self, info: Option<&Value>) -> Option<BTreeSet<String>> {
        let info = info.filter(|i| truthy(get(i, "active")))?;
        let scopes = match self.permissions_of {
            Some(permissions_of) => permissions_of(info),
            None => vec!["*".to_string()],
        };
        Some(self.expand_scopes(&scopes))
    }

    /// The credential this request presents, checked in spec §9's order:
    /// unknown, revoked (or its task is over), expired, then whether the person
    /// it acts for may still act. Ok holds the grant, its principal and its
    /// effective reach — its own scopes intersected with the principal's; None
    /// when no credential was presented.
    fn credential_of(
        &mut self,
        headers: &HashMap<String, String>,
    ) -> Option<Result<(Value, Value, BTreeSet<String>), Reply>> {
        let token = headers
            .get("x-a2app-token")
            .or_else(|| headers.get("x-lui-token"))
            .filter(|t| !t.is_empty())?;
        let now = epoch_ms_now();
        let Some(grant) = self.store.grant_by_token_hash(&hash_secret(token)) else {
            return Some(Err(Self::err_with(
                401,
                "credential_invalid",
                "This credential is not one this app issued.",
                &[("how", json!(RENEW_HINT))],
            )));
        };
        let task_over = get(&grant, "task").as_str().map(|task_id| {
            self.store.get_task(task_id).map_or(true, |t| TERMINAL_TASK.contains(&get_str(&t, "status")))
        });
        if !get(&grant, "revokedAt").is_null() || task_over == Some(true) {
            return Some(Err(Self::err_with(
                401,
                "credential_revoked",
                "This credential was revoked.",
                &[("how", json!(RENEW_HINT))],
            )));
        }
        if let Some(expires_at) = get(&grant, "expiresAt").as_str() {
            if iso_epoch_ms(expires_at).map_or(true, |at| at <= now) {
                return Some(Err(Self::err_with(
                    401,
                    "token_expired",
                    &format!("This credential expired at {expires_at}."),
                    &[("how", json!(RENEW_HINT))],
                )));
            }
        }
        let info = self.principal_info(get_str(&grant, "principal"));
        let (Some(allowed), Some(info)) = (self.permissions(info.as_ref()), info) else {
            return Some(Err(Self::err(
                401,
                "principal_inactive",
                "The person this credential acts for is no longer active.",
            )));
        };
        let stale = get(&grant, "lastUsedAt")
            .as_str()
            .and_then(iso_epoch_ms)
            .map_or(true, |at| now - at >= LAST_USED_RESOLUTION_MS);
        if stale {
            let mut used = grant.clone();
            used["lastUsedAt"] = json!(iso_of_ms(now));
            self.store.put_grant(&used);
        }
        let scopes: Vec<String> = get(&grant, "scopes")
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let held = self.expand_scopes(&scopes).intersection(&allowed).cloned().collect();
        Some(Ok((grant, info, held)))
    }

    /// True when the request carries an Origin that is not one of the app's
    /// own. A program sends none.
    fn is_foreign_origin(&self, headers: &HashMap<String, String>) -> bool {
        headers.get("origin").map_or(false, |o| !self.allowed_origins.contains(o))
    }

    /// True when the request carries one of the app's OWN origins.
    fn is_same_origin(&self, headers: &HashMap<String, String>) -> bool {
        headers.get("origin").map_or(false, |o| self.allowed_origins.contains(o))
    }

    /// Whether a request came from one of the app's own pages. A browser marks
    /// same-origin fetches, GETs included, with Sec-Fetch-Site; a program sends
    /// neither header. On a multi-user app it only ever picks which 401 to send
    /// (sign in, or present a credential) — it never lets a request in.
    fn from_own_page(&self, headers: &HashMap<String, String>) -> bool {
        self.is_same_origin(headers) || headers.get("sec-fetch-site").map(String::as_str) == Some("same-origin")
    }

    /// The signed-in account behind this request's session cookie, if any, as
    /// (session key, account row). A deactivated account's session stops here.
    fn session_of(&mut self, headers: &HashMap<String, String>) -> Option<(String, Value)> {
        if !self.multi_user() {
            return None;
        }
        let cookies = parse_cookies(headers.get("cookie").map(String::as_str).unwrap_or(""));
        let secret = cookies.get(&self.session_cookie_name).filter(|s| !s.is_empty())?;
        let key = hash_secret(secret);
        let session = self.store.row("sessions", &key)?;
        if iso_epoch_ms(get_str(&session, "expiresAt")).map_or(true, |at| at <= epoch_ms_now()) {
            self.store.delete_row("sessions", &key);
            return None;
        }
        let account = self.store.row("users", get_str(&session, "principal"))?;
        truthy(get(&account, "active")).then_some((key, account))
    }

    fn unauthenticated(&self, headers: &HashMap<String, String>, message: &str) -> Reply {
        if self.multi_user() && self.from_own_page(headers) {
            return Self::err_with(
                401,
                "sign_in_required",
                "Sign in to use this app.",
                &[("signInUrl", json!(format!("{ACCOUNT_URL}#sign-in")))],
            );
        }
        Self::err_with(401, ERR_AGENT_TOKEN_REQUIRED, message, &[("how", json!(self.credential_hint))])
    }

    fn call_ctx(credential_id: &str, agent_name: &Value, principal: &str, role: &str) -> Value {
        json!({ "credentialId": credential_id, "agentName": agent_name, "principal": principal, "role": role })
    }

    /// Who the caller is, in spec §9's order: a foreign origin is refused; then
    /// the agent credential; then, on a multi-user app, the session (a change
    /// must come from the app's own page — CSRF); on `authMode: none`, the
    /// app's own View is the owner. Returns the caller with its reach, or the
    /// refusal.
    fn resolve(&mut self, headers: &HashMap<String, String>, is_write: bool) -> Result<Caller, Reply> {
        if self.is_foreign_origin(headers) {
            return Err(Self::err(403, "forbidden_origin", "Refused: request Origin is not this app's own."));
        }
        if let Some(presented) = self.credential_of(headers) {
            let (grant, info, held) = presented?;
            let ctx = Self::call_ctx(
                get_str(&grant, "credentialId"),
                get(&grant, "agentName"),
                get_str(&info, "id"),
                get_str(&info, "role"),
            );
            return Ok(Caller { ctx, held: Some(held), grant: Some(grant) });
        }
        if self.multi_user() {
            let Some((_, account)) = self.session_of(headers) else {
                return Err(self.unauthenticated(headers, "This app needs a credential."));
            };
            if is_write && !self.is_same_origin(headers) {
                return Err(Self::err(
                    403,
                    "forbidden_origin",
                    "A signed-in change must come from this app's own page.",
                ));
            }
            let id = get_str(&account, "id");
            let held = self.permissions(self.principal_info(id).as_ref()).unwrap_or_default();
            let ctx = Self::call_ctx("session", &Value::Null, id, get_str(&account, "role"));
            return Ok(Caller { ctx, held: Some(held), grant: None });
        }
        // The app's own UI (same origin) is trusted: no credential needed. A
        // browser sends Origin only on a change; on a read it marks the request
        // with Sec-Fetch-Site, which a web page cannot forge. A local program
        // can, but on this mode it already reads everything without a
        // credential, so only a change is held to the stronger Origin rule.
        if self.is_same_origin(headers) || (!is_write && self.from_own_page(headers)) {
            let held = self.permissions(self.principal_info(OWNER).as_ref()).unwrap_or_default();
            let ctx = Self::call_ctx("ui", &Value::Null, OWNER, "owner");
            return Ok(Caller { ctx, held: Some(held), grant: None });
        }
        // A program write always needs a credential; an anonymous read on a
        // single-user app proceeds as the owner.
        if is_write {
            return Err(self.unauthenticated(headers, "This write requires an agent credential."));
        }
        Ok(Caller { ctx: Self::call_ctx("anonymous", &Value::Null, OWNER, "owner"), held: None, grant: None })
    }

    /// The fixed chain: origin -> credential -> scope. Returns the call
    /// context on success, or the refusal.
    fn authorize(
        &mut self,
        headers: &HashMap<String, String>,
        scope: Option<&str>,
        is_write: bool,
    ) -> Result<Value, Reply> {
        let caller = self.resolve(headers, is_write)?;
        if let (Some(scope), Some(held)) = (scope, &caller.held) {
            if !held.contains(scope) {
                return Err(Self::err_with(
                    403,
                    ERR_INSUFFICIENT_SCOPE,
                    &format!("This credential does not hold {scope}."),
                    &[("required", json!(scope))],
                ));
            }
        }
        Ok(caller.ctx)
    }

    /// The caller as a manager of accounts and credentials (spec §2.4): a
    /// signed-in person, the app's own View on `authMode: none`, or the admin
    /// credential. An agent's delegated credential is never one.
    fn manager_of(&mut self, headers: &HashMap<String, String>, write: bool) -> Result<Manager, Reply> {
        let caller = self.resolve(headers, write)?;
        if let Some(grant) = &caller.grant {
            if get(grant, "admin") != &json!(true) {
                return Err(Self::err(
                    403,
                    "not_a_manager",
                    "An agent's credential cannot manage accounts or credentials.",
                ));
            }
            return Ok(Manager { principal: OWNER.to_string(), role: "owner".to_string() });
        }
        if get_str(&caller.ctx, "credentialId") == "anonymous" {
            return Err(self.unauthenticated(headers, "Managing this app needs a credential."));
        }
        Ok(Manager {
            principal: get_str(&caller.ctx, "principal").to_string(),
            role: get_str(&caller.ctx, "role").to_string(),
        })
    }

    /// Where this app is reached, for links handed to a person. The Host
    /// header has already passed the host check by the time a route runs.
    fn public_origin(&self, headers: &HashMap<String, String>) -> String {
        if let Some(public) = &self.public_url {
            return public.clone();
        }
        match headers.get("host") {
            Some(host) => format!("http://{host}"),
            None => self.own_origins.first().cloned().unwrap_or_default(),
        }
    }

    fn rate_gate(&mut self, headers: &HashMap<String, String>, class: &str) -> Option<Reply> {
        let caller = headers
            .get("x-a2app-token")
            .cloned()
            .or_else(|| headers.get("origin").map(|o| format!("origin:{o}")))
            .unwrap_or_else(|| "anon".to_string());
        let decision = self.limiter.check(&caller, class);
        if decision.allowed {
            return None;
        }
        Some(Self::err_with(
            429,
            ERR_RATE_LIMITED,
            &format!("Rate limit exceeded ({} per window). Slow down and retry.", decision.limit),
            &[("retryAfterSeconds", json!(decision.retry_after_seconds))],
        ))
    }

    /// What this caller may do, for rendering access on a describe level.
    ///
    /// Mirrors `authorize`'s own precedence: a refused caller sees nothing, and
    /// an anonymous read on a single-user app — which reaches a context without
    /// meeting the scope check — may read everything and run read-only
    /// operations, but write nothing (its writes answer 401). Over-reporting
    /// there would let an agent plan against permission it never held.
    fn access_for(&mut self, headers: &HashMap<String, String>) -> Access {
        match self.resolve(headers, false) {
            Err(_) => Access(BTreeSet::new()),
            Ok(Caller { held: Some(held), .. }) => Access(held),
            Ok(Caller { held: None, .. }) => Access(self.anonymous_reach()),
        }
    }

    /// An anonymous caller's reach on a single-user app, as scope names.
    fn anonymous_reach(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        if let Some(defs) = self.entity_defs.as_object() {
            for name in defs.keys() {
                out.insert(format!("data:{name}:read"));
            }
        }
        for o in self.operations.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            if get(o, "readOnly") == &json!(true) {
                out.insert(format!("op:{}", get_str(o, "name")));
            }
        }
        out
    }

    // -- ownership (spec/v0_2/auth.md §5) -----------------------------------

    /// The field naming each record's owner in entity `d`, when `ctx` sees only
    /// the records it owns: a member of a multi-user app.
    fn owned_only<'a>(&self, d: &'a Value, ctx: &Value) -> Option<&'a str> {
        let field = get(d, "ownedBy").as_str().filter(|f| !f.is_empty())?;
        (self.multi_user() && get_str(ctx, "role") != "owner").then_some(field)
    }

    /// Whether `ctx` may see `rec` — another member's record is
    /// indistinguishable from a missing one.
    fn visible(&self, d: &Value, ctx: &Value, rec: &Value) -> bool {
        match self.owned_only(d, ctx) {
            Some(field) => get(rec, field).as_str() == Some(get_str(ctx, "principal")),
            None => true,
        }
    }

    // -- dispatch -----------------------------------------------------------

    /// Serve one level of describe.
    ///
    /// The record and relation levels read real records, which makes them data
    /// reads: they take the same scope and rate class as the records API.
    /// Without that, describe would be an unmetered path around the scope model.
    fn handle_describe(
        &mut self,
        headers: &HashMap<String, String>,
        segments: &[String],
        q: &HashMap<String, String>,
    ) -> Reply {
        let access = self.access_for(headers);

        if let Some(find) = q.get("find") {
            if segments.is_empty() {
                if find.is_empty() {
                    return Self::err(400, "usage", "find needs a term: describe?find={term}");
                }
                return (200, self.describe_find(find, &access));
            }
        }

        if segments.is_empty() {
            return (200, self.describe_root(&access));
        }

        let module_name = &segments[0];
        let module = self
            .modules
            .as_array()
            .and_then(|a| a.iter().find(|m| get_str(m, "name") == module_name.as_str()))
            .cloned();
        let module = match module {
            Some(m) => m,
            None => {
                let names: Vec<&str> = self
                    .modules
                    .as_array()
                    .map(|a| a.iter().map(|m| get_str(m, "name")).collect())
                    .unwrap_or_default();
                return Self::err_with(
                    404,
                    "unknown_module",
                    &format!("No module \"{module_name}\"."),
                    &[("modules", json!(names))],
                );
            }
        };
        if segments.len() == 1 {
            let show_all = q.get("all").map(String::as_str) == Some("true");
            return (200, self.describe_module(&module, &access, show_all));
        }

        let entity = &segments[1];
        let d = match self.entity_defs.get(entity.as_str()) {
            Some(d) => d.clone(),
            None => return Self::err(404, "unknown_entity", &format!("No such entity \"{entity}\".")),
        };
        if get_str(&d, "module") != module_name.as_str() {
            return Self::err(
                404,
                "unknown_entity",
                &format!("Entity \"{entity}\" is in module \"{}\", not \"{module_name}\".", get_str(&d, "module")),
            );
        }
        if segments.len() == 2 {
            if !access.read(entity) {
                return Self::err_with(
                    403,
                    ERR_INSUFFICIENT_SCOPE,
                    &format!("This credential does not hold data:{entity}:read."),
                    &[("required", json!(format!("data:{entity}:read")))],
                );
            }
            return (200, self.describe_entity(module_name, entity, &d, &access));
        }

        if let Some(limited) = self.rate_gate(headers, "data") {
            return limited;
        }
        let ctx = match self.authorize(headers, Some(&format!("data:{entity}:read")), false) {
            Ok(ctx) => ctx,
            Err(reply) => return reply,
        };

        let record_id = &segments[2];
        let record = match self.store.get_record(entity, record_id).filter(|r| self.visible(&d, &ctx, r)) {
            Some(r) => r,
            None => return Self::err(404, "record_not_found", &format!("No {entity} record \"{record_id}\".")),
        };
        if segments.len() == 3 {
            return (200, self.describe_record(module_name, entity, &d, &record, &access));
        }

        let relation = &segments[3];
        let field = get(&d, "fields").as_array().and_then(|a| {
            a.iter()
                .find(|f| {
                    get_str(f, "name") == relation.as_str()
                        && get_str(f, "type") == "list<ref>"
                        && truthy(get(f, "entity"))
                        && !truthy(get(f, "writeOnly"))
                })
                .cloned()
        });
        let field = match field {
            Some(f) => f,
            None => return Self::err(404, "unknown_relation", &format!("\"{relation}\" is not a sub-resource of {entity}.")),
        };
        let target = get_str(&field, "entity").to_string();
        if !access.read(&target) {
            return Self::err_with(
                403,
                ERR_INSUFFICIENT_SCOPE,
                &format!("This credential does not hold data:{target}:read."),
                &[("required", json!(format!("data:{target}:read")))],
            );
        }
        let target_label = self
            .entity_defs
            .get(&target)
            .and_then(|td| label_field_of(get(td, "fields")));
        let mut items = Vec::new();
        for rid in get(&record, relation).as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let rid_str = py_str(rid);
            let referenced = self.store.get_record(&target, &rid_str);
            let label = match (&referenced, &target_label) {
                (Some(rec), Some(lf)) => get(rec, lf).clone(),
                _ => Value::Null,
            };
            let label_out = match &label {
                Value::Null => Value::Null,
                Value::String(_) => label.clone(),
                other => json!(py_str(other)),
            };
            items.push(json!({ "id": rid_str, "label": label_out }));
        }

        let path = format!("{module_name}/{entity}/{record_id}/{relation}");
        let next0 = format!("data {target} get {{id}}");
        let next1 = format!("describe/{module_name}/{entity}/{record_id}");
        let build = |rows: &[Value], truncated: usize| -> Value {
            let mut level = json!({
                "level": "relation", "path": path.clone(), "entity": target.clone(), "items": rows,
                "next": [next0.clone(), next1.clone()],
            });
            if truncated > 0 {
                level["truncated"] = json!(truncated);
            }
            level
        };
        (200, Self::fit_list(build, &items))
    }

    fn is_allowed_host(&self, raw: &str) -> bool {
        if self.allowed_hosts.contains(&raw.to_ascii_lowercase()) {
            return true;
        }
        hostname_of(raw).map_or(false, |name| is_loopback_name(&name) || self.allowed_hosts.contains(&name))
    }

    pub fn dispatch(
        &mut self,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: Option<&Value>,
        query: &HashMap<String, String>,
    ) -> Answer {
        let headers: HashMap<String, String> =
            headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
        let method = method.to_uppercase();
        let mut q = query.clone();
        let mut path = path.to_string();
        if let Some(idx) = path.find('?') {
            let qs = path[idx + 1..].to_string();
            path.truncate(idx);
            for (k, v) in parse_qs(&qs) {
                q.insert(k, v); // last value wins, as the oracle's parse does
            }
        }
        let trimmed = path.trim_end_matches('/');
        let path = if trimmed.is_empty() { "/" } else { trimmed };
        let answer = |(status, json): Reply| Answer { status, json, headers: Vec::new() };

        // Before any route, including the unauthenticated identity document,
        // which is otherwise a free fingerprint of the app for a rebound page:
        // binding loopback does not stop a page on evil.com whose DNS
        // re-resolves to 127.0.0.1, but its Host header still says evil.com.
        if let Some(host) = headers.get("host") {
            if !self.is_allowed_host(host) {
                return answer(Self::err(
                    403,
                    "forbidden_host",
                    &format!("Refused: this app answers only on its own host, not \"{host}\"."),
                ));
            }
        }

        // Accounts, sessions and invites (multi-user only) — the routes that
        // set a cookie.
        let account_route = ["/api/_a2app/session", "/api/_a2app/invites", "/api/_a2app/users"]
            .iter()
            .any(|p| path == *p || path.starts_with(&format!("{p}/")));
        if account_route {
            if !self.multi_user() {
                return answer(Self::err(404, "not_multi_user", "This app has no accounts: its authMode is none."));
            }
            let body = body.cloned().unwrap_or_else(|| json!({}));
            let (reply, cookie) = self.handle_accounts(&method, path, &headers, &body);
            let mut out = answer(reply);
            if let Some(cookie) = cookie {
                out.headers.push(("Set-Cookie".to_string(), cookie));
            }
            return out;
        }
        answer(self.route(&method, path, &headers, body, &q))
    }

    /// Every route but the account routes, after the Host check.
    fn route(
        &mut self,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: Option<&Value>,
        q: &HashMap<String, String>,
    ) -> Reply {
        if path == "/.well-known/a2app.json" || path == "/api/_a2app" {
            return (200, self.identity());
        }
        // Describe is navigational: the bare path is the root level, and each
        // extra segment moves one level inward (A2APP-SPEC 3).
        if path == "/api/_a2app/describe" {
            return self.handle_describe(headers, &[], q);
        }
        if let Some(rest) = path.strip_prefix("/api/_a2app/describe/") {
            let segments: Vec<String> = rest.split('/').map(percent_decode).collect();
            if segments.len() > 4 {
                return Self::err(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.");
            }
            if segments.iter().any(String::is_empty) {
                return Self::err(404, "usage", "describe path has an empty segment.");
            }
            return self.handle_describe(headers, &segments, q);
        }
        if path == "/api/_a2app/whoami" {
            // whoami answers whoever this app will actually serve, which is
            // what `authorize` decides — so it asks the same question. The 401
            // that remains is the honest one: on a multi-user app `authorize`
            // really would refuse.
            let caller = match self.resolve(headers, false) {
                Ok(caller) => caller,
                Err(reply) => return reply,
            };
            // The reach the request was given: a credential's scopes
            // intersected with what its person may do now, or a person's own.
            // An anonymous read was never scope-checked, so it reports the
            // reach describe renders for it — one source, so the two agree.
            let scopes = match caller.held {
                Some(held) => held,
                None => self.anonymous_reach(),
            };
            let principal = get_str(&caller.ctx, "principal");
            let principal_name = self.principal_info(principal).map_or(Value::Null, |p| get(&p, "name").clone());
            return (
                200,
                json!({
                    "a2app": true,
                    "credentialId": get(&caller.ctx, "credentialId"),
                    "agentName": get(&caller.ctx, "agentName"),
                    "principal": principal,
                    "principalName": principal_name,
                    "role": get(&caller.ctx, "role"),
                    "expiresAt": caller.grant.as_ref().map_or(Value::Null, |g| get(g, "expiresAt").clone()),
                    "scopes": scopes.into_iter().collect::<Vec<_>>(),
                }),
            );
        }
        if let Some(rest) = path.strip_prefix("/api/_a2app/auth/") {
            // Unauthenticated by design (an agent starts here with nothing), so
            // it is metered like an operation before anything is looked up.
            if let Some(limited) = self.rate_gate(headers, "ops") {
                return limited;
            }
            let body = body.cloned().unwrap_or_else(|| json!({}));
            if let Some(reply) = self.handle_device(method, rest, headers, &body) {
                return reply;
            }
        }
        if path == "/api/_a2app/credentials" || path.starts_with("/api/_a2app/credentials/") {
            let id = path.strip_prefix("/api/_a2app/credentials/").map(percent_decode);
            let body = body.cloned().unwrap_or_else(|| json!({}));
            return self.handle_credentials(method, id.as_deref(), headers, &body);
        }
        if path == "/api/_a2app/context" {
            if let Err(reply) = self.authorize(headers, None, false) {
                return reply;
            }
            return (200, json!({ "a2app": true, "view": null, "selected": [] }));
        }
        if path == "/api/_a2app/events" {
            return self.handle_events(headers, q);
        }
        if path == "/api/_a2app/tasks" || path.starts_with("/api/_a2app/tasks/") {
            let rest: Vec<String> = match path.strip_prefix("/api/_a2app/tasks/") {
                Some(r) => r.split('/').map(str::to_string).collect(),
                None => Vec::new(),
            };
            return self.handle_tasks(method, headers, &rest, body, q);
        }

        if let Some(rest) = path.strip_prefix("/api/collections/") {
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() >= 2 && !parts[0].is_empty() && parts[1] == "records" {
                if parts.len() == 2 {
                    return self.handle_records(method, headers, parts[0], None, body, q);
                }
                if parts.len() == 3 && !parts[2].is_empty() {
                    return self.handle_records(method, headers, parts[0], Some(parts[2]), body, q);
                }
            }
        }

        if let Some(name) = path.strip_prefix("/api/ops/") {
            if !name.is_empty() && !name.contains('/') {
                if method != "POST" {
                    return Self::err(405, "usage", "Operations are POST-only.");
                }
                let args = body.cloned().unwrap_or_else(|| json!({}));
                return self.handle_operation(headers, name, &args);
            }
        }

        Self::err(404, "not_found", "No such route. Operations are invoked with POST /api/ops/<name>; GET /api/_a2app/describe lists them.")
    }

    // -- records ------------------------------------------------------------
    fn handle_records(
        &mut self,
        method: &str,
        headers: &HashMap<String, String>,
        entity: &str,
        rec_id: Option<&str>,
        body: Option<&Value>,
        query: &HashMap<String, String>,
    ) -> Reply {
        if let Some(limited) = self.rate_gate(headers, "data") {
            return limited;
        }
        let d = match self.entity_defs.get(entity) {
            Some(d) => d.clone(),
            None => return Self::err(404, "unknown_entity", &format!("No such entity \"{entity}\".")),
        };
        let fields = get(&d, "fields").clone();
        let server_now = now_iso();

        if method == "GET" {
            let ctx = match self.authorize(headers, Some(&format!("data:{entity}:read")), false) {
                Ok(ctx) => ctx,
                Err(reply) => return reply,
            };
            if let Some(rec_id) = rec_id {
                return match self.store.get_record(entity, rec_id).filter(|r| self.visible(&d, &ctx, r)) {
                    Some(rec) => (200, rec),
                    None => Self::err(404, "record_not_found", &format!("No {entity} record \"{rec_id}\".")),
                };
            }
            // `where` is the adapter's alone: a member sees only the records it
            // owns, constrained before paging so the counts are theirs too.
            let mut query_value: Map<String, Value> =
                query.iter().filter(|(k, _)| k.as_str() != "where").map(|(k, v)| (k.clone(), json!(v))).collect();
            if let Some(field) = self.owned_only(&d, &ctx) {
                query_value.insert("where".to_string(), json!({ field: get(&ctx, "principal") }));
            }
            return match self.store.list_records(entity, &Value::Object(query_value)) {
                Ok(listed) => (200, listed),
                // Refuse, never ignore: unfiltered rows under a filter would be
                // a 200 with the wrong records (see the grammar's comment).
                Err(e) => Self::err(400, "invalid_filter", &e.to_string()),
            };
        }

        let ctx = match self.authorize(headers, Some(&format!("data:{entity}:write")), true) {
            Ok(ctx) => ctx,
            Err(reply) => return reply,
        };
        let body = body.cloned().unwrap_or_else(|| json!({}));
        // Another member's record answers exactly as a missing one does.
        let foreign = |adapter: &Self, rec_id: &str| {
            adapter.owned_only(&d, &ctx).is_some()
                && !adapter.store.get_record(entity, rec_id).map_or(false, |r| adapter.visible(&d, &ctx, &r))
        };

        if method == "DELETE" {
            let rec_id = match rec_id {
                Some(id) => id,
                None => return Self::err(400, "usage", "DELETE requires a record id."),
            };
            if foreign(self, rec_id) {
                return Self::err(404, "record_not_found", &format!("No {entity} record \"{rec_id}\"."));
            }

            // The app's referential rules bind THIS door too.
            //
            // An app that guards deletion inside an operation has guarded one way
            // in: its own UI. This generic record route is the other, and it used
            // to go straight to the store — so the rule held right up until an
            // agent took the path the rule did not cover, and the orphan it left
            // was reported as a successful delete. The check belongs here, in
            // adapter code an app author cannot edit, because this is the only
            // place both doors pass through.
            let blockers = references_to(&self.entity_defs, &self.store, entity, rec_id);
            if !blockers.is_empty() {
                let total: usize = blockers
                    .iter()
                    .map(|b| get(b, "ids").as_array().map_or(0, Vec::len))
                    .sum();
                let where_list: Vec<String> = blockers
                    .iter()
                    .map(|b| format!("{}.{}", get_str(b, "entity"), get_str(b, "field")))
                    .collect();
                let said = if total == 1 {
                    "a record still references".to_string()
                } else {
                    format!("{total} records still reference")
                };
                return Self::err_with(
                    409,
                    ERR_RECORD_REFERENCED,
                    &format!("Cannot delete {entity} \"{rec_id}\": {said} it ({}).", where_list.join(", ")),
                    &[
                        ("referencedBy", json!(blockers)),
                        (
                            "resolution",
                            json!(
                                "Remove or repoint the referencing records first, or run an operation the app \
                                 provides for this. An app that intends references to outlive the record \
                                 declares `onDelete: \"ignore\"` on the ref."
                            ),
                        ),
                    ],
                );
            }

            if !self.store.delete_record(entity, rec_id) {
                return Self::err(404, "record_not_found", &format!("No {entity} record \"{rec_id}\"."));
            }
            return (200, json!({ "a2app": true, "ok": true, "deleted": rec_id }));
        }

        if method != "POST" && method != "PATCH" {
            return Self::err(405, "usage", &format!("{method} not allowed on records."));
        }

        let idem = headers.get("idempotency-key").cloned();
        if let Some(key) = &idem {
            if method == "POST" {
                if let Some(prior) = self.store.idem_get(entity, key) {
                    return Self::err_with(
                        409,
                        ERR_DUPLICATE_REQUEST,
                        "This idempotency key already produced a record.",
                        &[("id", json!(prior))],
                    );
                }
            }
        }

        let allow = match get(&d, "writeAllow").as_array() {
            Some(list) => {
                let mut m = Map::new();
                for k in list {
                    if let Some(k) = k.as_str() {
                        m.insert(k.to_string(), json!(true));
                    }
                }
                Some(Value::Object(m))
            }
            None => None,
        };
        let violations = validate(&fields, &body, allow.as_ref());
        if !violations.is_empty() {
            let first = &violations[0];
            return (
                400,
                json!({
                    "a2app": true, "ok": false, "code": get(first, "code"), "field": get(first, "field"),
                    "expected": get(first, "expected"), "got": get(first, "got"),
                    "message": describe_violation(first, Some(&server_now)),
                    "violations": violations,
                }),
            );
        }

        // Backend write. The owner field is the adapter's to set: the guard has
        // already refused a client that tried, because it is read-only.
        let stored: Value;
        if method == "POST" {
            let create = match get(&d, "ownedBy").as_str().filter(|f| !f.is_empty()) {
                Some(field) => {
                    let mut owned = body.as_object().cloned().unwrap_or_default();
                    owned.insert(field.to_string(), get(&ctx, "principal").clone());
                    Value::Object(owned)
                }
                None => body.clone(),
            };
            stored = self.materialize(entity, &create);
            self.store.put_record(entity, stored.clone());
        } else {
            let rec_id = match rec_id {
                Some(id) => id,
                None => return Self::err(400, "usage", "PATCH requires a record id."),
            };
            if foreign(self, rec_id) {
                return Self::err(404, "record_not_found", &format!("No {entity} record \"{rec_id}\"."));
            }
            let mut existing = match self.store.get_record(entity, rec_id) {
                Some(rec) => rec,
                None => return Self::err(404, "record_not_found", &format!("No {entity} record \"{rec_id}\".")),
            };
            for f in fields.as_array().map(|a| a.as_slice()).unwrap_or_default() {
                let name = get_str(f, "name");
                if truthy(get(f, "readOnly")) || body.get(name).is_none() {
                    continue;
                }
                let v = get(&body, name);
                if v.is_null() || v.as_str() == Some("") {
                    if let Some(obj) = existing.as_object_mut() {
                        obj.remove(name);
                    }
                } else {
                    existing[name] = coerce(f, v);
                }
            }
            self.store.put_record(entity, existing.clone());
            stored = existing;
        }

        let lost = divergences(&fields, &body, |n| get(&stored, n).clone());
        if !lost.is_empty() {
            let short: Vec<Value> = lost
                .iter()
                .map(|l| json!({ "code": ERR_NOT_STORED, "field": get(l, "field") }))
                .collect();
            return (
                422,
                json!({
                    "a2app": true, "ok": false, "code": ERR_NOT_STORED,
                    "message": describe_incomplete(&lost),
                    "violations": short,
                    "id": get(&stored, "id"),
                }),
            );
        }

        if let Some(key) = &idem {
            if method == "POST" {
                let id = get_str(&stored, "id").to_string();
                self.store.idem_put(entity, key, &id);
            }
        }
        (200, stored)
    }

    // -- operations ---------------------------------------------------------
    fn handle_operation(&mut self, headers: &HashMap<String, String>, name: &str, args: &Value) -> Reply {
        if let Some(limited) = self.rate_gate(headers, "ops") {
            return limited;
        }
        let decl = match self.op_decl(name) {
            Some(d) => d,
            None => return Self::err(404, "unknown_operation", &format!("No declared operation \"{name}\".")),
        };
        let ctx = match self.authorize(headers, Some(&format!("op:{name}")), !truthy(get(&decl, "readOnly"))) {
            Ok(ctx) => ctx,
            Err(reply) => return reply,
        };

        if truthy(get(&decl, "destructive")) {
            let key = approval_key(name, args);
            let provided = headers.get("x-a2app-approval").or_else(|| headers.get("x-lui-approval"));
            match provided {
                None => {
                    self.store.approval_issue(&key);
                    return Self::err_with(
                        428,
                        ERR_APPROVAL_REQUIRED,
                        &format!("Operation \"{name}\" is destructive and requires approval."),
                        &[("approvalKey", json!(key))],
                    );
                }
                Some(provided) => {
                    if provided != &key || !self.store.approval_consume(&key) {
                        return Self::err_with(
                            428,
                            ERR_APPROVAL_REQUIRED,
                            "Approval key does not match this exact call (or has expired).",
                            &[("approvalKey", json!(key))],
                        );
                    }
                }
            }
        }

        let runner = match (self.runner_lookup)(name) {
            Some(r) => r,
            None => {
                return Self::err(
                    501,
                    "not_implemented",
                    &format!("This app declares \"{name}\" but implements no operation runner."),
                )
            }
        };
        // A task the runner queues records its caller as who asked.
        let outcome = runner(args, &ctx, self.store.acting_for(get_str(&ctx, "principal")).0);
        match outcome {
            Ok(result) => (200, json!({ "a2app": true, "ok": true, "operation": name, "result": result })),
            Err(e) => Self::err(500, "operation_failed", &format!("Operation \"{name}\" threw: {e}")),
        }
    }

    // -- tasks / events -----------------------------------------------------
    fn handle_events(&mut self, headers: &HashMap<String, String>, query: &HashMap<String, String>) -> Reply {
        if let Some(limited) = self.rate_gate(headers, "data") {
            return limited;
        }
        if let Err(reply) = self.authorize(headers, None, false) {
            return reply;
        }
        let (events, next_cursor) = self.store.events_since(query.get("since").map(String::as_str));
        let wire: Vec<Value> = events
            .iter()
            .map(|e| {
                json!({
                    "id": get(e, "id"), "app": get(e, "app"), "type": get(e, "type"),
                    "payload": get(e, "payload"), "createdAt": get(e, "createdAt"),
                })
            })
            .collect();
        (200, json!({ "a2app": true, "events": wire, "nextCursor": next_cursor, "pollAfterMs": 3000 }))
    }

    fn handle_tasks(
        &mut self,
        method: &str,
        headers: &HashMap<String, String>,
        rest: &[String],
        body: Option<&Value>,
        query: &HashMap<String, String>,
    ) -> Reply {
        if let Some(limited) = self.rate_gate(headers, "data") {
            return limited;
        }
        let ctx = match self.authorize(headers, None, method != "GET") {
            Ok(ctx) => ctx,
            Err(reply) => return reply,
        };

        self.store.sweep();

        if rest.is_empty() && method == "GET" {
            let status = query.get("status").map(String::as_str);
            let tasks: Vec<Value> = self.store.list_tasks(status).iter().map(Self::task_wire).collect();
            return (200, json!({ "a2app": true, "tasks": tasks, "pollAfterMs": 2000 }));
        }
        let task_id = match rest.first() {
            Some(id) if !id.is_empty() => id.clone(),
            _ => return Self::err(400, "usage", "Task id required."),
        };
        let action = rest.get(1).map(String::as_str);
        let mut task = match self.store.get_task(&task_id) {
            Some(t) => t,
            None => return Self::err(404, ERR_TASK_NOT_FOUND, &format!("No task \"{task_id}\".")),
        };
        if action.is_none() && method == "GET" {
            return (200, Self::task_wire(&task));
        }
        if method != "POST" {
            return Self::err(405, "usage", &format!("{method} not allowed here."));
        }
        let body = body.cloned().unwrap_or_else(|| json!({}));

        match action {
            Some("claim") => {
                if get_str(&task, "status") != "submitted" {
                    return Self::err(
                        409,
                        ERR_TASK_NOT_CLAIMABLE,
                        &format!("Task {task_id} is {}, not claimable.", get_str(&task, "status")),
                    );
                }
                task["status"] = json!("working");
                task["claim"] = json!({
                    "credentialId": get(&ctx, "credentialId"), "principal": get(&ctx, "principal"),
                    "claimedAt": now_iso(),
                });
                self.store.save_task(task.clone());
                (200, Self::task_wire(&self.store.get_task(&task_id).unwrap_or(task)))
            }
            Some("progress") => {
                if get_str(&task, "status") == "canceled" {
                    return Self::err(409, ERR_TASK_CANCELED, &format!("Task {task_id} was canceled."));
                }
                if !matches!(get_str(&task, "status"), "working" | "input-required") {
                    return Self::err(
                        409,
                        ERR_TASK_NOT_CLAIMABLE,
                        &format!("Task {task_id} is {}.", get_str(&task, "status")),
                    );
                }
                if let Some(step) = body.get("step").and_then(Value::as_str) {
                    task["progress"]["step"] = json!(step);
                }
                if let Some(percent) = body.get("percent").filter(|p| p.is_number()) {
                    task["progress"]["percent"] = percent.clone();
                }
                if body.get("ask").map_or(false, |a| !a.is_null()) {
                    task["ask"] = body["ask"].clone();
                    task["status"] = json!("input-required");
                } else if get_str(&task, "status") == "input-required" {
                    task["status"] = json!("working");
                }
                self.store.save_task(task.clone());
                (200, Self::task_wire(&self.store.get_task(&task_id).unwrap_or(task)))
            }
            Some("complete") => {
                if get_str(&task, "status") == "canceled" {
                    return Self::err(409, ERR_TASK_CANCELED, &format!("Task {task_id} was canceled."));
                }
                // A terminal write belongs to a live claim. Once the sweeper has
                // returned a task to the queue, a late completion from the run
                // that abandoned it must not close work someone else may now be
                // doing.
                if !matches!(get_str(&task, "status"), "working" | "input-required") {
                    return Self::err(
                        409,
                        ERR_TASK_NOT_CLAIMABLE,
                        &format!("Task {task_id} is {}, not in progress.", get_str(&task, "status")),
                    );
                }
                match body.get("status").and_then(Value::as_str) {
                    Some("completed") => {
                        task["status"] = json!("completed");
                        task["result"] = match body.get("result") {
                            Some(r) if truthy(r) => r.clone(),
                            _ => json!({}),
                        };
                    }
                    Some("failed") => {
                        task["status"] = json!("failed");
                        task["reason"] = match body.get("reason").and_then(Value::as_str) {
                            Some(r) => json!(r),
                            None => json!("unspecified"),
                        };
                    }
                    _ => return Self::err(400, "usage", "complete requires status \"completed\" or \"failed\"."),
                }
                self.store.save_task(task.clone());
                (200, Self::task_wire(&self.store.get_task(&task_id).unwrap_or(task)))
            }
            Some("cancel") => {
                task["status"] = json!("canceled");
                self.store.save_task(task.clone());
                (200, Self::task_wire(&self.store.get_task(&task_id).unwrap_or(task)))
            }
            Some("credential") => self.issue_task_credential(headers, &task, &body),
            other => Self::err(404, "usage", &format!("Unknown task action \"{}\".", other.unwrap_or("None"))),
        }
    }

    fn task_wire(t: &Value) -> Value {
        let mut request = get(t, "request").clone();
        if request.is_object() && request.get("principal").is_none() {
            request["principal"] = Value::Null;
        }
        json!({
            "id": get(t, "id"), "app": get(t, "app"), "event": get(t, "event"), "status": get(t, "status"),
            "request": request, "claim": get(t, "claim"), "progress": get(t, "progress"),
            "result": get(t, "result"), "reason": get(t, "reason"), "createdAt": get(t, "createdAt"),
            "updatedAt": get(t, "updatedAt"), "pollAfterMs": 2000,
        })
    }

    /// `POST /api/_a2app/tasks/{id}/credential` (spec §6.2): what the bridge
    /// runs the task's harness with — the person who queued it, the
    /// capability's scopes, and no life past the task.
    fn issue_task_credential(&mut self, headers: &HashMap<String, String>, task: &Value, body: &Value) -> Reply {
        let manager = match self.manager_of(headers, true) {
            Ok(m) => m,
            Err(reply) => return reply,
        };
        if manager.role != "owner" {
            return Self::err(403, "not_a_manager", "Only an owner issues a task's credential.");
        }
        let (task_id, status) = (get_str(task, "id"), get_str(task, "status"));
        if TERMINAL_TASK.contains(&status) {
            return Self::err(409, ERR_TASK_NOT_CLAIMABLE, &format!("Task {task_id} already reached {status}."));
        }
        let principal = get(task, "request").get("principal").and_then(Value::as_str).unwrap_or(OWNER).to_string();
        let Some(info) = self.principal_info(&principal).filter(|i| truthy(get(i, "active"))) else {
            return Self::err(401, "principal_inactive", "The person who queued this task is no longer active.");
        };
        let agent_name = match parse_agent_name(body.get("agentName")) {
            Ok(name) => name,
            Err(problem) => return Self::err(400, "usage", &problem),
        };
        let capability = get_str(get(task, "request"), "capability");
        let scopes: Vec<String> = match get(get(&self.capabilities, capability), "scopes").as_array() {
            Some(list) => list.iter().map(py_str).collect(),
            None => vec!["*".to_string()],
        };
        let (token, grant) =
            self.mint_credential(&principal, agent_name.as_deref(), scopes, TASK_CREDENTIAL_SECONDS, Some(task_id));
        (201, json!({ "a2app": true, "token": token, "credential": Self::credential_wire(&grant, get(&info, "name")) }))
    }

    // -- credentials (spec/v0_2/auth.md §2, §8) ----------------------------
    //
    //   GET /api/_a2app/credentials          a manager's own (an owner: everyone's)
    //   POST /api/_a2app/credentials         issue one; the token is in this reply only
    //   DELETE /api/_a2app/credentials/{id}  revoke (a manager, or the credential itself)
    //
    // Every credential this app issues is made by `mint_credential`: a 256-bit
    // token returned once, stored as its SHA-256, bound to one principal, always
    // expiring. Whatever its scopes say, each request it makes is limited to
    // what that principal may do at the time (`credential_of`).

    /// Issue a credential: store its hash, return the token (once) with the grant.
    fn mint_credential(
        &mut self,
        principal: &str,
        agent_name: Option<&str>,
        scopes: Vec<String>,
        expires_in_seconds: i64,
        task: Option<&str>,
    ) -> (String, Value) {
        let token = new_token();
        let now = epoch_ms_now();
        let grant = json!({
            "credentialId": new_id("cred"), "tokenHash": hash_secret(&token),
            "principal": principal, "agentName": agent_name, "scopes": scopes,
            "createdAt": iso_of_ms(now), "expiresAt": iso_of_ms(now + expires_in_seconds * 1000),
            "lastUsedAt": null, "revokedAt": null, "task": task, "admin": false,
        });
        self.store.put_grant(&grant);
        (token, grant)
    }

    /// A credential as listed: never its token or the token's hash.
    fn credential_wire(g: &Value, principal_name: &Value) -> Value {
        json!({
            "credentialId": get(g, "credentialId"), "principal": get(g, "principal"),
            "principalName": principal_name, "agentName": get(g, "agentName"), "scopes": get(g, "scopes"),
            "createdAt": get(g, "createdAt"), "expiresAt": get(g, "expiresAt"),
            "lastUsedAt": get(g, "lastUsedAt"), "task": get(g, "task"),
        })
    }

    fn principal_name(&self, principal: &str) -> Value {
        self.principal_info(principal).map_or(Value::Null, |p| get(&p, "name").clone())
    }

    /// Still able to make a request: not revoked, not expired, its task not over.
    fn credential_live(&self, g: &Value) -> bool {
        if get(g, "admin") == &json!(true) || !get(g, "revokedAt").is_null() {
            return false;
        }
        if let Some(expires_at) = get(g, "expiresAt").as_str() {
            if iso_epoch_ms(expires_at).map_or(true, |at| at <= epoch_ms_now()) {
                return false;
            }
        }
        match get(g, "task").as_str() {
            Some(task_id) => {
                self.store.get_task(task_id).map_or(false, |t| !TERMINAL_TASK.contains(&get_str(&t, "status")))
            }
            None => true,
        }
    }

    fn handle_credentials(
        &mut self,
        method: &str,
        id: Option<&str>,
        headers: &HashMap<String, String>,
        body: &Value,
    ) -> Reply {
        match (id, method) {
            (None, "GET") => self.list_credentials(headers),
            (None, "POST") => self.issue_credential(headers, body),
            (None, _) => Self::err(405, "usage", &format!("{method} not allowed on credentials.")),
            (Some(id), "DELETE") => self.revoke_credential(headers, id),
            (Some(_), _) => Self::err(405, "usage", "A credential is revoked with DELETE."),
        }
    }

    fn list_credentials(&mut self, headers: &HashMap<String, String>) -> Reply {
        let manager = match self.manager_of(headers, false) {
            Ok(m) => m,
            Err(reply) => return reply,
        };
        let mut grants: Vec<Value> = self
            .store
            .list_grants()
            .into_iter()
            .filter(|g| {
                self.credential_live(g) && (manager.role == "owner" || get_str(g, "principal") == manager.principal)
            })
            .collect();
        grants.sort_by(|a, b| get_str(b, "createdAt").cmp(get_str(a, "createdAt")));
        let credentials: Vec<Value> = grants
            .iter()
            .map(|g| Self::credential_wire(g, &self.principal_name(get_str(g, "principal"))))
            .collect();
        (200, json!({ "a2app": true, "credentials": credentials }))
    }

    fn issue_credential(&mut self, headers: &HashMap<String, String>, body: &Value) -> Reply {
        let manager = match self.manager_of(headers, true) {
            Ok(m) => m,
            Err(reply) => return reply,
        };
        let principal = match body.get("principal").filter(|p| !p.is_null()) {
            None => manager.principal.clone(),
            Some(Value::String(p)) => p.clone(),
            Some(_) => return Self::err(400, "usage", "principal is an account id (or \"owner\")."),
        };
        if principal != manager.principal && manager.role != "owner" {
            return Self::err(403, "not_a_manager", "Only an owner can issue a credential for someone else.");
        }
        let Some(info) = self.principal_info(&principal).filter(|i| truthy(get(i, "active"))) else {
            return Self::err(400, "usage", &format!("\"{principal}\" is not an active account of this app."));
        };
        let agent_name = match parse_agent_name(body.get("agentName")) {
            Ok(name) => name,
            Err(problem) => return Self::err(400, "usage", &problem),
        };
        let (scopes, expires_in) = match parse_grant_request(body, &self.all_scopes()) {
            Ok(parsed) => parsed,
            Err(problem) => return Self::err(400, "usage", &problem),
        };
        let (token, grant) = self.mint_credential(&principal, agent_name.as_deref(), scopes, expires_in, None);
        (201, json!({ "a2app": true, "token": token, "credential": Self::credential_wire(&grant, get(&info, "name")) }))
    }

    fn revoke_credential(&mut self, headers: &HashMap<String, String>, id: &str) -> Reply {
        let Some(grant) = self.store.grant_by_id(id) else {
            return Self::err(404, "not_found", &format!("No credential \"{id}\"."));
        };
        if get(&grant, "admin") == &json!(true) {
            return Self::err(
                403,
                "not_a_manager",
                "The admin credential is the app's .agent-token: rotate that file instead.",
            );
        }
        // A credential may always revoke itself — the one thing an agent may
        // do with credentials — so an agent can hand back access it no longer
        // needs.
        let own = matches!(self.credential_of(headers), Some(Ok((g, _, _))) if get_str(&g, "credentialId") == id);
        if !own {
            let manager = match self.manager_of(headers, true) {
                Ok(m) => m,
                Err(reply) => return reply,
            };
            if manager.role != "owner" && get_str(&grant, "principal") != manager.principal {
                return Self::err(404, "not_found", &format!("No credential \"{id}\"."));
            }
        }
        // Re-read: presenting it may just have stamped lastUsedAt.
        let grant = self.store.grant_by_id(id).unwrap_or(grant);
        if get(&grant, "revokedAt").is_null() {
            let mut revoked = grant;
            revoked["revokedAt"] = json!(now_iso());
            self.store.put_grant(&revoked);
        }
        (200, json!({ "a2app": true, "ok": true, "revoked": id }))
    }

    // -- device-code sign-in (spec/v0_2/auth.md §7, RFC 8628 shape) ----------
    //
    //   POST /api/_a2app/auth/device               an agent asks; gets a code to show
    //   GET  /api/_a2app/auth/device/{userCode}     the person reviews (a manager)
    //   POST /api/_a2app/auth/device/{userCode}     the person approves or denies
    //   POST /api/_a2app/auth/token                 the agent polls; gets its credential
    //
    // The person approves on the app's own account page, signed in as
    // themselves; the credential issued acts for them, with the scopes they
    // approved. No password or session ever reaches the agent. Codes live 10
    // minutes, are single use, and the device code is stored only as its hash.

    /// Route one request under /api/_a2app/auth/ (`rest` is what follows it),
    /// or None when it names no device route.
    fn handle_device(
        &mut self,
        method: &str,
        rest: &str,
        headers: &HashMap<String, String>,
        body: &Value,
    ) -> Option<Reply> {
        if rest == "device" {
            return Some(if method == "POST" {
                self.device_start(headers, body)
            } else {
                Self::err(405, "usage", "Start a sign-in with POST.")
            });
        }
        if rest == "token" {
            return Some(if method == "POST" {
                self.device_poll(body)
            } else {
                Self::err(405, "usage", "Poll with POST.")
            });
        }
        let code = percent_decode(rest.strip_prefix("device/")?);
        Some(match method {
            "GET" => self.device_review(headers, &code),
            "POST" => self.device_decide(headers, &code, body),
            _ => Self::err(405, "usage", &format!("{method} not allowed on a sign-in request.")),
        })
    }

    /// Live device rows by key, dropping the expired as it goes.
    fn live_devices(&mut self) -> Vec<(String, Value)> {
        let now = epoch_ms_now();
        let mut live = Vec::new();
        for (key, row) in self.store.rows("devices") {
            if iso_epoch_ms(get_str(&row, "expiresAt")).map_or(true, |at| at <= now) {
                self.store.delete_row("devices", &key);
            } else {
                live.push((key, row));
            }
        }
        live
    }

    /// The pending request a person's typed code names.
    fn device_by_user_code(&mut self, input: &str) -> Option<(String, Value)> {
        let code = normalize_user_code(input);
        if code.is_empty() {
            return None;
        }
        self.live_devices()
            .into_iter()
            .find(|(_, row)| get_str(row, "userCode") == code && get_str(row, "status") == "pending")
    }

    fn device_code_invalid() -> Reply {
        Self::err(
            404,
            "device_code_invalid",
            "No sign-in request with that code is waiting: it was used, or it expired.",
        )
    }

    fn device_start(&mut self, headers: &HashMap<String, String>, body: &Value) -> Reply {
        let (scopes, expires_in) = match parse_grant_request(body, &self.all_scopes()) {
            Ok(parsed) => parsed,
            Err(problem) => return Self::err(400, "usage", &problem),
        };
        let agent_name = match body.get("agentName") {
            None => Value::Null,
            Some(Value::String(name)) if !name.trim().is_empty() && js_len(name) <= AGENT_NAME_MAX => {
                json!(name.trim())
            }
            Some(_) => return Self::err(400, "usage", &format!("agentName is 1–{AGENT_NAME_MAX} characters.")),
        };
        let taken: HashSet<String> =
            self.live_devices().iter().map(|(_, row)| get_str(row, "userCode").to_string()).collect();
        let mut user_code = new_user_code();
        while taken.contains(&user_code) {
            user_code = new_user_code();
        }
        let device_code = new_secret();
        let now = epoch_ms_now();
        self.store.put_row(
            "devices",
            &hash_secret(&device_code),
            &json!({
                "userCode": user_code, "agentName": agent_name, "scopes": scopes,
                "expiresInSeconds": expires_in, "createdAt": iso_of_ms(now),
                "expiresAt": iso_of_ms(now + DEVICE_CODE_TTL_SECONDS * 1000),
                "interval": DEVICE_POLL_INTERVAL_SECONDS, "lastPolledAt": null, "status": "pending",
                "approvedBy": null, "approvedScopes": null,
            }),
        );
        let approve = format!("{}{ACCOUNT_URL}#approve", self.public_origin(headers));
        (
            200,
            json!({
                "a2app": true, "deviceCode": device_code, "userCode": user_code,
                "verificationUri": approve, "verificationUriComplete": format!("{approve}/{user_code}"),
                "expiresIn": DEVICE_CODE_TTL_SECONDS, "interval": DEVICE_POLL_INTERVAL_SECONDS,
            }),
        )
    }

    fn device_poll(&mut self, body: &Value) -> Reply {
        let Some(device_code) = body.get("deviceCode").and_then(Value::as_str) else {
            return Self::err(400, "usage", "Poll with { deviceCode }.");
        };
        let key = hash_secret(device_code);
        let now = epoch_ms_now();
        let row = self.store.row("devices", &key);
        let Some(mut row) = row.filter(|r| iso_epoch_ms(get_str(r, "expiresAt")).map_or(false, |at| at > now)) else {
            self.store.delete_row("devices", &key);
            return Self::err(400, "expired_token", "This sign-in request expired or was already used. Start again.");
        };
        match get_str(&row, "status") {
            "denied" => {
                self.store.delete_row("devices", &key);
                return Self::err(400, "access_denied", "The person declined this agent's request.");
            }
            "approved" if get(&row, "approvedBy").is_string() && get(&row, "approvedScopes").is_array() => {
                // Single use: the row goes before the credential is handed out.
                self.store.delete_row("devices", &key);
                let principal = get_str(&row, "approvedBy").to_string();
                let Some(info) = self.principal_info(&principal).filter(|i| truthy(get(i, "active"))) else {
                    return Self::err(400, "access_denied", "The person who approved this is no longer active.");
                };
                let scopes: Vec<String> = get(&row, "approvedScopes")
                    .as_array()
                    .map(|a| a.iter().map(py_str).collect())
                    .unwrap_or_default();
                let expires_in = get(&row, "expiresInSeconds").as_i64().unwrap_or(DEFAULT_EXPIRES_SECONDS);
                let agent_name = get(&row, "agentName").as_str().map(str::to_string);
                let (token, grant) = self.mint_credential(&principal, agent_name.as_deref(), scopes, expires_in, None);
                let credential = Self::credential_wire(&grant, get(&info, "name"));
                return (200, json!({ "a2app": true, "token": token, "credential": credential }));
            }
            _ => {}
        }
        let interval = get(&row, "interval").as_i64().unwrap_or(DEVICE_POLL_INTERVAL_SECONDS);
        if let Some(last) = get(&row, "lastPolledAt").as_i64() {
            if now - last < interval * 1000 {
                let slower = interval + DEVICE_SLOW_DOWN_STEP_SECONDS;
                row["interval"] = json!(slower);
                row["lastPolledAt"] = json!(now);
                self.store.put_row("devices", &key, &row);
                return Self::err_with(
                    400,
                    "slow_down",
                    &format!("Polling too fast: wait {slower} s between polls."),
                    &[("interval", json!(slower))],
                );
            }
        }
        row["lastPolledAt"] = json!(now);
        self.store.put_row("devices", &key, &row);
        Self::err_with(
            400,
            "authorization_pending",
            "Waiting for the person to approve.",
            &[("interval", json!(interval))],
        )
    }

    fn device_review(&mut self, headers: &HashMap<String, String>, user_code: &str) -> Reply {
        if let Err(reply) = self.manager_of(headers, false) {
            return reply;
        }
        let Some((_, row)) = self.device_by_user_code(user_code) else {
            return Self::device_code_invalid();
        };
        (
            200,
            json!({
                "a2app": true, "userCode": get(&row, "userCode"), "agentName": get(&row, "agentName"),
                "scopes": get(&row, "scopes"), "expiresIn": get(&row, "expiresInSeconds"),
                "expiresAt": get(&row, "expiresAt"),
            }),
        )
    }

    fn device_decide(&mut self, headers: &HashMap<String, String>, user_code: &str, body: &Value) -> Reply {
        let manager = match self.manager_of(headers, true) {
            Ok(m) => m,
            Err(reply) => return reply,
        };
        let Some((key, mut row)) = self.device_by_user_code(user_code) else {
            return Self::device_code_invalid();
        };
        let Some(approve) = body.get("approve").and_then(Value::as_bool) else {
            return Self::err(400, "usage", "Decide with { approve: true | false }.");
        };
        if !approve {
            row["status"] = json!("denied");
            self.store.put_row("devices", &key, &row);
            return (200, json!({ "a2app": true, "ok": true, "status": "denied" }));
        }
        // The person may only narrow what was asked for.
        let mut scopes = get(&row, "scopes").clone();
        if let Some(narrowed) = body.get("scopes") {
            let (parsed, _) = match parse_grant_request(&json!({ "scopes": narrowed }), &self.all_scopes()) {
                Ok(parsed) => parsed,
                Err(problem) => return Self::err(400, "usage", &problem),
            };
            let asked: Vec<&str> =
                scopes.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            if !asked.contains(&"*") {
                let wider: Vec<&str> =
                    parsed.iter().map(String::as_str).filter(|s| *s == "*" || !asked.contains(s)).collect();
                if !wider.is_empty() {
                    return Self::err(
                        400,
                        "usage",
                        &format!("Approval can only narrow what the agent asked for, not add {}.", wider.join(", ")),
                    );
                }
            }
            scopes = json!(parsed);
        }
        row["status"] = json!("approved");
        row["approvedBy"] = json!(manager.principal);
        row["approvedScopes"] = scopes;
        self.store.put_row("devices", &key, &row);
        (200, json!({ "a2app": true, "ok": true, "status": "approved" }))
    }

    // -- accounts, sessions, invites (spec/v0_2/auth.md §4; multi-user only) --
    //
    //   GET/POST/DELETE /api/_a2app/session        who is signed in · sign in · sign out
    //   POST /api/_a2app/invites                    a one-time setup link (owner manager)
    //   GET/POST /api/_a2app/invites/{code}         read · accept (creates the account)
    //   GET /api/_a2app/users                       every account (owner manager)
    //   PATCH /api/_a2app/users/{id}                activate/deactivate, change role
    //
    // Accounts are adapter state, never records: they are not served by the
    // records API, and a password hash never leaves this section. Each handler
    // answers with the reply and, when it starts or ends a session, the
    // `Set-Cookie` value.

    /// The account as served: never its password hash.
    fn account_wire(a: &Value) -> Value {
        json!({
            "id": get(a, "id"), "name": get(a, "name"), "login": get(a, "login"),
            "role": get(a, "role"), "active": get(a, "active"), "createdAt": get(a, "createdAt"),
        })
    }

    fn account_reply(status: u16, a: &Value) -> Reply {
        let mut wire = Self::account_wire(a);
        wire["a2app"] = json!(true);
        (status, wire)
    }

    fn accounts(&self) -> Vec<Value> {
        self.store.rows("users").into_iter().map(|(_, a)| a).collect()
    }

    fn account_by_login(&self, login: &str) -> Option<Value> {
        self.accounts().into_iter().find(|a| get_str(a, "login") == login)
    }

    fn handle_accounts(
        &mut self,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: &Value,
    ) -> (Reply, Option<String>) {
        if path == "/api/_a2app/session" {
            return self.handle_session(method, headers, body);
        }
        let reply = if path == "/api/_a2app/invites" {
            self.create_invite(method, headers, body)
        } else if let Some(code) = path.strip_prefix("/api/_a2app/invites/") {
            return self.handle_invite(method, &percent_decode(code), body);
        } else if path == "/api/_a2app/users" {
            self.handle_users(method, headers, body, None)
        } else if let Some(id) = path.strip_prefix("/api/_a2app/users/") {
            self.handle_users(method, headers, body, Some(&percent_decode(id)))
        } else {
            Self::err(404, "not_found", "No such route.")
        };
        (reply, None)
    }

    /// Sign `account` in: a fresh session, its secret in the cookie only.
    fn start_session(&mut self, account: &Value, status: u16) -> (Reply, Option<String>) {
        let secret = new_secret();
        let now = epoch_ms_now();
        self.store.put_row(
            "sessions",
            &hash_secret(&secret),
            &json!({
                "principal": get(account, "id"), "createdAt": iso_of_ms(now),
                "expiresAt": iso_of_ms(now + SESSION_TTL_MS),
            }),
        );
        let cookie = session_cookie(&self.session_cookie_name, &secret, SESSION_TTL_MS / 1000, self.secure_cookies);
        (Self::account_reply(status, account), Some(cookie))
    }

    fn handle_session(
        &mut self,
        method: &str,
        headers: &HashMap<String, String>,
        body: &Value,
    ) -> (Reply, Option<String>) {
        match method {
            "GET" => {
                let reply = match self.session_of(headers) {
                    Some((_, account)) => Self::account_reply(200, &account),
                    None => Self::err_with(
                        401,
                        "sign_in_required",
                        "Not signed in.",
                        &[("signInUrl", json!(format!("{ACCOUNT_URL}#sign-in")))],
                    ),
                };
                (reply, None)
            }
            "DELETE" => {
                if let Some((key, _)) = self.session_of(headers) {
                    self.store.delete_row("sessions", &key);
                }
                let cleared = session_cookie(&self.session_cookie_name, "", 0, self.secure_cookies);
                ((200, json!({ "a2app": true, "ok": true })), Some(cleared))
            }
            "POST" => self.sign_in(body),
            _ => (Self::err(405, "usage", &format!("{method} not allowed on the session.")), None),
        }
    }

    fn sign_in(&mut self, body: &Value) -> (Reply, Option<String>) {
        let login = body.get("login").and_then(Value::as_str);
        let password = body.get("password").and_then(Value::as_str);
        let (Some(login), Some(password)) = (login, password) else {
            return (Self::err(400, "usage", "Sign in with { login, password }."), None);
        };
        let login = normalize_login(login);
        let wait = self.sign_in_failures.retry_after(&login, epoch_ms_now());
        if wait > 0 {
            return (
                Self::err_with(
                    429,
                    ERR_RATE_LIMITED,
                    "Too many failed sign-ins for this login. Try again later.",
                    &[("retryAfterSeconds", json!(wait))],
                ),
                None,
            );
        }
        let account = self.account_by_login(&login);
        let matches = match &account {
            Some(a) => verify_password(password, get_str(a, "passwordHash")),
            None => {
                let dummy = self.dummy_hash.get_or_insert_with(|| hash_password(&new_secret(), PBKDF2_ITERATIONS));
                verify_password(password, dummy);
                false
            }
        };
        match account {
            Some(a) if matches && truthy(get(&a, "active")) => {
                self.sign_in_failures.reset(&login);
                self.start_session(&a, 200)
            }
            _ => {
                self.sign_in_failures.fail(&login, epoch_ms_now());
                (Self::err(401, "sign_in_failed", "That login and password do not match an active account."), None)
            }
        }
    }

    /// The live invite a code names, as (key, row); an expired one goes.
    fn live_invite(&mut self, code: &str) -> Option<(String, Value)> {
        let key = hash_secret(code);
        let invite = self.store.row("invites", &key)?;
        if iso_epoch_ms(get_str(&invite, "expiresAt")).map_or(true, |at| at <= epoch_ms_now()) {
            self.store.delete_row("invites", &key);
            return None;
        }
        Some((key, invite))
    }

    fn invite_invalid() -> Reply {
        Self::err(404, "invite_invalid", "This invite link is not valid: it was used, or it expired.")
    }

    fn create_invite(&mut self, method: &str, headers: &HashMap<String, String>, body: &Value) -> Reply {
        if method != "POST" {
            return Self::err(405, "usage", &format!("{method} not allowed on invites."));
        }
        let manager = match self.manager_of(headers, true) {
            Ok(m) => m,
            Err(reply) => return reply,
        };
        if manager.role != "owner" {
            return Self::err(403, "not_a_manager", "Only an owner can invite people.");
        }
        let role = match body.get("role").filter(|r| !r.is_null()) {
            None => "member",
            Some(r) if r == "owner" || r == "member" => r.as_str().unwrap_or("member"),
            Some(_) => return Self::err(400, "usage", "role is \"owner\" or \"member\"."),
        };
        let secret = new_secret();
        let now = epoch_ms_now();
        let invite = json!({ "role": role, "createdAt": iso_of_ms(now), "expiresAt": iso_of_ms(now + INVITE_TTL_MS) });
        self.store.put_row("invites", &hash_secret(&secret), &invite);
        (
            201,
            json!({
                "a2app": true, "code": secret,
                "url": format!("{}{ACCOUNT_URL}#setup/{secret}", self.public_origin(headers)),
                "role": role, "expiresAt": get(&invite, "expiresAt"),
            }),
        )
    }

    /// The reason `body` is not a valid new account, or None.
    fn account_problem(body: &Value) -> Option<String> {
        let name = body.get("name").and_then(Value::as_str).map(str::trim);
        if name.map_or(true, |n| n.is_empty() || js_len(n) > NAME_MAX) {
            return Some(format!("name must be 1–{NAME_MAX} characters."));
        }
        let login = body.get("login").and_then(Value::as_str).map(normalize_login);
        if login.map_or(true, |l| l.is_empty() || js_len(&l) > LOGIN_MAX) {
            return Some(format!("login must be 1–{LOGIN_MAX} characters."));
        }
        let password = body.get("password").and_then(Value::as_str);
        if password.map_or(true, |p| js_len(p) < PASSWORD_MIN || js_len(p) > PASSWORD_MAX) {
            return Some(format!("password must be {PASSWORD_MIN}–{PASSWORD_MAX} characters."));
        }
        None
    }

    fn handle_invite(&mut self, method: &str, code: &str, body: &Value) -> (Reply, Option<String>) {
        let Some((key, invite)) = self.live_invite(code) else {
            return (Self::invite_invalid(), None);
        };
        match method {
            "GET" => {
                let (role, expires_at) = (get(&invite, "role"), get(&invite, "expiresAt"));
                return ((200, json!({ "a2app": true, "role": role, "expiresAt": expires_at })), None);
            }
            "POST" => {}
            _ => return (Self::err(405, "usage", &format!("{method} not allowed on an invite.")), None),
        }
        if let Some(problem) = Self::account_problem(body) {
            return (Self::err(400, "usage", &problem), None);
        }
        let login = normalize_login(get_str(body, "login"));
        if self.account_by_login(&login).is_some() {
            return (Self::err(409, "login_taken", "That login is already in use."), None);
        }
        // One request at a time: nothing can use this invite or take this login
        // between the checks above and the write below.
        let account = json!({
            "id": new_id("usr"), "name": get_str(body, "name").trim(), "login": login,
            "role": get(&invite, "role"), "active": true, "createdAt": now_iso(),
            "passwordHash": hash_password(get_str(body, "password"), PBKDF2_ITERATIONS),
        });
        self.store.delete_row("invites", &key);
        self.store.put_row("users", get_str(&account, "id"), &account);
        self.start_session(&account, 201)
    }

    fn handle_users(
        &mut self,
        method: &str,
        headers: &HashMap<String, String>,
        body: &Value,
        id: Option<&str>,
    ) -> Reply {
        let manager = match self.manager_of(headers, method != "GET") {
            Ok(m) => m,
            Err(reply) => return reply,
        };
        if manager.role != "owner" {
            return Self::err(403, "not_a_manager", "Only an owner can manage people.");
        }
        let Some(id) = id else {
            if method != "GET" {
                return Self::err(405, "usage", &format!("{method} not allowed on users."));
            }
            let mut users = self.accounts();
            users.sort_by(|a, b| get_str(a, "createdAt").cmp(get_str(b, "createdAt")));
            let users: Vec<Value> = users.iter().map(Self::account_wire).collect();
            return (200, json!({ "a2app": true, "users": users }));
        };
        if method != "PATCH" {
            return Self::err(405, "usage", &format!("{method} not allowed on a user."));
        }
        let Some(account) = self.store.row("users", id) else {
            return Self::err(404, "not_found", &format!("No account \"{id}\"."));
        };
        let active = body.get("active");
        if active.map_or(false, |a| !a.is_boolean()) {
            return Self::err(400, "usage", "active is true or false.");
        }
        let role = body.get("role");
        if role.map_or(false, |r| r != "owner" && r != "member") {
            return Self::err(400, "usage", "role is \"owner\" or \"member\".");
        }
        let mut next = account.clone();
        if let Some(a) = active {
            next["active"] = a.clone();
        }
        if let Some(r) = role {
            next["role"] = r.clone();
        }
        let is_active_owner = |a: &Value| get_str(a, "role") == "owner" && truthy(get(a, "active"));
        if is_active_owner(&account) && !is_active_owner(&next) {
            let active_owners = self.accounts().iter().filter(|a| is_active_owner(a)).count();
            if active_owners == 1 {
                return Self::err(409, "last_owner", "This is the last active owner. Make someone else an owner first.");
            }
        }
        self.store.put_row("users", id, &next);
        Self::account_reply(200, &next)
    }

    // -- app -> agent -------------------------------------------------------

    /// Emit a declared event and, when `capability` is given, queue a task for
    /// an agent. `principal` is who asked for the work — the agent that takes
    /// the task acts as them (spec/v0_2/auth.md §6); None for work the app
    /// queues on its own, which runs as the owner. A runner reaches the same
    /// seam through `store.trigger`, which records its caller.
    pub fn trigger(
        &mut self,
        etype: &str,
        payload: &Value,
        capability: Option<&str>,
        principal: Option<&str>,
    ) -> Result<Value, String> {
        self.store.trigger_as(etype, payload, capability, principal)
    }
}

// ------------------------------------------------------------ URL helpers

/// Percent-decode one path segment or query token (the oracle's `unquote`).
/// Malformed escapes pass through untouched, as Python's do.
pub fn percent_decode(s: &str) -> String {
    fn hex(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a query string into pairs — keys and values percent-decoded, `+`
/// meaning space, later duplicates winning (the oracle keeps the LAST value).
pub fn parse_qs(qs: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for pair in qs.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        out.push((
            percent_decode(&k.replace('+', " ")),
            percent_decode(&v.replace('+', " ")),
        ));
    }
    out
}

// ---------------------------------------------------------------- self-test
// Rules-parity oracle, run by the toolkit gate (`cargo run --quiet --
// --selftest`). Its job is to prove this port and `@a2app/rules` agree, so a
// Rust app and a Node app reject identical payloads identically and block
// identical operations for identical stated reasons.
//
// Until the python blueprint grew its equivalent, that gate step ran, imported
// the module, and exited 0 without asserting anything — a vacuously passing
// check, which is worse than no check because it reads as coverage.

pub fn selftest() -> i32 {
    let mut failures: Vec<String> = Vec::new();

    fn check(failures: &mut Vec<String>, label: &str, actual: &Value, expected: &Value) {
        if actual != expected {
            failures.push(format!("{label}\n    expected: {expected}\n    actual:   {actual}"));
        }
    }

    let fields = json!([
        { "name": "title", "type": "string", "required": true, "max": 200 },
        { "name": "status", "type": "enum", "values": ["todo", "doing", "done"] },
        { "name": "due", "type": "string", "max": 10, "dayKey": true },
        { "name": "created", "type": "datetime", "readOnly": true },
    ]);

    // 1. Guard: every violation, by code, sorted.
    let bad = json!({ "nope": 1, "created": "x", "status": "nonsense", "due": "31-12-2026" });
    let mut codes: Vec<String> = validate(&fields, &bad, None)
        .iter()
        .map(|v| get_str(v, "code").to_string())
        .collect();
    codes.sort();
    check(
        &mut failures,
        "guard reports every violation",
        &json!(codes),
        &json!(["invalid_daykey", "invalid_enum", "read_only_field", "unknown_field"]),
    );
    check(
        &mut failures,
        "a good body yields no violations",
        &json!(validate(&fields, &json!({ "title": "ok", "status": "todo" }), None)),
        &json!([]),
    );
    check(&mut failures, "label field resolution", &json!(label_field_of(&fields)), &json!("title"));

    // 2. Predicates: availability AND the stated reason. Both are contractual —
    //    a blocked operation must say the same thing on every stack.
    let record = json!({ "id": "t1", "title": "Ship it", "status": "doing" });
    check(
        &mut failures,
        "ne holds",
        &json!(evaluate_predicate(&json!({ "field": "status", "ne": "done" }), &record, &fields)),
        &json!(true),
    );
    check(
        &mut failures,
        "eq fails",
        &json!(evaluate_predicate(&json!({ "field": "status", "eq": "done" }), &record, &fields)),
        &json!(false),
    );
    check(
        &mut failures,
        "eq explains with both values",
        &json!(explain_predicate(&json!({ "field": "status", "eq": "done" }), &record, &fields)),
        &json!("status is \"doing\", not \"done\""),
    );
    check(
        &mut failures,
        "in explains with the full set",
        &json!(explain_predicate(&json!({ "field": "status", "in": ["todo", "done"] }), &record, &fields)),
        &json!("status is \"doing\", not \"todo\" or \"done\""),
    );
    check(
        &mut failures,
        "all reports the first failing branch",
        &json!(explain_predicate(
            &json!({ "all": [ { "field": "status", "ne": "done" }, { "field": "title", "eq": "Other" } ] }),
            &record,
            &fields
        )),
        &json!("title is \"Ship it\", not \"Other\""),
    );
    check(
        &mut failures,
        "isBlank on an absent field",
        &json!(evaluate_predicate(&json!({ "field": "due", "isBlank": true }), &record, &fields)),
        &json!(true),
    );
    // A backend may store a boolean as text; both are the same boolean.
    let bool_fields = json!([{ "name": "done", "type": "boolean" }]);
    check(
        &mut failures,
        "boolean compares by declared type, not storage shape",
        &json!(evaluate_predicate(
            &json!({ "field": "done", "eq": true }),
            &json!({ "id": "x", "done": "true" }),
            &bool_fields
        )),
        &json!(true),
    );
    // An unrecognised form must refuse, never default to available.
    check(
        &mut failures,
        "unknown predicate form refuses",
        &json!(evaluate_predicate(&json!({ "field": "status" }), &record, &fields)),
        &json!(false),
    );

    // 3. Fingerprint: stable, and moved by anything describe publishes.
    let base = json!({ "tasks": { "fields": fields, "module": "planning" } });
    check(
        &mut failures,
        "fingerprint is deterministic",
        &json!(schema_fingerprint(&base, None)),
        &json!(schema_fingerprint(&base, None)),
    );
    let moved = json!({ "tasks": { "fields": fields, "module": "other" } });
    if schema_fingerprint(&base, None) == schema_fingerprint(&moved, None) {
        failures.push("fingerprint ignores an entity's module".to_string());
    }
    if schema_fingerprint(&base, Some(&json!([{ "name": "op", "params": {} }])))
        == schema_fingerprint(&base, Some(&json!([{ "name": "op", "params": { "x": { "type": "string" } } }])))
    {
        failures.push("fingerprint ignores operation params".to_string());
    }

    // 4. Referential deletes: the rule an app declares with a `ref` binds the
    //    generic record route, not just whatever operation the app wrote. This
    //    checks the scan itself — the thing a delete consults before it commits.
    let invoice_fields = json!([
        { "name": "client", "type": "ref", "entity": "clients" },
        { "name": "projects", "type": "list<ref>", "entity": "projects" },
    ]);
    let defs = json!({
        "clients": { "fields": [{ "name": "name", "type": "string" }], "module": "sales" },
        "projects": { "fields": [{ "name": "title", "type": "string" }], "module": "sales" },
        "invoices": { "fields": invoice_fields, "module": "sales" },
    });
    let mut fixture = Store::memory(json!({}));
    fixture.put_record("clients", json!({ "id": "c_acme" }));
    fixture.put_record("clients", json!({ "id": "c_unused" }));
    fixture.put_record("projects", json!({ "id": "p_one" }));
    fixture.put_record("invoices", json!({ "id": "inv_1", "client": "c_acme", "projects": ["p_one"] }));

    check(
        &mut failures,
        "a referenced record reports who blocks it",
        &json!(references_to(&defs, &fixture, "clients", "c_acme")),
        &json!([{ "entity": "invoices", "field": "client", "ids": ["inv_1"] }]),
    );
    check(
        &mut failures,
        "an unreferenced record blocks nothing",
        &json!(references_to(&defs, &fixture, "clients", "c_unused")),
        &json!([]),
    );
    check(
        &mut failures,
        "a reference held in a list counts too",
        &json!(references_to(&defs, &fixture, "projects", "p_one")),
        &json!([{ "entity": "invoices", "field": "projects", "ids": ["inv_1"] }]),
    );

    // The opt-out is per field, and it is the only way to allow orphaning.
    let ignoring = json!({
        "clients": defs["clients"], "projects": defs["projects"],
        "invoices": { "fields": [
            { "name": "client", "type": "ref", "entity": "clients", "onDelete": "ignore" },
            { "name": "projects", "type": "list<ref>", "entity": "projects" },
        ], "module": "sales" },
    });
    check(
        &mut failures,
        "onDelete \"ignore\" removes the block",
        &json!(references_to(&ignoring, &fixture, "clients", "c_acme")),
        &json!([]),
    );
    check(
        &mut failures,
        "and leaves the other ref guarded",
        &json!(references_to(&ignoring, &fixture, "projects", "p_one")),
        &json!([{ "entity": "invoices", "field": "projects", "ids": ["inv_1"] }]),
    );

    // 5. Filter grammar: filtered reads filter, and anything outside the
    //    grammar is refused, never ignored.
    let mut flt_store = Store::memory(json!({}));
    flt_store.put_record("tasks", json!({ "id": "a", "title": "Ship it", "status": "todo" }));
    flt_store.put_record("tasks", json!({ "id": "b", "title": "Other work", "status": "done" }));
    let ids_of = |result: Result<Value, UnsupportedFilter>| -> Value {
        match result {
            Ok(listed) => json!(get(&listed, "items")
                .as_array()
                .map(|a| a.iter().map(|r| get_str(r, "id").to_string()).collect::<Vec<_>>())
                .unwrap_or_default()),
            Err(_) => json!("<refused>"),
        }
    };
    check(
        &mut failures,
        "filter: equality",
        &ids_of(flt_store.list_records("tasks", &json!({ "filter": "status = \"todo\"" }))),
        &json!(["a"]),
    );
    check(
        &mut failures,
        "filter: negation",
        &ids_of(flt_store.list_records("tasks", &json!({ "filter": "status != \"todo\"" }))),
        &json!(["b"]),
    );
    check(
        &mut failures,
        "filter: contains",
        &ids_of(flt_store.list_records("tasks", &json!({ "filter": "title ~ \"Ship\"" }))),
        &json!(["a"]),
    );
    if flt_store
        .list_records("tasks", &json!({ "filter": "status = \"todo\" && title ~ \"x\"" }))
        .is_ok()
    {
        failures.push("an unsupported filter expression was silently accepted".to_string());
    }

    // 6. SQLite store: durable records + idempotency keys, and seed-once
    //    semantics across a restart (reopening the same file).
    let tmp = std::env::temp_dir().join(format!("a2app-selftest-{}", random_hex(8)));
    let db_path = tmp.join("data").join("db.sqlite");
    let sqlite_run = (|| -> Result<(), String> {
        let mut first = Store::sqlite(&db_path, json!({}))?;
        check(&mut failures, "a fresh database file wants the seed", &json!(first.wants_seed), &json!(true));
        first.put_record("tasks", json!({ "id": "t1", "title": "persisted", "status": "todo" }));
        first.idem_put("tasks", "key-1", "t1");
        check(
            &mut failures,
            "sqlite get returns what was put",
            &json!(first.get_record("tasks", "t1").map(|r| get_str(&r, "title").to_string())),
            &json!("persisted"),
        );
        check(
            &mut failures,
            "sqlite list flows through the shared filter/sort/page",
            &ids_of(first.list_records("tasks", &json!({ "filter": "status = \"todo\"" }))),
            &json!(["t1"]),
        );
        drop(first); // the last connection closing checkpoints the WAL

        let mut second = Store::sqlite(&db_path, json!({}))?;
        check(&mut failures, "an existing database refuses the seed", &json!(second.wants_seed), &json!(false));
        check(
            &mut failures,
            "records survive a restart",
            &json!(second.get_record("tasks", "t1").map(|r| get_str(&r, "title").to_string())),
            &json!("persisted"),
        );
        check(
            &mut failures,
            "idempotency keys survive a restart",
            &json!(second.idem_get("tasks", "key-1")),
            &json!("t1"),
        );
        check(&mut failures, "delete removes the row", &json!(second.delete_record("tasks", "t1")), &json!(true));
        check(&mut failures, "a second delete reports not-found", &json!(second.delete_record("tasks", "t1")), &json!(false));
        Ok(())
    })();
    if let Err(e) = sqlite_run {
        failures.push(format!("sqlite store roundtrip errored: {e}"));
    }
    let _ = std::fs::remove_dir_all(&tmp);

    // Host and network policy: the app answers only to loopback and its own
    // origins (the public URL among them), and refuses to listen where the
    // agent token would cross a network in clear.
    fn no_runner(_: &str) -> Option<Runner> {
        None
    }
    match Adapter::new(AdapterConfig {
        app_id: "selftest".into(),
        app_name: None,
        entities: json!({}),
        operations: json!([]),
        store: Store::memory(json!({})),
        token: "t".into(),
        permissions_of: None,
        capabilities: json!({}),
        modules: json!([{ "name": "core" }]),
        allowed_origins: vec!["http://127.0.0.1:9931".into()],
        public_url: Some("https://crm.example.com".into()),
        runner_lookup: no_runner,
        events: json!([]),
        auth_mode: "none".into(),
        credential_hint: None,
        env: None,
        app_version: None,
    }) {
        Err(e) => failures.push(format!("could not build an adapter for the host checks: {e}")),
        Ok(mut hosted) => {
            for (label, host, expected) in [
                ("the public host is answered", "crm.example.com", true),
                ("…with an explicit port", "crm.example.com:443", true),
                ("loopback is answered", "127.0.0.2:9931", true),
                ("an IPv6 loopback literal is answered", "[::1]:9931", true),
                ("a rebound host is refused", "evil.example.com", false),
                ("a lookalike host is refused", "localhost.evil.example.com", false),
            ] {
                check(&mut failures, label, &json!(hosted.is_allowed_host(host)), &json!(expected));
            }
            let headers: HashMap<String, String> =
                [("Host".to_string(), "evil.example.com".to_string())].into_iter().collect();
            let answer = hosted.dispatch("GET", "/api/_a2app", &headers, None, &HashMap::new());
            check(&mut failures, "dispatch refuses a foreign host before identity", &json!(answer.status), &json!(403));
            check(
                &mut failures,
                "the public origin is the app's own",
                &json!(hosted.allowed_origins.contains("https://crm.example.com")),
                &json!(true),
            );
        }
    }
    let policy = |host: Option<&str>, public: Option<&str>| match network_policy(host.map(str::to_string), public.map(str::to_string)) {
        Ok((h, p)) => json!([h, p]),
        Err(_) => json!("refused"),
    };
    for (label, actual, expected) in [
        ("loopback by default", policy(None, None), json!(["127.0.0.1", null])),
        (
            "an https public URL is reduced to its origin",
            policy(None, Some("https://CRM.example.com/x")),
            json!(["127.0.0.1", "https://crm.example.com"]),
        ),
        ("a non-loopback bind needs a public URL", policy(Some("0.0.0.0"), None), json!("refused")),
        ("…an https one", policy(Some("0.0.0.0"), Some("http://localhost:8080")), json!("refused")),
        (
            "a non-loopback bind behind https is allowed",
            policy(Some("0.0.0.0"), Some("https://crm.example.com")),
            json!(["0.0.0.0", "https://crm.example.com"]),
        ),
        ("a plain-http public name is refused", policy(None, Some("http://crm.example.com")), json!("refused")),
        (
            "a plain-http tunnel to loopback is allowed",
            policy(None, Some("http://localhost:9000")),
            json!(["127.0.0.1", "http://localhost:9000"]),
        ),
        ("a public URL that is not a URL is refused", policy(None, Some("crm.example.com")), json!("refused")),
    ] {
        check(&mut failures, label, &actual, &expected);
    }

    // 7. Secrets (spec/v0_2/auth.md): 256-bit, stored as their SHA-256 — the
    //    same hex digest adapter-core computes, so a store moves between stacks.
    check(
        &mut failures,
        "a secret is stored as adapter-core's hex sha256",
        &json!(hash_secret("a2a_test")),
        &json!("fd2dc61992d56a878ad36b9cc4d6943ff70294267a7adbca1b17fdf19a01c758"),
    );
    let secret = new_secret();
    let url_safe = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    check(
        &mut failures,
        "a secret is 256 bits of base64url",
        &json!(secret.len() == 43 && url_safe(&secret)),
        &json!(true),
    );
    check(&mut failures, "two secrets differ", &json!(secret != new_secret()), &json!(true));
    let token = new_token();
    check(
        &mut failures,
        "a credential token is a2a_ + a secret",
        &json!(token.starts_with("a2a_") && token.len() == 47 && url_safe(&token[4..])),
        &json!(true),
    );

    // 8. Passwords: PBKDF2-SHA256 in adapter-core's stored format. The vector
    //    below was produced by adapter-core's own hashPassword (at 1000
    //    iterations — the format carries its count), so the two stacks verify
    //    each other's hashes.
    check(&mut failures, "passwords take 600 000 iterations", &json!(PBKDF2_ITERATIONS), &json!(600_000));
    let from_core = "pbkdf2_sha256$1000$bob+PnGSka57H5zfLzHKgg==$Fe2WjPCgwnY9MvuJiLkpidvv2jHXgPj9WGG+U0xn7Qk=";
    check(
        &mut failures,
        "adapter-core's hash verifies",
        &json!([verify_password("xxxxxxxxxx", from_core), verify_password("xxxxxxxxxy", from_core)]),
        &json!([true, false]),
    );
    let stored = hash_password("a long enough password", 1000);
    let parts: Vec<&str> = stored.split('$').collect();
    check(
        &mut failures,
        "a stored hash is pbkdf2_sha256$<iterations>$<16-byte salt>$<32-byte key>",
        &json!([
            parts.len(),
            parts.first().copied(),
            parts.get(1).copied(),
            parts.get(2).and_then(|s| BASE64.decode(s).ok()).map(|b| b.len()),
            parts.get(3).and_then(|s| BASE64.decode(s).ok()).map(|b| b.len()),
        ]),
        &json!([4, "pbkdf2_sha256", "1000", 16, 32]),
    );
    check(
        &mut failures,
        "a password round-trips, and a near miss does not",
        &json!([
            verify_password("a long enough password", &stored),
            verify_password("a long enough passworD", &stored),
        ]),
        &json!([true, false]),
    );
    for malformed in ["", "sha1$1000$c2FsdA==$a2V5", "pbkdf2_sha256$x$c2FsdA==$a2V5", "pbkdf2_sha256$1000$c2FsdA==$"] {
        if verify_password("anything", malformed) {
            failures.push(format!("a malformed hash matched: {malformed:?}"));
        }
    }
    check(
        &mut failures,
        "a login is trimmed and lower-cased",
        &json!(normalize_login("  Bob@Example.COM ")),
        &json!("bob@example.com"),
    );

    // 9. User codes: XXXX-XXXX from consonants, typed in any case, dash or not.
    let code = new_user_code();
    let consonants = |s: &str| s.len() == 4 && s.chars().all(|c| USER_CODE_ALPHABET.contains(c));
    check(
        &mut failures,
        "a user code is XXXX-XXXX from the consonant alphabet",
        &json!(code.len() == 9 && code.as_bytes()[4] == b'-' && consonants(&code[..4]) && consonants(&code[5..])),
        &json!(true),
    );
    check(&mut failures, "a user code normalizes to itself", &json!(normalize_user_code(&code)), &json!(code));
    for (typed, expected) in [
        ("bcdf-ghjk", "BCDF-GHJK"),
        (" b c d f g h j k ", "BCDF-GHJK"),
        ("bcdfghj", ""),
        ("AEIO-UBCD", ""),
    ] {
        check(&mut failures, &format!("user code {typed:?}"), &json!(normalize_user_code(typed)), &json!(expected));
    }

    // 10. Cookies: parsed and written exactly as adapter-core does.
    check(
        &mut failures,
        "cookies: the first of a name wins, values decode, malformed ones drop",
        &json!(parse_cookies("a=1; b=%20x; a=2; =bad; c; d=%E0%A4%A")),
        &json!({ "a": "1", "b": " x", "": "bad" }),
    );
    check(
        &mut failures,
        "the session cookie is HttpOnly, SameSite=Lax, Secure behind https",
        &json!(session_cookie("a2app_session_x", "v a", 1_209_600, true)),
        &json!("a2app_session_x=v%20a; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure"),
    );
    check(
        &mut failures,
        "signing out clears it",
        &json!(session_cookie("a2app_session_x", "", 0, false)),
        &json!("a2app_session_x=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"),
    );

    // 11. Sign-in failures: ten per login per 15 minutes, then a wait.
    let mut limiter = FailureLimiter::new(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS);
    for _ in 0..9 {
        limiter.fail("bob", 0);
    }
    let ninth = limiter.retry_after("bob", 0);
    limiter.fail("bob", 0);
    check(
        &mut failures,
        "the tenth failure locks the login until the window ends",
        &json!([
            ninth,
            limiter.retry_after("bob", 0),
            limiter.retry_after("bob", 899_500),
            limiter.retry_after("bob", 900_000),
        ]),
        &json!([0, 900, 1, 0]),
    );
    limiter.fail("bob", 0);
    limiter.reset("bob");
    check(&mut failures, "a good sign-in clears the count", &json!(limiter.retry_after("bob", 0)), &json!(0));

    // 12. What a credential may be asked for: declared scopes or `*`, and a
    //     lifetime from a minute to a year (default 30 days).
    let declared: BTreeSet<String> = ["data:tasks:read", "data:tasks:write"].iter().map(|s| s.to_string()).collect();
    let grant_of = |body: Value| match parse_grant_request(&body, &declared) {
        Ok((scopes, expires_in)) => json!([scopes, expires_in]),
        Err(_) => json!("refused"),
    };
    for (label, body, expected) in [
        ("defaults to * for 30 days", json!({}), json!([["*"], 2_592_000])),
        (
            "duplicates collapse",
            json!({ "scopes": ["data:tasks:read", "data:tasks:read"], "expiresIn": 3600.0 }),
            json!([["data:tasks:read"], 3600]),
        ),
        ("an undeclared scope is refused", json!({ "scopes": ["data:other:read"] }), json!("refused")),
        ("no scopes is refused", json!({ "scopes": [] }), json!("refused")),
        ("under a minute is refused", json!({ "expiresIn": 59 }), json!("refused")),
        ("over a year is refused", json!({ "expiresIn": 31_536_001 }), json!("refused")),
        ("a fraction of a second is refused", json!({ "expiresIn": 60.5 }), json!("refused")),
    ] {
        check(&mut failures, &format!("grant request: {label}"), &grant_of(body), &expected);
    }
    check(
        &mut failures,
        "agent names: absent, trimmed, or refused",
        &json!([
            parse_agent_name(None).ok(),
            parse_agent_name(Some(&json!("  bot "))).ok(),
            parse_agent_name(Some(&json!(" "))).is_err(),
            parse_agent_name(Some(&json!("x".repeat(101)))).is_err(),
        ]),
        &json!([null, "bot", true, true]),
    );

    // 13. The ceiling, ownership and refusals, end to end through `dispatch` on
    //     a multi-user adapter: a credential never does more than its person
    //     may do now, a member sees only its own records, and an unusable
    //     credential says why.
    fn members_read_write(p: &Value) -> Vec<String> {
        if p["role"] == "owner" {
            vec!["*".to_string()]
        } else {
            vec!["data:tasks:read".to_string(), "data:tasks:write".to_string()]
        }
    }
    let ceiling = Adapter::new(AdapterConfig {
        app_id: "selftest".into(),
        app_name: None,
        entities: json!({ "tasks": { "module": "core", "ownedBy": "owner", "fields": [
            { "name": "title", "type": "string" },
            { "name": "owner", "type": "string", "readOnly": true },
        ] } }),
        operations: json!([
            { "name": "count-tasks", "module": "core", "destructive": false, "readOnly": true, "params": {} },
        ]),
        store: Store::memory(json!({})),
        token: "admin-token".into(),
        permissions_of: Some(members_read_write),
        capabilities: json!({}),
        modules: json!([{ "name": "core" }]),
        allowed_origins: vec!["http://127.0.0.1:9931".into()],
        public_url: None,
        runner_lookup: no_runner,
        events: json!([]),
        auth_mode: "multi-user".into(),
        credential_hint: None,
        env: None,
        app_version: None,
    });
    /// One request through `dispatch`, as the holder of `token`: the reply's
    /// JSON with its status folded in as `_status`.
    fn ask(app: &mut Adapter, method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> Value {
        let headers: HashMap<String, String> =
            token.map(|t| ("X-A2App-Token".to_string(), t.to_string())).into_iter().collect();
        let answer = app.dispatch(method, path, &headers, body.as_ref(), &HashMap::new());
        let mut out = answer.json;
        out["_status"] = json!(answer.status);
        out
    }
    let code_of = |v: &Value| v.get("code").cloned().unwrap_or_else(|| v["_status"].clone());
    match ceiling {
        Err(e) => failures.push(format!("could not build a multi-user adapter: {e}")),
        Ok(mut app) => {
            let mia = json!({ "id": "usr_mia", "name": "Mia", "login": "mia", "role": "member", "active": true,
                              "createdAt": now_iso(), "passwordHash": "" });
            app.store.put_row("users", "usr_mia", &mia);
            let (wide, _) = app.mint_credential("usr_mia", Some("wide"), vec!["*".into()], 3600, None);
            let (narrow, narrow_grant) =
                app.mint_credential("usr_mia", Some("narrow"), vec!["data:tasks:read".into()], 3600, None);
            check(
                &mut failures,
                "no token is ever stored, only its hash",
                &json!(stable_json(&json!(app.store.list_grants())).contains(&wide)),
                &json!(false),
            );
            let who = ask(&mut app, "GET", "/api/_a2app/whoami", Some(&wide), None);
            check(
                &mut failures,
                "a * credential holds only what its person may do",
                &json!([who["principal"], who["principalName"], who["role"], who["scopes"]]),
                &json!(["usr_mia", "Mia", "member", ["data:tasks:read", "data:tasks:write"]]),
            );
            check(
                &mut failures,
                "…and a narrower one only what it was given",
                &ask(&mut app, "GET", "/api/_a2app/whoami", Some(&narrow), None)["scopes"],
                &json!(["data:tasks:read"]),
            );
            let write = json!({ "title": "x" });
            check(
                &mut failures,
                "a write beyond the credential is refused",
                &code_of(&ask(&mut app, "POST", "/api/collections/tasks/records", Some(&narrow), Some(write))),
                &json!("insufficient_scope"),
            );
            let admin = ask(&mut app, "GET", "/api/_a2app/whoami", Some("admin-token"), None);
            check(
                &mut failures,
                "the app's .agent-token is the owner's admin credential",
                &json!([admin["credentialId"], admin["principal"], admin["role"], admin["expiresAt"]]),
                &json!(["cred_local", "owner", "owner", null]),
            );
            let records = "/api/collections/tasks/records";
            let mine = ask(&mut app, "POST", records, Some(&wide), Some(json!({ "title": "member's" })));
            let theirs = ask(&mut app, "POST", records, Some("admin-token"), Some(json!({ "title": "owner's" })));
            check(
                &mut failures,
                "create stamps the owner field",
                &json!([mine["owner"], theirs["owner"]]),
                &json!(["usr_mia", "owner"]),
            );
            let forged = json!({ "title": "x", "owner": "owner" });
            check(
                &mut failures,
                "a client cannot set the owner field",
                &code_of(&ask(&mut app, "POST", records, Some(&wide), Some(forged))),
                &json!("read_only_field"),
            );
            // A client-sent `where` must not widen (or replace) the adapter's own.
            let listed = ask(&mut app, "GET", "/api/collections/tasks/records?where=x", Some(&wide), None);
            let titles: Vec<Value> =
                listed["items"].as_array().map(|a| a.iter().map(|r| r["title"].clone()).collect()).unwrap_or_default();
            check(
                &mut failures,
                "a member lists only its own records, counted before paging",
                &json!([titles, listed["totalItems"]]),
                &json!([["member's"], 1]),
            );
            let theirs_path = format!("{records}/{}", get_str(&theirs, "id"));
            check(
                &mut failures,
                "…and anyone else's record is not found, to read, change or delete",
                &json!([
                    ask(&mut app, "GET", &theirs_path, Some(&wide), None)["_status"],
                    ask(&mut app, "PATCH", &theirs_path, Some(&wide), Some(json!({ "title": "mine now" })))["_status"],
                    ask(&mut app, "DELETE", &theirs_path, Some(&wide), None)["_status"],
                ]),
                &json!([404, 404, 404]),
            );
            check(
                &mut failures,
                "an owner sees every record",
                &ask(&mut app, "GET", records, Some("admin-token"), None)["totalItems"],
                &json!(2),
            );
            check(
                &mut failures,
                "an agent's credential manages nothing",
                &code_of(&ask(&mut app, "GET", "/api/_a2app/credentials", Some(&wide), None)),
                &json!("not_a_manager"),
            );
            check(
                &mut failures,
                "a stranger is asked for a credential",
                &code_of(&ask(&mut app, "GET", records, None, None)),
                &json!("agent_token_required"),
            );
            check(
                &mut failures,
                "an unknown token is refused as such",
                &code_of(&ask(&mut app, "GET", "/api/_a2app/whoami", Some("a2a_unknown"), None)),
                &json!("credential_invalid"),
            );
            let revoke = format!("/api/_a2app/credentials/{}", get_str(&narrow_grant, "credentialId"));
            check(
                &mut failures,
                "a credential may revoke itself",
                &ask(&mut app, "DELETE", &revoke, Some(&narrow), None)["_status"],
                &json!(200),
            );
            check(
                &mut failures,
                "…and is then told it was revoked",
                &code_of(&ask(&mut app, "GET", "/api/_a2app/whoami", Some(&narrow), None)),
                &json!("credential_revoked"),
            );
            let mut deactivated = mia.clone();
            deactivated["active"] = json!(false);
            app.store.put_row("users", "usr_mia", &deactivated);
            check(
                &mut failures,
                "deactivating a person stops their agents",
                &code_of(&ask(&mut app, "GET", "/api/_a2app/whoami", Some(&wide), None)),
                &json!("principal_inactive"),
            );
            app.store.put_row("users", "usr_mia", &mia);
            let mut lapsed = app.store.grant_by_token_hash(&hash_secret(&wide)).unwrap_or_default();
            lapsed["expiresAt"] = json!(iso_of_ms(epoch_ms_now() - 1000));
            app.store.put_grant(&lapsed);
            check(
                &mut failures,
                "an expired credential is told so",
                &code_of(&ask(&mut app, "GET", "/api/_a2app/whoami", Some(&wide), None)),
                &json!("token_expired"),
            );
        }
    }

    // 15. A runner's caller stays inside the call: a task it queues records who
    //     asked, and work queued after it — even after it panicked — does not.
    let mut queue = Store::memory(json!({}));
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut asked = Value::Null;
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let scope = queue.acting_for("usr_mia");
        asked = scope.0.trigger("work.asked", &json!({ "n": 1 }), Some("work")).unwrap_or_default();
        panic!("a runner that fails half way");
    }));
    std::panic::set_hook(quiet);
    let own = queue.trigger("work.asked", &json!({ "n": 2 }), Some("work")).unwrap_or_default();
    let principal_of = |fired: &Value| {
        queue.get_task(get_str(fired, "taskId")).map_or(json!("<no task>"), |t| t["request"]["principal"].clone())
    };
    check(
        &mut failures,
        "a runner's task records its caller; the app's own work after a panic does not",
        &json!([principal_of(&asked), principal_of(&own)]),
        &json!(["usr_mia", null]),
    );

    // 14. Declarations the adapter refuses at boot: an owner field it could not
    //     keep read-only, and a capability needing scopes the app never
    //     declared.
    let refusal = |entities: Value, capabilities: Value| -> String {
        let built = Adapter::new(AdapterConfig {
            app_id: "selftest".into(),
            app_name: None,
            entities,
            operations: json!([]),
            store: Store::memory(json!({})),
            token: "t".into(),
            permissions_of: None,
            capabilities,
            modules: json!([{ "name": "core" }]),
            allowed_origins: vec![],
            public_url: None,
            runner_lookup: no_runner,
            events: json!([]),
            auth_mode: "multi-user".into(),
            credential_hint: None,
            env: None,
            app_version: None,
        });
        built.err().unwrap_or_default()
    };
    let owned = |field: Value| json!({ "tasks": { "module": "core", "ownedBy": "owner", "fields": [field] } });
    for (label, entities, capabilities, expected) in [
        (
            "ownedBy must name a field",
            owned(json!({ "name": "title", "type": "string" })),
            json!({}),
            "which is not one of its fields",
        ),
        (
            "…a read-only one",
            owned(json!({ "name": "owner", "type": "string" })),
            json!({}),
            "which must be a readOnly string field",
        ),
        (
            "…of type string",
            owned(json!({ "name": "owner", "type": "number", "readOnly": true })),
            json!({}),
            "which must be a readOnly string field",
        ),
        (
            "a capability may need only declared scopes",
            owned(json!({ "name": "owner", "type": "string", "readOnly": true })),
            json!({ "triage": { "scopes": ["data:tasks:read", "data:nope:write"] } }),
            "capability \"triage\" needs scopes this app does not declare: data:nope:write",
        ),
    ] {
        check(&mut failures, label, &json!(refusal(entities, capabilities).contains(expected)), &json!(true));
    }
    check(
        &mut failures,
        "a well-formed owner field and capability boot",
        &json!(refusal(
            owned(json!({ "name": "owner", "type": "string", "readOnly": true })),
            json!({ "triage": { "scopes": ["data:tasks:read", "*"] } }),
        )),
        &json!(""),
    );

    if !failures.is_empty() {
        println!("a2app_adapter selftest FAILED:\n  - {}", failures.join("\n  - "));
        return 1;
    }
    println!(
        "a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store, \
         host and network policy, secrets, passwords, user codes, cookies, sign-in limits, grant requests, \
         the ceiling, record ownership, credential refusals, ownedBy and capability declarations, \
         the runner's caller)"
    );
    0
}
