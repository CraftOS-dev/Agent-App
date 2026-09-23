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
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const RULES_VERSION: &str = "0.1.0";
pub const PROTOCOL_VERSION: &str = "0.1";
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

pub const DESCRIBE_BUDGET_CHARS: usize = 2000;

/// One protocol reply: HTTP status plus the JSON payload.
pub type Reply = (u16, Value);

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
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let (y, m, day) = civil_from_days(secs.div_euclid(86_400));
    let tod = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

// ----------------------------------------------------------------- entropy

static ENTROPY_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `n` pseudo-random bytes as lowercase hex, without a rand crate: the OS-seeded
/// per-process SipHash keys behind `RandomState`, mixed with the clock, the pid
/// and a counter, expanded through splitmix64. Plenty for record ids and a
/// local loopback token; swap in a CSPRNG before minting anything that must
/// survive an offline attacker.
pub fn random_hex(n: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    hasher.write_u32(std::process::id());
    hasher.write_u64(ENTROPY_COUNTER.fetch_add(1, Ordering::Relaxed));
    let mut state = hasher.finish();

    let mut out = String::with_capacity(n * 2);
    let mut produced = 0;
    while produced < n {
        // splitmix64 step — a well-mixed expansion of the seed.
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        for byte in z.to_le_bytes() {
            if produced == n {
                break;
            }
            out.push_str(&format!("{byte:02x}"));
            produced += 1;
        }
    }
    out
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
    },
    /// The blueprint's live store: records + idempotency keys in SQLite.
    /// One connection behind one mutex keeps this correct without a pool.
    Sqlite(Mutex<Connection>),
}

/// Record store plus adapter-owned state (tasks, events, approvals, grants).
///
/// Records are JSON rows in one table keyed (entity, id): the schema stays
/// declarative and additive (a new field simply appears in the JSON) while the
/// DATABASE is a real on-disk file inside the toolkit's declared lifecycle
/// dataDir — which is what backup/restore/promote protect. WAL keeps a reader
/// and a writer from blocking each other.
///
/// Idempotency keys persist because a restart is exactly when a retried POST
/// arrives — an in-memory table would return a duplicate record instead of the
/// 409 the protocol promises. The task/event plane, approvals and grants stay
/// in memory: they are runtime queues and session state, not records.
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
    grants: HashMap<String, Value>,
    task_seq: u64,
    event_seq: u64,
}

impl Store {
    pub fn memory(seed: Value) -> Store {
        Store {
            backend: Backend::Memory { rows: BTreeMap::new(), idem: HashMap::new() },
            wants_seed: true,
            seed,
            tasks: Vec::new(),
            events: Vec::new(),
            approvals: HashSet::new(),
            grants: HashMap::new(),
            task_seq: 0,
            event_seq: 0,
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
                PRIMARY KEY (entity, key));",
        )
        .map_err(|e| format!("cannot create tables: {e}"))?;
        Ok(Store {
            backend: Backend::Sqlite(Mutex::new(db)),
            wants_seed: fresh,
            seed,
            tasks: Vec::new(),
            events: Vec::new(),
            approvals: HashSet::new(),
            grants: HashMap::new(),
            task_seq: 0,
            event_seq: 0,
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

    pub fn list_records(&self, entity: &str, query: &Value) -> Result<Value, UnsupportedFilter> {
        let mut items = self.all_records(entity);
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

    // grants ------------------------------------------------------------------
    pub fn put_grant(&mut self, grant: Value) {
        self.grants.insert(get_str(&grant, "token").to_string(), grant);
    }

    pub fn grant_by_token(&self, token: &str) -> Option<Value> {
        self.grants.get(token).cloned()
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

    pub fn enqueue_task(&mut self, event_id: &str, capability: &str, payload: &Value) -> Value {
        self.task_seq += 1;
        let task = json!({
            "id": format!("task_{}", self.task_seq), "app": null, "event": event_id,
            "status": "submitted",
            "request": { "capability": capability, "payload": payload }, "claim": null,
            "progress": {}, "result": null, "reason": null, "ask": null,
            "createdAt": now_iso(), "updatedAt": now_iso(), "deliveries": 0,
        });
        self.tasks.push(task.clone());
        task
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

/// What this caller may do, for rendering access on a describe level.
enum Access {
    /// The app's own UI, or an anonymous caller on a single-user app: both
    /// reach a context without meeting the scope check, so both genuinely have
    /// full access (or, for an anonymous caller on multi-user, none).
    All(bool),
    Scoped(BTreeSet<String>),
}

impl Access {
    fn read(&self, entity: &str) -> bool {
        match self {
            Access::All(b) => *b,
            Access::Scoped(held) => held.contains(&format!("data:{entity}:read")),
        }
    }
    fn write(&self, entity: &str) -> bool {
        match self {
            Access::All(b) => *b,
            Access::Scoped(held) => held.contains(&format!("data:{entity}:write")),
        }
    }
    fn run(&self, op: &str) -> bool {
        match self {
            Access::All(b) => *b,
            Access::Scoped(held) => held.contains(&format!("op:{op}")),
        }
    }
}

/// One operation runner: (args, ctx, store) -> JSON-able result or an error
/// string (surfaced as a 500 operation_failed envelope).
pub type Runner = fn(&Value, &Value, &mut Store) -> Result<Value, String>;
/// Runner resolution by operation name — `schema::operation_runner`.
pub type RunnerLookup = fn(&str) -> Option<Runner>;

pub struct AdapterConfig {
    pub app_id: String,
    pub app_name: Option<String>,
    /// `{name: {"fields": [...], "module": str, "summary"?, "auth"?, "writeAllow"?}}`
    pub entities: Value,
    pub operations: Value,
    pub store: Store,
    pub token: String,
    pub modules: Value,
    pub allowed_origins: Vec<String>,
    pub runner_lookup: RunnerLookup,
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
    auth_mode: String,
    allowed_origins: HashSet<String>,
    runner_lookup: RunnerLookup,
    credential_hint: String,
    env: Option<String>,
    limiter: RateLimiter,
    app_version: Option<Box<dyn Fn() -> String>>,
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
        let problems = model_problems(&config.modules, &config.entities, &config.operations);
        if !problems.is_empty() {
            // Fail fast: a model whose entities or operations name a module that
            // was never declared cannot be walked, so serving it would answer 200
            // while omitting real capability.
            return Err(format!(
                "A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - {}",
                problems.join("\n  - ")
            ));
        }
        let mut store = config.store;
        store.put_grant(json!({
            "token": config.token, "credentialId": "cred_local", "agentName": "local",
            "principal": "owner", "scopes": ["*"],
        }));
        let mut adapter = Adapter {
            app_id: config.app_id,
            app_name: config.app_name,
            entity_defs: config.entities,
            operations: config.operations,
            modules: config.modules,
            store,
            auth_mode: config.auth_mode,
            allowed_origins: config.allowed_origins.into_iter().collect(),
            runner_lookup: config.runner_lookup,
            credential_hint: config
                .credential_hint
                .unwrap_or_else(|| "Read the app's .agent-token file (mode 0600) in the project directory.".to_string()),
            env: config.env,
            limiter: RateLimiter::new(),
            app_version: config.app_version,
        };
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
    fn expand_scopes(&self, grant: &Value) -> BTreeSet<String> {
        let scopes: Vec<&str> = get(grant, "scopes")
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if !scopes.contains(&"*") {
            return scopes.iter().map(|s| s.to_string()).collect();
        }
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

    fn credential_of(&self, headers: &HashMap<String, String>) -> Option<Value> {
        let token = headers.get("x-a2app-token").or_else(|| headers.get("x-lui-token"))?;
        self.store.grant_by_token(token)
    }

    /// True when the request carries one of the app's OWN origins — the
    /// trusted browser-UI path `authorize` also honours.
    fn is_same_origin(&self, headers: &HashMap<String, String>) -> bool {
        headers.get("origin").map_or(false, |o| self.allowed_origins.contains(o))
    }

    fn authorize(
        &self,
        headers: &HashMap<String, String>,
        scope: Option<&str>,
        is_write: bool,
    ) -> Result<Value, Reply> {
        if let Some(origin) = headers.get("origin") {
            if !self.allowed_origins.contains(origin) {
                return Err(Self::err(403, "forbidden_origin", "Refused: request Origin is not this app's own."));
            }
            return Ok(json!({ "credentialId": "ui", "agentName": null, "principal": "owner" }));
        }
        let grant = self.credential_of(headers);
        let required = is_write || self.auth_mode == "multi-user";
        let grant = match grant {
            None => {
                if required {
                    return Err(Self::err_with(
                        401,
                        ERR_AGENT_TOKEN_REQUIRED,
                        "This write requires an agent credential.",
                        &[("how", json!(self.credential_hint))],
                    ));
                }
                return Ok(json!({ "credentialId": "anonymous", "agentName": null, "principal": "owner" }));
            }
            Some(g) => g,
        };
        if let Some(scope) = scope {
            if !self.expand_scopes(&grant).contains(scope) {
                return Err(Self::err_with(
                    403,
                    ERR_INSUFFICIENT_SCOPE,
                    &format!("This credential does not hold {scope}."),
                    &[("required", json!(scope))],
                ));
            }
        }
        Ok(json!({
            "credentialId": get(&grant, "credentialId"),
            "agentName": get(&grant, "agentName"),
            "principal": get(&grant, "principal"),
        }))
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

    /// Mirrors `authorize`'s precedence including its two bypasses — the app's
    /// own UI and an anonymous read on a single-user app both reach a context
    /// without meeting the scope check, so both genuinely have full access.
    fn access_for(&self, headers: &HashMap<String, String>) -> Access {
        if self.is_same_origin(headers) {
            return Access::All(true);
        }
        match self.credential_of(headers) {
            None => Access::All(self.auth_mode != "multi-user"),
            Some(grant) => Access::Scoped(self.expand_scopes(&grant)),
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
        if let Err(reply) = self.authorize(headers, Some(&format!("data:{entity}:read")), false) {
            return reply;
        }

        let record_id = &segments[2];
        let record = match self.store.get_record(entity, record_id) {
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

    pub fn dispatch(
        &mut self,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: Option<&Value>,
        query: &HashMap<String, String>,
    ) -> Reply {
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

        if path == "/.well-known/a2app.json" || path == "/api/_a2app" {
            return (200, self.identity());
        }
        // Describe is navigational: the bare path is the root level, and each
        // extra segment moves one level inward (A2APP-SPEC 3).
        if path == "/api/_a2app/describe" {
            return self.handle_describe(&headers, &[], &q);
        }
        if let Some(rest) = path.strip_prefix("/api/_a2app/describe/") {
            let segments: Vec<String> = rest.split('/').map(percent_decode).collect();
            if segments.len() > 4 {
                return Self::err(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.");
            }
            if segments.iter().any(String::is_empty) {
                return Self::err(404, "usage", "describe path has an empty segment.");
            }
            return self.handle_describe(&headers, &segments, &q);
        }
        if path == "/api/_a2app/whoami" {
            let grant = match self.credential_of(&headers) {
                Some(g) => g,
                None => return Self::err(401, ERR_AGENT_TOKEN_REQUIRED, "whoami requires a credential."),
            };
            let scopes: Vec<String> = self.expand_scopes(&grant).into_iter().collect();
            return (
                200,
                json!({
                    "a2app": true, "credentialId": get(&grant, "credentialId"),
                    "agentName": get(&grant, "agentName"), "principal": get(&grant, "principal"),
                    "scopes": scopes,
                }),
            );
        }
        if path == "/api/_a2app/context" {
            if let Err(reply) = self.authorize(&headers, None, false) {
                return reply;
            }
            return (200, json!({ "a2app": true, "view": null, "selected": [] }));
        }
        if path == "/api/_a2app/events" {
            return self.handle_events(&headers, &q);
        }
        if path == "/api/_a2app/tasks" || path.starts_with("/api/_a2app/tasks/") {
            let rest: Vec<String> = match path.strip_prefix("/api/_a2app/tasks/") {
                Some(r) => r.split('/').map(str::to_string).collect(),
                None => Vec::new(),
            };
            return self.handle_tasks(&method, &headers, &rest, body, &q);
        }

        if let Some(rest) = path.strip_prefix("/api/collections/") {
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() >= 2 && !parts[0].is_empty() && parts[1] == "records" {
                if parts.len() == 2 {
                    return self.handle_records(&method, &headers, parts[0], None, body, &q);
                }
                if parts.len() == 3 && !parts[2].is_empty() {
                    return self.handle_records(&method, &headers, parts[0], Some(parts[2]), body, &q);
                }
            }
        }

        if let Some(name) = path.strip_prefix("/api/ops/") {
            if !name.is_empty() && !name.contains('/') {
                if method != "POST" {
                    return Self::err(405, "usage", "Operations are POST-only.");
                }
                let args = body.cloned().unwrap_or_else(|| json!({}));
                return self.handle_operation(&headers, name, &args);
            }
        }

        Self::err(404, "not_found", "No such route.")
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
            if let Err(reply) = self.authorize(headers, Some(&format!("data:{entity}:read")), false) {
                return reply;
            }
            if let Some(rec_id) = rec_id {
                return match self.store.get_record(entity, rec_id) {
                    Some(rec) => (200, rec),
                    None => Self::err(404, "record_not_found", &format!("No {entity} record \"{rec_id}\".")),
                };
            }
            let query_value = Value::Object(query.iter().map(|(k, v)| (k.clone(), json!(v))).collect());
            return match self.store.list_records(entity, &query_value) {
                Ok(listed) => (200, listed),
                // Refuse, never ignore: unfiltered rows under a filter would be
                // a 200 with the wrong records (see the grammar's comment).
                Err(e) => Self::err(400, "invalid_filter", &e.to_string()),
            };
        }

        let _ctx = match self.authorize(headers, Some(&format!("data:{entity}:write")), true) {
            Ok(ctx) => ctx,
            Err(reply) => return reply,
        };
        let body = body.cloned().unwrap_or_else(|| json!({}));

        if method == "DELETE" {
            let rec_id = match rec_id {
                Some(id) => id,
                None => return Self::err(400, "usage", "DELETE requires a record id."),
            };

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

        let stored: Value;
        if method == "POST" {
            stored = self.materialize(entity, &body);
            self.store.put_record(entity, stored.clone());
        } else {
            let rec_id = match rec_id {
                Some(id) => id,
                None => return Self::err(400, "usage", "PATCH requires a record id."),
            };
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
        match runner(args, &ctx, &mut self.store) {
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
            other => Self::err(404, "usage", &format!("Unknown task action \"{}\".", other.unwrap_or("None"))),
        }
    }

    fn task_wire(t: &Value) -> Value {
        json!({
            "id": get(t, "id"), "app": get(t, "app"), "event": get(t, "event"), "status": get(t, "status"),
            "request": get(t, "request"), "claim": get(t, "claim"), "progress": get(t, "progress"),
            "result": get(t, "result"), "reason": get(t, "reason"), "createdAt": get(t, "createdAt"),
            "updatedAt": get(t, "updatedAt"), "pollAfterMs": 2000,
        })
    }

    // -- app -> agent -------------------------------------------------------
    pub fn trigger(&mut self, etype: &str, payload: &Value, capability: Option<&str>) -> Value {
        let ev = self.store.append_event(etype, payload);
        let task_id = capability.map(|cap| {
            let task = self.store.enqueue_task(get_str(&ev, "id"), cap, payload);
            get_str(&task, "id").to_string()
        });
        json!({ "eventId": get(&ev, "id"), "taskId": task_id })
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

    if !failures.is_empty() {
        println!("a2app_adapter selftest FAILED:\n  - {}", failures.join("\n  - "));
        return 1;
    }
    println!("a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store)");
    0
}
