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
//! The pure validation rules below MUST match `@a2app/rules`
//! (adapters/rules/src) so a Rust app and a Node app reject identical payloads
//! identically — verified by the conformance suites. adapter-core is
//! TypeScript, so where its behaviour is JavaScript's (how `Number()` reads
//! text, how `String()` and `JSON.stringify` write numbers, what `Object.keys`
//! sees in a body that is not an object) this port reproduces JavaScript's
//! rules; see "JavaScript semantics" below. HTTP wiring lives in `main.rs`;
//! this file never touches the network. An agent evolves the app by editing
//! `schema.rs`, never this file.
//!
//! Everything is plumbed as owned `serde_json::Value`s with `preserve_order`:
//! an object keeps its keys in arrival order, as a JavaScript object does, so a
//! body's violations come back in body order and entities in declaration
//! order. Where a key order must not matter (the fingerprint, the approval
//! key, dedup keys) `stable_json` sorts explicitly.

// The port is kept whole — every error code, and the app->agent trigger — even
// where this starter does not exercise a corner yet; dead-code warnings on a
// deliberately complete protocol surface would train readers to ignore them.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::net::IpAddr;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL};
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const RULES_VERSION: &str = "0.1.0";
pub const PROTOCOL_VERSION: &str = "0.2";
pub const ADAPTER_VERSION: &str = "0.1.0";

// Error codes — identical strings to ERROR_CODES in @a2app/rules. Every
// rejection envelope carries one of these.
pub const ERR_UNKNOWN_FIELD: &str = "unknown_field";
pub const ERR_READ_ONLY_FIELD: &str = "read_only_field";
pub const ERR_INVALID_DATE: &str = "invalid_date";
pub const ERR_INVALID_DAYKEY: &str = "invalid_daykey";
pub const ERR_INVALID_STRING: &str = "invalid_string";
pub const ERR_INVALID_NUMBER: &str = "invalid_number";
pub const ERR_INVALID_BOOLEAN: &str = "invalid_boolean";
pub const ERR_INVALID_ENUM: &str = "invalid_enum";
pub const ERR_MISSING_REQUIRED: &str = "missing_required";
pub const ERR_INVALID_FILTER: &str = "invalid_filter";
pub const ERR_NOT_STORED: &str = "not_stored";
pub const ERR_DUPLICATE_REQUEST: &str = "duplicate_request";
pub const ERR_APPROVAL_REQUIRED: &str = "approval_required";
pub const ERR_INSUFFICIENT_SCOPE: &str = "insufficient_scope";
pub const ERR_AMBIGUOUS_REF: &str = "ambiguous_ref";
pub const ERR_INVALID_EVENT: &str = "invalid_event";
pub const ERR_TASK_NOT_FOUND: &str = "task_not_found";
pub const ERR_TASK_NOT_CLAIMABLE: &str = "task_not_claimable";
pub const ERR_TASK_CANCELED: &str = "task_canceled";
// Progress or completion on a task whose claim another credential holds (auth §6.3).
pub const ERR_TASK_NOT_HELD: &str = "task_not_held";
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
/// A task that has not reached a terminal state: the one a repeated request joins.
const OPEN_TASK: [&str; 3] = ["submitted", "working", "input-required"];

/// Adapter state that outlives a request, with adapter-core's bounds: an
/// idempotency key holds for at least a day, an approval key for ten minutes,
/// and the event log and the audit log are rings of the newest 5000 rows. An
/// event's `seq` keeps counting across a prune, so a saved cursor stays good.
const IDEMPOTENCY_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const APPROVAL_TTL_MS: i64 = 10 * 60 * 1000;
const EVENT_RETENTION: i64 = 5000;
const AUDIT_RETENTION: i64 = 5000;

/// A tab's heartbeat (its update watcher's identity poll) counts it as a
/// viewer for this long; the table is pruned once it holds more than the cap.
const VIEWER_TTL_MS: i64 = 60_000;
const VIEWER_CAP: usize = 1_000;
const VIEWER_ID_MAX: usize = 64;

pub const DESCRIBE_BUDGET_CHARS: usize = 2000;

/// A miss inside the adapter's own namespaces names the routes that answer.
const UNKNOWN_ROUTE_MESSAGE: &str =
    "No such route. Operations are invoked with POST /api/ops/<name>; GET /api/_a2app/describe lists them.";
/// Path prefixes the adapter owns outright: a miss below one is its 404, while
/// anything else is the View's.
const ADAPTER_NAMESPACES: [&str; 3] = ["/api/_a2app", "/api/ops", "/api/collections"];

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
/// Wrong confirmation codes a sign-in request survives before it is void.
const DEVICE_CONFIRM_ATTEMPTS: i64 = 5;
/// Where an agent on the person's own computer waits for the confirmation
/// (RFC 8252): `http://127.0.0.1:<loopbackPort>` + this.
const LOOPBACK_CALLBACK: &str = "/a2app/callback";
const LOOPBACK_PORT_MIN: f64 = 1024.0;
const LOOPBACK_PORT_MAX: f64 = 65535.0;

/// One protocol reply: HTTP status plus the JSON payload.
pub type Reply = (u16, Value);

/// What [`Adapter::dispatch`] answers: a reply plus the headers it sets beyond
/// Content-Type — today only a session's `Set-Cookie`.
pub struct Answer {
    pub status: u16,
    pub json: Value,
    pub headers: Vec<(String, String)>,
}

impl Answer {
    fn of((status, json): Reply) -> Answer {
        Answer { status, json, headers: Vec::new() }
    }
}

/// What a panic said, as a thrown error's message would: the runner's or the
/// adapter's own words when it gave some.
pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "it panicked".to_string())
}

// ------------------------------------------------------------ small helpers

/// JavaScript truthiness: what `if (x.flag)` means in the reference. Only
/// null, false, 0 and "" are falsy — an empty list or object is truthy.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}

fn get_str<'a>(v: &'a Value, key: &str) -> &'a str {
    get(v, key).as_str().unwrap_or("")
}

fn is_blank(v: &Value) -> bool {
    v.is_null() || v.as_str() == Some("")
}

/// A non-empty list (`x && x.length` in the reference).
fn non_empty_list(v: &Value) -> Option<&Vec<Value>> {
    v.as_array().filter(|a| !a.is_empty())
}

// ------------------------------------------------------ JavaScript semantics
//
// adapter-core is TypeScript, so its observable behaviour is JavaScript's.
// These reproduce exactly the parts a client can see: how `Number("…")` reads
// text, how `String(x)` and `JSON.stringify` write a number (`1`, not `1.0`),
// how strings compare (UTF-16 code units), and what `Object.keys` finds in a
// request body that is not an object.

/// JavaScript's WhiteSpace and LineTerminator characters: what `trim()` and
/// `Number()` strip. (Not Rust's `char::is_whitespace`, which differs on
/// U+0085 and U+FEFF.)
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(text)`: a JavaScript numeric literal (decimal, `0x`/`0o`/`0b`, or
/// `Infinity`), surrounded by optional white space; blank is 0; anything else
/// is NaN.
pub fn js_number(text: &str) -> f64 {
    let s = js_trim(text);
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = s.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0f64, |n, c| c.to_digit(radix).map(|d| n * f64::from(radix) + f64::from(d)))
                .unwrap_or(f64::NAN);
        }
    }
    // [+-] (digits [. digits] | . digits) [(e|E) [+-] digits] — checked by hand,
    // because Rust's own parser also takes "inf" and "nan", which are NaN here.
    let b = s.as_bytes();
    let digits_from = |mut i: usize| {
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        i
    };
    let mut i = usize::from(matches!(b[0], b'+' | b'-'));
    let int_end = digits_from(i);
    let mut mantissa = int_end - i;
    i = int_end;
    if b.get(i) == Some(&b'.') {
        let frac_end = digits_from(i + 1);
        mantissa += frac_end - (i + 1);
        i = frac_end;
    }
    if mantissa == 0 {
        return f64::NAN;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let start = i + 1 + usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
        let end = digits_from(start);
        if end == start {
            return f64::NAN;
        }
        i = end;
    }
    if i != b.len() {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.prototype.toString()`: the shortest digits that read back as the
/// same number, laid out as ECMAScript lays them out (`1`, `0.5`, `1e+21`,
/// `1.5e-7`).
pub fn js_number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n.is_infinite() {
        return (if n > 0.0 { "Infinity" } else { "-Infinity" }).to_string();
    }
    // `{:e}` is Rust's shortest round-trip form: "1.5e-7", "1e21", "1.23e2".
    let sci = format!("{:e}", n.abs());
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    // ECMAScript's `n`: where the decimal point falls relative to the digits.
    let point = exponent.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let e = point - 1;
        let e = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{}{body}", if n < 0.0 { "-" } else { "" })
}

/// A JSON number as JavaScript holds it: a double.
fn js_value_number(n: &serde_json::Number) -> f64 {
    n.as_f64().unwrap_or(f64::NAN)
}

/// A double as a JSON value, written the way JavaScript would serialize it: a
/// whole number stays whole (`2`, not `2.0`), and NaN or an infinity — which
/// JSON cannot carry — is null.
fn json_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// `String(value)`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(js_value_number(n)),
        Value::String(s) => s.clone(),
        // Array.prototype.join: a null element is written as nothing.
        Value::Array(items) => {
            items.iter().map(|i| if i.is_null() { String::new() } else { js_string(i) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `values.join(sep)` for a declared list of values.
fn js_join(values: &[Value], sep: &str) -> String {
    values.iter().map(|v| if v.is_null() { String::new() } else { js_string(v) }).collect::<Vec<_>>().join(sep)
}

/// JavaScript's string order: by UTF-16 code unit.
fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Sort strings as JavaScript's default `sort()` does.
fn js_sort(items: &mut [String]) {
    items.sort_by(|a, b| js_cmp(a, b));
}

/// A canonical array index ("0", "7", not "07"): JavaScript lists these keys
/// first, in numeric order, ahead of every other key.
fn array_index(key: &str) -> Option<u32> {
    if key != "0" && (key.starts_with('0') || key.is_empty()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|i| *i < u32::MAX && key.bytes().all(|b| b.is_ascii_digit()))
}

/// An object's keys in JavaScript's own-key order.
fn js_key_order(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let (mut indexed, named): (Vec<_>, Vec<_>) = map.iter().partition(|(k, _)| array_index(k).is_some());
    indexed.sort_by_key(|(k, _)| array_index(k));
    indexed.into_iter().chain(named).collect()
}

/// What `Object.keys(body)` and `body[key]` see — how the reference walks a
/// request body: an object's own keys; an array's or a string's indices; and
/// nothing at all for a number, a boolean or null.
fn js_object(body: &Value) -> Map<String, Value> {
    match body {
        Value::Object(map) => js_key_order(map).into_iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::String(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), json!(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Map::new(),
    }
}

fn write_json(v: &Value, sorted: bool, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = js_value_number(n);
            out.push_str(&if f.is_finite() { js_number_string(f) } else { "null".to_string() });
        }
        // serde_json escapes exactly what JSON.stringify and RFC 8785 escape.
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, sorted, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries = js_key_order(map);
            if sorted {
                entries.sort_by(|a, b| js_cmp(a.0, b.0));
            }
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_json(item, sorted, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value)`: keys in their own order, numbers as JavaScript
/// writes them.
pub fn js_json(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, false, &mut out);
    out
}

/// JSON with object keys sorted (by UTF-16 code unit) at every depth, so two
/// equal values that differ only in key order serialize identically. For the
/// JSON value subset A2App carries this IS RFC 8785 (JCS): the approval key and
/// the dedup key are hashed over it, so they match adapter-core's exactly.
pub fn stable_json(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, true, &mut out);
    out
}

/// `items.slice(start, end)` with JavaScript's argument rules: a fraction is
/// truncated, NaN is 0, and a negative position counts from the end.
fn js_slice<T: Clone>(items: &[T], start: f64, end: f64) -> Vec<T> {
    let len = items.len() as f64;
    let at = |x: f64| -> usize {
        let x = if x.is_nan() { 0.0 } else { x.trunc() };
        (if x < 0.0 { (len + x).max(0.0) } else { x.min(len) }) as usize
    };
    let (from, to) = (at(start), at(end));
    if to <= from {
        Vec::new()
    } else {
        items[from..to].to_vec()
    }
}

/// `n.toString(36)`.
fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// The cap on app-supplied text forwarded into an agent's context: long
/// enough for a real hint, far too short to carry a payload of instructions.
const APP_TEXT_MAX: usize = 300;

/// Text the APP supplied (its `credentialHint`), bounded before it reaches an
/// agent: one line, at most 300 characters, and a cut is marked with how much
/// went. None for blank text, so the framework's own sentence is used instead.
/// Parity oracle: `boundAppText` in adapter-core's agentText.ts.
fn bound_app_text(value: &str) -> Option<String> {
    let single = value.split(is_js_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    if single.is_empty() {
        return None;
    }
    let length = js_len(&single);
    if length <= APP_TEXT_MAX {
        return Some(single);
    }
    // The marker counts towards the cap and its own length changes the count it
    // reports; three passes reach the fixed point.
    let mut suffix = String::new();
    for _ in 0..3 {
        suffix = format!(" [truncated by adapter, {} chars cut]", length - APP_TEXT_MAX + js_len(&suffix));
    }
    let kept: Vec<u16> = single.encode_utf16().take(APP_TEXT_MAX.saturating_sub(js_len(&suffix))).collect();
    Some(String::from_utf16_lossy(&kept) + &suffix)
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

/// Hand-rolled equivalent of @a2app/rules' `looksLikeDate` pattern:
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
    // Optional white space (`\s`, JavaScript's), then an optional zone (Z,
    // +HH:MM or +HHMM), then end.
    while let Some(c) = s[i..].chars().next().filter(|c| is_js_space(*c)) {
        i += c.len_utf8();
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

/// Validate a RAW body against normalized fields; returns every violation, in
/// body order. Parity oracle: `validate` in @a2app/rules.
///
/// `allow` names extra keys accepted without being fields. `require_required`
/// is set on a create only: a required field that is absent is then
/// `missing_required` too. (One that is present but blank is refused on any
/// write: clearing it would leave a record the schema says cannot exist.)
pub fn validate(fields: &Value, body: &Value, allow: Option<&Value>, require_required: bool) -> Vec<Value> {
    let field_list: Vec<&Value> = fields.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let by_name: HashMap<&str, &Value> = field_list.iter().map(|f| (get_str(f, "name"), *f)).collect();
    let writable: Vec<&str> = field_list
        .iter()
        .filter(|f| !truthy(get(f, "readOnly")))
        .map(|f| get_str(f, "name"))
        .collect();
    let body = js_object(body);
    let mut out = Vec::new();
    for (key, value) in &body {
        if allow.map_or(false, |a| truthy(get(a, key))) {
            continue;
        }
        let Some(f) = by_name.get(key.as_str()).copied() else {
            // "one of: " with nothing after it would read as a truncated
            // message rather than as the answer it is.
            let accepted = if writable.is_empty() {
                "nothing — no writable fields are declared".to_string()
            } else {
                format!("one of: {}", writable.join(", "))
            };
            out.push(violation(ERR_UNKNOWN_FIELD, key, accepted, value));
            continue;
        };
        if truthy(get(f, "readOnly")) {
            out.push(violation(ERR_READ_ONLY_FIELD, key, "not writable (server-managed)".to_string(), value));
            continue;
        }
        if is_blank(value) {
            if truthy(get(f, "required")) {
                out.push(violation(ERR_MISSING_REQUIRED, key, "a non-blank value (required field)".to_string(), value));
            }
            continue;
        }
        let ftype = get_str(f, "type");
        if ftype == "datetime" && !looks_like_date(value) {
            out.push(violation(ERR_INVALID_DATE, key, "an ISO 8601 date".to_string(), value));
            continue;
        }
        if truthy(get(f, "dayKey")) && !is_day_key_value(value) {
            out.push(violation(ERR_INVALID_DAYKEY, key, "a day key \"YYYY-MM-DD\"".to_string(), value));
            continue;
        }
        if ftype == "string" {
            let Some(text) = value.as_str() else {
                out.push(violation(ERR_INVALID_STRING, key, "text".to_string(), value));
                continue;
            };
            // `max` is published in describe, so a client plans against it:
            // length in UTF-16 code units, as JavaScript counts it.
            if let Some(max) = get(f, "max").as_f64() {
                if js_len(text) as f64 > max {
                    let expected = format!("text of at most {} characters", js_number_string(max));
                    out.push(violation(ERR_INVALID_STRING, key, expected, value));
                    continue;
                }
            }
        }
        // A JSON number, or text that reads as one. A boolean is neither.
        if ftype == "number"
            && !value.is_number()
            && !value.as_str().map_or(false, |s| !js_trim(s).is_empty() && !js_number(s).is_nan())
        {
            out.push(violation(ERR_INVALID_NUMBER, key, "a number".to_string(), value));
            continue;
        }
        if ftype == "boolean" && !value.is_boolean() && value != "true" && value != "false" {
            out.push(violation(ERR_INVALID_BOOLEAN, key, "true or false".to_string(), value));
            continue;
        }
        let values = non_empty_list(get(f, "values"));
        if let (Some(values), "enum") = (values, ftype) {
            if !values.iter().any(|v| js_string(v) == js_string(value)) {
                out.push(violation(ERR_INVALID_ENUM, key, format!("one of: {}", js_join(values, " | ")), value));
                continue;
            }
        }
        if let (Some(values), "list<enum>") = (values, ftype) {
            // The wire form of a list is an array: wrapping a bare scalar would
            // hide a client bug and make the stored shape depend on how many
            // values happened to be sent.
            let Some(items) = value.as_array() else {
                out.push(violation(ERR_INVALID_ENUM, key, format!("an array of: {}", js_join(values, " | ")), value));
                continue;
            };
            if items.iter().any(|item| !values.iter().any(|v| js_string(v) == js_string(item))) {
                out.push(violation(ERR_INVALID_ENUM, key, format!("each of: {}", js_join(values, " | ")), value));
                continue;
            }
        }
    }
    // A create that leaves a required field out entirely. One sent blank was
    // reported above; reporting both would list one mistake twice.
    if require_required {
        for f in &field_list {
            if truthy(get(f, "required")) && !truthy(get(f, "readOnly")) && !body.contains_key(get_str(f, "name")) {
                out.push(violation(
                    ERR_MISSING_REQUIRED,
                    get_str(f, "name"),
                    "a non-blank value (required field)".to_string(),
                    &Value::Null,
                ));
            }
        }
    }
    out
}

/// Read-back backstop: which non-blank requested values failed to land? A
/// write-only field (a password) is never read back, so it is exempt.
pub fn divergences<F: Fn(&str) -> Value>(fields: &Value, body: &Value, read: F) -> Vec<Value> {
    let by_name: HashMap<&str, &Value> =
        fields.as_array().map(|a| a.iter().map(|f| (get_str(f, "name"), f)).collect()).unwrap_or_default();
    let mut out = Vec::new();
    for (key, requested) in js_object(body) {
        let f = match by_name.get(key.as_str()) {
            Some(f) if !truthy(get(f, "readOnly")) && !truthy(get(f, "writeOnly")) => *f,
            _ => continue,
        };
        if is_blank(&requested) {
            continue;
        }
        let stored = read(&key);
        if is_blank(&stored) {
            out.push(json!({ "field": key, "type": get(f, "type"), "stored": js_string(&stored) }));
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
    let mut parts = vec![format!("{}:{}", js_string(get(f, "name")), js_string(get(f, "type")))];
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
    if let Some(max) = get(f, "max").as_f64() {
        parts.push(format!("max={}", js_number_string(max)));
    }
    if truthy(get(f, "entity")) {
        parts.push(format!("entity={}", js_string(get(f, "entity"))));
    }
    if let Some(values) = non_empty_list(get(f, "values")) {
        // `[...values].sort().join("|")`: sorted as text, a number included.
        let mut sorted = values.clone();
        sorted.sort_by(|a, b| js_cmp(&js_string(a), &js_string(b)));
        parts.push(format!("values={}", js_join(&sorted, "|")));
    }
    parts.join(":")
}

fn operation_print(o: &Value) -> String {
    let mut flags = String::new();
    for (c, k) in [("d", "destructive"), ("r", "readOnly"), ("i", "idempotent")] {
        if truthy(get(o, k)) {
            flags.push_str(c);
        }
    }
    let name = js_string(get(o, "name"));
    let mut parts = vec![if flags.is_empty() { name } else { format!("{name}:{flags}") }];
    parts.push(format!("mod={}", js_string(get(o, "module"))));
    if truthy(get(o, "entity")) {
        parts.push(format!("on={}", js_string(get(o, "entity"))));
    }
    if truthy(get(o, "params")) && !js_object(get(o, "params")).is_empty() {
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
/// one. The hash is djb2-xor over UTF-16 code units, as the reference's
/// `charCodeAt` walk computes it.
pub fn schema_fingerprint(entities: &Value, operations: Option<&Value>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(map) = entities.as_object() {
        for (name, value) in map {
            let mut prints: Vec<String> =
                get(value, "fields").as_array().map(|a| a.iter().map(field_print).collect()).unwrap_or_default();
            js_sort(&mut prints);
            let mut attrs = vec![format!("{}({})", name, prints.join(","))];
            if truthy(get(value, "auth")) {
                attrs.push("auth".to_string());
            }
            attrs.push(format!("mod={}", js_string(get(value, "module"))));
            parts.push(attrs.join(":"));
        }
    }
    js_sort(&mut parts);
    let mut ops: Vec<String> =
        operations.and_then(Value::as_array).map(|a| a.iter().map(operation_print).collect()).unwrap_or_default();
    js_sort(&mut ops);
    let joined = format!("{}|{}", parts.join(";"), ops.join(","));
    let mut h: u32 = 5381;
    for unit in joined.encode_utf16() {
        h = h.wrapping_mul(33) ^ u32::from(unit);
    }
    format!("sv_{h:x}")
}

// -- availability predicates (A2APP-SPEC 3.4) -------------------------------
// Parity oracle: adapters/rules/src/predicate.ts. Same predicate + same record
// must yield the same availability and the same blocked reason on every stack.
// A form is recognised by the key it carries (`all`, `not`, `eq`, …), as the
// reference's own-property tests do.

/// Read a value as its field's DECLARED type.
///
/// A backend is only obliged to return what it stored, so `done: "true"` and
/// `done: true` are the same boolean. Deciding from the runtime type instead
/// would make availability depend on the storage engine.
fn as_declared(value: &Value, declared_type: Option<&str>) -> Value {
    if is_blank(value) {
        return Value::Null;
    }
    match (declared_type, value) {
        (Some("boolean"), Value::String(s)) if s == "true" => Value::Bool(true),
        (Some("boolean"), Value::String(s)) if s == "false" => Value::Bool(false),
        (Some("number"), Value::String(s)) => {
            let n = js_number(s);
            if n.is_finite() {
                json_number(n)
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

/// `a === b` for JSON values: a list or an object is never identical to
/// another one.
fn strictly_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => js_value_number(x) == js_value_number(y),
        (Value::String(x), Value::String(y)) => x == y,
        _ => false,
    }
}

/// Structural equality after declared-type reading. Lists and objects compare
/// by their JSON, so `list<ref>` membership is well defined.
fn same_value(a: &Value, b: &Value) -> bool {
    if strictly_equal(a, b) {
        return true;
    }
    if a.is_null() || b.is_null() {
        return false;
    }
    if a.is_array() || a.is_object() || b.is_array() || b.is_object() {
        return js_json(a) == js_json(b);
    }
    false
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

/// The list a form carries under `key` (its branches, or its candidates), when
/// the form is that one; a malformed list reads as empty.
fn branches(p: &Value, key: &str) -> Option<Vec<Value>> {
    p.get(key).map(|b| b.as_array().cloned().unwrap_or_default())
}

fn evaluate(p: &Value, record: &Value, index: &HashMap<&str, &Value>) -> bool {
    // A malformed list never holds: the reference would throw on it.
    let listed = |key: &str| p.get(key).map(|b| b.as_array().map(Vec::as_slice));
    if let Some(all) = listed("all") {
        return all.map_or(false, |a| a.iter().all(|sub| evaluate(sub, record, index)));
    }
    if let Some(any) = listed("any") {
        return any.map_or(false, |a| a.iter().any(|sub| evaluate(sub, record, index)));
    }
    if let Some(not) = p.get("not") {
        return !evaluate(not, record, index);
    }

    let field = get_str(p, "field");
    let actual = read_field(record, field, index);
    let declared = field_type(index, field);
    if let Some(flag) = p.get("isBlank") {
        // `(actual === null) === isBlank`: anything but a boolean never holds.
        return flag.as_bool().map_or(false, |blank| actual.is_null() == blank);
    }
    if let Some(eq) = p.get("eq") {
        return same_value(&actual, &as_declared(eq, declared));
    }
    if let Some(ne) = p.get("ne") {
        return !same_value(&actual, &as_declared(ne, declared));
    }
    let matches_any = |list: &[Value]| list.iter().any(|c| same_value(&actual, &as_declared(c, declared)));
    if let Some(candidates) = listed("in") {
        return candidates.map_or(false, matches_any);
    }
    if let Some(candidates) = listed("notIn") {
        return candidates.map_or(false, |list| !matches_any(list));
    }
    // Unrecognised form: refuse rather than default to available. An unknown
    // condition must never silently unblock an action.
    false
}

fn render_value(v: &Value) -> String {
    match v {
        Value::Null => "blank".to_string(),
        Value::String(s) => format!("\"{s}\""),
        Value::Array(_) | Value::Object(_) => js_json(v),
        other => js_string(other),
    }
}

/// Every field name a predicate reads, for declaration-time validation.
fn predicate_fields(predicate: &Value) -> Vec<String> {
    fn collect(p: &Value, out: &mut Vec<String>) {
        if let Some(all) = branches(p, "all") {
            all.iter().for_each(|sub| collect(sub, out));
        } else if let Some(any) = branches(p, "any") {
            any.iter().for_each(|sub| collect(sub, out));
        } else if let Some(not) = p.get("not") {
            collect(not, out);
        } else {
            let field = p.get("field").map_or_else(|| "undefined".to_string(), js_string);
            if !out.contains(&field) {
                out.push(field);
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
    if let Some(all) = branches(p, "all") {
        return match all.iter().find(|sub| !evaluate(sub, record, index)) {
            Some(failing) => explain(failing, record, index),
            None => "the condition holds".to_string(),
        };
    }
    if let Some(any) = branches(p, "any") {
        // None held, so every branch failed; the first is the most specific
        // thing to say.
        return match any.first() {
            Some(first) => explain(first, record, index),
            None => "no condition is satisfiable".to_string(),
        };
    }
    if let Some(inner) = p.get("not") {
        let field = get_str(inner, "field");
        if let Some(flag) = inner.get("isBlank") {
            return if truthy(flag) { format!("{field} is blank") } else { format!("{field} is set") };
        }
        if inner.get("eq").is_some() {
            return format!("{} is {}", field, render_value(&read_field(record, field, index)));
        }
        let subject = if ["all", "any", "not"].iter().any(|k| inner.get(*k).is_some()) { "the record" } else { field };
        return format!("the condition on {subject} is not met");
    }

    let field = get_str(p, "field");
    let actual = read_field(record, field, index);
    if let Some(flag) = p.get("isBlank") {
        if truthy(flag) {
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
    if let Some(candidates) = branches(p, "in") {
        return format!("{} is {}, not {}", field, render_value(&actual), render_list(&candidates));
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
        js_json(get(v, "got"))
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
            // Whole seconds, rounded up: retrying a moment early is refused again.
            let retry = (60_000u64.saturating_sub(now - ws)).div_ceil(1000);
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

/// ISO 8601 UTC with milliseconds, "…Z" — JavaScript's `toISOString()`.
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
pub fn decode_uri_component(s: &str) -> Option<String> {
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
            list.iter().map(js_string).collect()
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

/// A stored value as a filter compares it: `String(value)`, absent as "".
fn filter_str(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        js_string(value)
    }
}

/// Sort order for `?sort=`: blank first, then by `String(value)` in
/// JavaScript's string order. The reference's comparator; blank-against-blank
/// and equal text compare equal, so the sort is a total order and, being
/// stable, keeps the store's order among them in either direction.
fn sort_cmp(a: &Value, b: &Value) -> Ordering {
    match (a.is_null(), b.is_null()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => js_cmp(&js_string(a), &js_string(b)),
    }
}

/// A list query's `page` or `perPage` as the reference reads it: a JSON number
/// as is, text through `Number()`, absent as None.
fn query_number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Null => None,
        Value::Number(n) => Some(js_value_number(n)),
        Value::String(s) => Some(js_number(s)),
        _ => Some(f64::NAN),
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
/// reference starter's `FILTER_CLAUSE` (where `\s` is JavaScript's white space).
fn match_filter(expr: &str) -> Result<(String, String, String), UnsupportedFilter> {
    let unsupported = || UnsupportedFilter { expression: expr.to_string() };
    let b = expr.as_bytes();
    let mut i = 0usize;
    let skip_ws = |i: &mut usize| {
        while let Some(c) = expr[*i..].chars().next().filter(|c| is_js_space(*c)) {
            *i += c.len_utf8();
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
                // what the escaping side wrote (backslash-x -> x). The x is any
                // character but a line terminator, as the reference's `.` is.
                let escaped = expr[i + 1..]
                    .chars()
                    .next()
                    .filter(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
                    .ok_or_else(unsupported)?;
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
            if is_js_space(ch) || matches!(ch, '"' | '\'' | '(' | ')') {
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

/// A validated raw value in its stored form: text that reads as a number or a
/// boolean becomes one (`Number(text)`, `text === "true"`), as the reference
/// stores it. The guard already accepted the value. A number JSON cannot hold
/// ("Infinity") is stored as nothing, which the read-back then reports.
fn coerce(field: &Value, value: &Value) -> Value {
    if is_blank(value) {
        return value.clone();
    }
    match (get_str(field, "type"), value) {
        ("number", Value::String(s)) => json_number(js_number(s)),
        ("boolean", Value::String(s)) => Value::Bool(s == "true"),
        _ => value.clone(),
    }
}

enum Backend {
    /// The disposable in-memory variant, for tests and tooling. A fresh one is
    /// always empty, so it always takes the seed.
    Memory {
        rows: BTreeMap<String, Vec<Value>>,
        /// (scope, key) -> (record id, when it was recorded)
        idem: HashMap<(String, String), (String, i64)>,
        /// adapter state: table -> key -> row, in insertion order (see
        /// `Store::row`)
        state: BTreeMap<String, Map<String, Value>>,
        events: Vec<Value>,
        audit: Vec<Value>,
    },
    /// The blueprint's live store: records, idempotency keys and adapter state
    /// in SQLite. One connection behind one mutex keeps this correct without a
    /// pool.
    Sqlite(Mutex<Connection>),
}

/// The connection, even after a panic elsewhere left its mutex poisoned: a
/// panic is answered as one failed request (see `main.rs`), and SQLite's own
/// transactions keep the file consistent, so the next request may proceed.
fn lock(db: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A database that fails a statement cannot answer truthfully, so the request
/// fails instead of reporting a write that never happened: a runner's call
/// fails as `operation_failed`, any other as `adapter_error`, exactly where
/// adapter-core's binding would throw.
fn storage_failed<T>(e: rusqlite::Error) -> T {
    panic!("the database failed: {e}")
}

/// Record store plus adapter-owned state (tasks, events, approvals,
/// idempotency keys, the audit log, credentials, accounts).
///
/// Records are JSON rows in one table keyed (entity, id): the schema stays
/// declarative and additive (a new field simply appears in the JSON) while the
/// DATABASE is a real on-disk file inside the toolkit's declared lifecycle
/// dataDir — which is what backup/restore/promote protect. WAL keeps a reader
/// and a writer from blocking each other.
///
/// Everything else the adapter keeps is durable too, as adapter-core's file
/// store keeps it: a restart is exactly when a retried write arrives, a saved
/// event cursor is read, an approved destructive call is replayed, or a task's
/// agent comes back with its credential. Idempotency keys (24 h), approvals
/// (10 min), tasks and their dedup keys, the event log (newest 5000, `seq`
/// counting on) and the audit log (newest 5000) live beside the records, as do
/// credentials, accounts, sessions, invites and device codes (the
/// `adapter_state` table). They are adapter state, never records — no record
/// route reaches them, and a runner's `Store` methods cannot.
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
    /// The app's id, which every task and event names. Set by `Adapter::new`.
    app: String,
    /// The event types this app may emit, set by `Adapter::new` from the app's
    /// declarations. Empty means none were declared.
    event_types: BTreeSet<String>,
    /// Who the operation being run acts for. The adapter sets it around a
    /// runner, so a task the runner queues records who asked for it (spec/v0_2
    /// auth.md §6.1) without the runner having to say — or being able to say
    /// otherwise. None outside a runner: work the app queues on its own.
    caller: Option<String>,
}

impl Store {
    pub fn memory(seed: Value) -> Store {
        Store {
            backend: Backend::Memory {
                rows: BTreeMap::new(),
                idem: HashMap::new(),
                state: BTreeMap::new(),
                events: Vec::new(),
                audit: Vec::new(),
            },
            wants_seed: true,
            seed,
            app: String::new(),
            event_types: BTreeSet::new(),
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
                entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, at INTEGER NOT NULL,
                PRIMARY KEY (entity, key));
             CREATE TABLE IF NOT EXISTS adapter_state (
                tbl TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY (tbl, key));
             CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS audit (n INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);",
        )
        .map_err(|e| format!("cannot create tables: {e}"))?;
        // A database from before idempotency keys expired has no `at`: its keys
        // are counted from now, so each still holds for a full day.
        let dated = db
            .prepare("SELECT 1 FROM pragma_table_info('idem') WHERE name = 'at'")
            .and_then(|mut s| s.exists([]))
            .map_err(|e| format!("cannot read the idem table: {e}"))?;
        if !dated {
            db.execute_batch("ALTER TABLE idem ADD COLUMN at INTEGER NOT NULL DEFAULT 0")
                .and_then(|_| db.execute("UPDATE idem SET at = ?1", [epoch_ms_now()]))
                .map_err(|e| format!("cannot upgrade the idem table: {e}"))?;
        }
        Ok(Store {
            backend: Backend::Sqlite(Mutex::new(db)),
            wants_seed: fresh,
            seed,
            app: String::new(),
            event_types: BTreeSet::new(),
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
                let db = lock(db);
                let mut stmt = db.prepare("SELECT data FROM records WHERE entity = ?1").unwrap_or_else(storage_failed);
                let rows = stmt.query_map([entity], |row| row.get::<_, String>(0)).unwrap_or_else(storage_failed);
                rows.map(|row| row.unwrap_or_else(storage_failed))
                    .filter_map(|s| serde_json::from_str(&s).ok())
                    .collect()
            }
        }
    }

    /// `query`: `filter`, `sort`, `page`, `perPage`, and `where` — `{field:
    /// value}` constraints the adapter sets (a member sees only the records it
    /// owns), applied before sorting and paging like any other constraint, so
    /// pages and totals count only what the caller may see.
    ///
    /// The reference binding's semantics exactly: `page` and `perPage` are
    /// numbers (text is read with `Number()`), `perPage` defaults to every row
    /// and `page` to 1, and the page is `items.slice((page-1)*perPage, …)` —
    /// so 0 or an unreadable `perPage` is an empty page, not every row.
    pub fn list_records(&self, entity: &str, query: &Value) -> Result<Value, UnsupportedFilter> {
        let mut items = self.all_records(entity);
        if let Some(constraints) = query.get("where").and_then(Value::as_object) {
            items.retain(|r| constraints.iter().all(|(field, value)| strictly_equal(get(r, field), value)));
        }
        if let Some(expr) = query.get("filter").and_then(Value::as_str).filter(|e| !e.is_empty()) {
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
        if let Some(sort) = query.get("sort").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let (desc, key) = match sort.strip_prefix('-') {
                Some(key) => (true, key),
                None => (false, sort),
            };
            items.sort_by(|a, b| {
                let order = sort_cmp(get(a, key), get(b, key));
                if desc {
                    order.reverse()
                } else {
                    order
                }
            });
        }
        let total = items.len();
        let per_page = query_number(query.get("perPage")).unwrap_or(total as f64);
        let page = query_number(query.get("page")).unwrap_or(1.0);
        let start = (page - 1.0) * per_page;
        let paged = js_slice(&items, start, start + per_page);
        Ok(json!({ "items": paged, "page": json_number(page), "perPage": json_number(per_page), "totalItems": total }))
    }

    pub fn get_record(&self, entity: &str, rec_id: &str) -> Option<Value> {
        match &self.backend {
            Backend::Memory { rows, .. } => rows
                .get(entity)
                .and_then(|list| list.iter().find(|r| get_str(r, "id") == rec_id))
                .cloned(),
            Backend::Sqlite(db) => lock(db)
                .query_row("SELECT data FROM records WHERE entity = ?1 AND id = ?2", [entity, rec_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .unwrap_or_else(storage_failed)
                .and_then(|s| serde_json::from_str(&s).ok()),
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
                lock(db)
                    .execute(
                        "INSERT INTO records (entity, id, data) VALUES (?1, ?2, ?3)
                         ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data",
                        params![entity, get_str(&rec, "id"), js_json(&rec)],
                    )
                    .unwrap_or_else(storage_failed);
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
            Backend::Sqlite(db) => lock(db)
                .execute("DELETE FROM records WHERE entity = ?1 AND id = ?2", [entity, rec_id])
                .map(|n| n > 0)
                .unwrap_or_else(storage_failed),
        }
    }

    // adapter state -----------------------------------------------------------
    // Keyed tables only the adapter reads: `users`, `sessions`, `invites`,
    // `devices` and `grants` (keyed by id or by the SHA-256 of the secret that
    // finds them; no secret is ever a key or a value), and `tasks`, `dedup`,
    // `approvals` and `meta`. Rows keep the order they were first written in.
    // Private to the adapter: a runner holds this `Store` too, and must not
    // reach them.

    fn row(&self, table: &str, key: &str) -> Option<Value> {
        match &self.backend {
            Backend::Memory { state, .. } => state.get(table).and_then(|t| t.get(key)).cloned(),
            Backend::Sqlite(db) => lock(db)
                .query_row("SELECT data FROM adapter_state WHERE tbl = ?1 AND key = ?2", [table, key], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .unwrap_or_else(storage_failed)
                .and_then(|s| serde_json::from_str(&s).ok()),
        }
    }

    fn put_row(&mut self, table: &str, key: &str, row: &Value) {
        match &mut self.backend {
            Backend::Memory { state, .. } => {
                state.entry(table.to_string()).or_default().insert(key.to_string(), row.clone());
            }
            Backend::Sqlite(db) => {
                lock(db)
                    .execute(
                        "INSERT INTO adapter_state (tbl, key, data) VALUES (?1, ?2, ?3)
                         ON CONFLICT (tbl, key) DO UPDATE SET data = excluded.data",
                        params![table, key, js_json(row)],
                    )
                    .unwrap_or_else(storage_failed);
            }
        }
    }

    fn delete_row(&mut self, table: &str, key: &str) {
        match &mut self.backend {
            Backend::Memory { state, .. } => {
                if let Some(t) = state.get_mut(table) {
                    t.shift_remove(key);
                }
            }
            Backend::Sqlite(db) => {
                lock(db)
                    .execute("DELETE FROM adapter_state WHERE tbl = ?1 AND key = ?2", [table, key])
                    .unwrap_or_else(storage_failed);
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
                let db = lock(db);
                let mut stmt = db
                    .prepare("SELECT key, data FROM adapter_state WHERE tbl = ?1 ORDER BY rowid")
                    .unwrap_or_else(storage_failed);
                let rows = stmt
                    .query_map([table], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .unwrap_or_else(storage_failed);
                rows.map(|row| row.unwrap_or_else(storage_failed))
                    .filter_map(|(k, s)| serde_json::from_str(&s).ok().map(|v| (k, v)))
                    .collect()
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
    // An idempotency key is scoped (`<entity>` for a create, `<entity>#<id>` for
    // an update, `op:<name>` for an operation) and holds for 24 hours. An
    // approval key holds for 10 minutes and is consumed by its one use.

    fn idem_get(&mut self, scope: &str, key: &str) -> Option<String> {
        let found: Option<(String, i64)> = match &self.backend {
            Backend::Memory { idem, .. } => idem.get(&(scope.to_string(), key.to_string())).cloned(),
            Backend::Sqlite(db) => lock(db)
                .query_row("SELECT rec_id, at FROM idem WHERE entity = ?1 AND key = ?2", [scope, key], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()
                .unwrap_or_else(storage_failed),
        };
        let (rec_id, at) = found?;
        if epoch_ms_now() - at > IDEMPOTENCY_TTL_MS {
            match &mut self.backend {
                Backend::Memory { idem, .. } => {
                    idem.remove(&(scope.to_string(), key.to_string()));
                }
                Backend::Sqlite(db) => {
                    lock(db)
                        .execute("DELETE FROM idem WHERE entity = ?1 AND key = ?2", [scope, key])
                        .unwrap_or_else(storage_failed);
                }
            }
            return None;
        }
        Some(rec_id)
    }

    fn idem_put(&mut self, scope: &str, key: &str, rec_id: &str) {
        let at = epoch_ms_now();
        match &mut self.backend {
            Backend::Memory { idem, .. } => {
                idem.insert((scope.to_string(), key.to_string()), (rec_id.to_string(), at));
            }
            Backend::Sqlite(db) => {
                lock(db)
                    .execute(
                        "INSERT INTO idem (entity, key, rec_id, at) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id, at = excluded.at",
                        params![scope, key, rec_id, at],
                    )
                    .unwrap_or_else(storage_failed);
            }
        }
    }

    fn approval_issue(&mut self, key: &str) {
        self.put_row("approvals", key, &json!({ "expiresAt": epoch_ms_now() + APPROVAL_TTL_MS }));
    }

    /// Spend an approval key: true only for one issued, unspent and unexpired.
    fn approval_consume(&mut self, key: &str) -> bool {
        let Some(approval) = self.row("approvals", key) else { return false };
        self.delete_row("approvals", key);
        get(&approval, "expiresAt").as_i64().map_or(false, |expires| expires >= epoch_ms_now())
    }

    // events ----------------------------------------------------------------------

    fn append_event(&mut self, etype: &str, payload: &Value) -> Value {
        let seq = self.row("meta", "eventSeq").and_then(|s| s.as_i64()).unwrap_or(0) + 1;
        self.put_row("meta", "eventSeq", &json!(seq));
        let ev = json!({
            "seq": seq, "id": new_id("evt"), "app": self.app, "type": etype,
            "payload": payload, "createdAt": now_iso(),
        });
        match &mut self.backend {
            Backend::Memory { events, .. } => {
                events.push(ev.clone());
                let excess = events.len().saturating_sub(EVENT_RETENTION as usize);
                events.drain(..excess);
            }
            Backend::Sqlite(db) => {
                let db = lock(db);
                db.execute("INSERT INTO events (seq, data) VALUES (?1, ?2)", params![seq, js_json(&ev)])
                    .and_then(|_| db.execute("DELETE FROM events WHERE seq <= ?1", [seq - EVENT_RETENTION]))
                    .unwrap_or_else(storage_failed);
            }
        }
        ev
    }

    /// Events after `cursor`, and the cursor to ask with next. The cursor is
    /// read as the reference reads it (`Number(cursor) || 0`), so one that is
    /// not a number reads from the beginning.
    fn events_since(&self, cursor: Option<&str>) -> (Vec<Value>, String) {
        let from = match cursor.filter(|c| !c.is_empty()).map(js_number) {
            Some(n) if !n.is_nan() && n != 0.0 => n,
            _ => 0.0,
        };
        // `seq > from` for a whole-number seq, whatever kind of number `from` is.
        let after = if from >= i64::MAX as f64 { i64::MAX } else { from.floor().max(-1.0) as i64 };
        let fresh: Vec<Value> = match &self.backend {
            Backend::Memory { events, .. } => {
                events.iter().filter(|e| get(e, "seq").as_i64().unwrap_or(0) > after).cloned().collect()
            }
            Backend::Sqlite(db) => {
                let db = lock(db);
                let mut stmt =
                    db.prepare("SELECT data FROM events WHERE seq > ?1 ORDER BY seq").unwrap_or_else(storage_failed);
                let rows = stmt.query_map([after], |row| row.get::<_, String>(0)).unwrap_or_else(storage_failed);
                rows.map(|row| row.unwrap_or_else(storage_failed))
                    .filter_map(|s| serde_json::from_str(&s).ok())
                    .collect()
            }
        };
        let next = match fresh.last() {
            Some(last) => js_string(get(last, "seq")),
            None => js_number_string(from),
        };
        (fresh, next)
    }

    // tasks -----------------------------------------------------------------------

    /// Queue a task. `principal` is who asked for the work (spec/v0_2 auth.md
    /// §6.1), null for work the app queues on its own. An occurrence already
    /// queued (`dedup_key`) returns its task while that task is open.
    fn enqueue_task(
        &mut self,
        event_id: &str,
        capability: &str,
        payload: &Value,
        principal: Option<&str>,
        dedup_key: Option<&str>,
    ) -> Value {
        // The same request firing twice while its task is open is one task.
        // Once that task is completed, failed or canceled, asking again is a
        // new request: returning the finished task would leave the person no
        // way to ask again.
        let queued = dedup_key.and_then(|k| self.row("dedup", k)).and_then(|d| self.get_task(get_str(&d, "task")));
        if let Some(existing) = queued.filter(|t| OPEN_TASK.contains(&get_str(t, "status"))) {
            return existing;
        }
        // Random, never a counter: a task credential names its task, and
        // credentials outlive a restart that would reset a counter — a new
        // task must never revive an old task's credential.
        let id = new_id("tsk");
        let now = now_iso();
        let task = json!({
            "id": id, "app": self.app, "event": event_id,
            "status": "submitted",
            "request": { "capability": capability, "payload": payload, "principal": principal },
            "claim": null, "progress": { "step": null, "percent": 0 }, "result": null, "reason": null,
            "ask": null, "createdAt": now, "updatedAt": now, "dedupKey": dedup_key, "deliveries": 1,
        });
        self.put_row("tasks", &id, &task);
        if let Some(key) = dedup_key {
            self.put_row("dedup", key, &json!({ "task": id }));
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
                // two tasks, each run as the person who asked. Canonical JSON
                // (RFC 8785), so the key is adapter-core's for the same call.
                let mut occurrence = json!({ "type": etype, "capability": cap, "payload": payload });
                if let Some(p) = principal.filter(|p| !p.is_empty()) {
                    occurrence["principal"] = json!(p);
                }
                let key = format!("sha256:{}", hash_secret(&stable_json(&occurrence)));
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
    fn sweep(&mut self) {
        let now = epoch_ms_now();
        for (id, mut task) in self.rows("tasks") {
            if get_str(&task, "status") != "working" {
                continue;
            }
            if let Some(updated) = iso_epoch_ms(get_str(&task, "updatedAt")) {
                if now - updated < TASK_TIMEOUT_MS {
                    continue;
                }
            }
            let deliveries = get(&task, "deliveries").as_u64().unwrap_or(0);
            if deliveries >= TASK_MAX_DELIVERIES {
                task["status"] = json!("failed");
                task["reason"] = json!("redelivery_exhausted");
            } else {
                task["status"] = json!("submitted");
                task["claim"] = Value::Null;
                task["deliveries"] = json!(deliveries + 1);
            }
            task["updatedAt"] = json!(iso_of_ms(now));
            self.put_row("tasks", &id, &task);
        }
    }

    /// Every task, oldest first; only those in `status` when one is given.
    fn list_tasks(&self, status: Option<&str>) -> Vec<Value> {
        self.rows("tasks")
            .into_iter()
            .map(|(_, t)| t)
            .filter(|t| status.map_or(true, |s| get_str(t, "status") == s))
            .collect()
    }

    fn get_task(&self, task_id: &str) -> Option<Value> {
        self.row("tasks", task_id)
    }

    fn save_task(&mut self, mut task: Value) -> Value {
        task["updatedAt"] = json!(now_iso());
        let id = get_str(&task, "id").to_string();
        self.put_row("tasks", &id, &task);
        task
    }

    // audit -----------------------------------------------------------------------

    /// One audit row; the oldest fall off past the newest 5000. Not served over
    /// HTTP: it is the operator's record of who did what.
    fn append_audit(&mut self, entry: &Value) {
        match &mut self.backend {
            Backend::Memory { audit, .. } => {
                audit.push(entry.clone());
                let excess = audit.len().saturating_sub(AUDIT_RETENTION as usize);
                audit.drain(..excess);
            }
            Backend::Sqlite(db) => {
                let db = lock(db);
                db.execute("INSERT INTO audit (data) VALUES (?1)", [js_json(entry)])
                    .and_then(|_| {
                        db.execute("DELETE FROM audit WHERE n <= ?1", [db.last_insert_rowid() - AUDIT_RETENTION])
                    })
                    .unwrap_or_else(storage_failed);
            }
        }
    }

    /// The newest `n` audit rows, oldest first.
    fn audit_tail(&self, n: usize) -> Vec<Value> {
        match &self.backend {
            Backend::Memory { audit, .. } => audit[audit.len().saturating_sub(n)..].to_vec(),
            Backend::Sqlite(db) => {
                let db = lock(db);
                let mut stmt = db
                    .prepare("SELECT data FROM (SELECT n, data FROM audit ORDER BY n DESC LIMIT ?1) ORDER BY n")
                    .unwrap_or_else(storage_failed);
                let rows = stmt.query_map([n as i64], |row| row.get::<_, String>(0)).unwrap_or_else(storage_failed);
                rows.map(|row| row.unwrap_or_else(storage_failed))
                    .filter_map(|s| serde_json::from_str(&s).ok())
                    .collect()
            }
        }
    }

    // clock -----------------------------------------------------------------------

    /// The server's offset from UTC right now, in minutes east — what
    /// JavaScript's `-new Date().getTimezoneOffset()` reports. Read through
    /// SQLite's `localtime`, which applies the C library's own zone rules, so
    /// the stack needs no time-zone crate. Within one statement SQLite's 'now'
    /// is a single instant.
    fn local_offset_minutes(&self) -> i64 {
        const OFFSET: &str =
            "SELECT CAST(strftime('%s', 'now', 'localtime') AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER)";
        let seconds: rusqlite::Result<i64> = match &self.backend {
            Backend::Sqlite(db) => lock(db).query_row(OFFSET, [], |row| row.get(0)),
            Backend::Memory { .. } => {
                Connection::open_in_memory().and_then(|db| db.query_row(OFFSET, [], |row| row.get(0)))
            }
        };
        seconds.map_or(0, |s| s.div_euclid(60))
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
/// it against a fixture store.
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

        // Field name -> example ids, in first-hit order.
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
                        // `String(row.id ?? "")`: the id as text, an absent
                        // one as the empty string.
                        let id_text = match row.get("id").filter(|v| !v.is_null()) {
                            Some(v) => js_string(v),
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

/// The content-addressed key that approves one exact destructive call: the hex
/// SHA-256 of the RFC 8785 serialization of `{"operation", "args"}` —
/// adapter-core's `approvalKey`, so a key means the same call on every stack.
/// Approving one call approves no argument variant.
pub fn approval_key(name: &str, args: &Value) -> String {
    hash_secret(&stable_json(&json!({ "operation": name, "args": args })))
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

/// One operation runner: (args, ctx, store) -> JSON-able result, or an error.
/// `ctx` is who is calling: `{credentialId, agentName, principal, role}`.
///
/// The error is a `String` by default — a failure, answered 500
/// `operation_failed` — or, for a runner declared `Runner<OperationError>`,
/// an [`OperationError`], which can also refuse the call with a code of its
/// own. Either kind of `schema.rs` is served (see [`OperationRunner`]).
pub type Runner<E = String> = fn(&Value, &Value, &mut Store) -> Result<Value, E>;

/// Why an operation did not succeed — adapter-core's `OperationError`.
///
/// `OperationError::new(code, message)` is a REFUSAL: the caller gets that
/// code and message with status 400 (or [`status`](Self::status)) and any
/// extra fields ([`with`](Self::with)), the way a guard refusal reads. Anything
/// else converted into one (`?` on a `String` error) is a FAILURE: 500
/// `operation_failed`, "Operation "<name>" threw: <message>".
#[derive(Debug, Clone)]
pub struct OperationError {
    /// None for a failure rather than a refusal.
    code: Option<String>,
    message: String,
    status: u16,
    extra: Map<String, Value>,
}

impl OperationError {
    /// Refuse the call with `code` (status 400 unless set).
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        OperationError { code: Some(code.to_string()), message: message.into(), status: 400, extra: Map::new() }
    }

    /// Answer with this HTTP status instead of 400.
    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    /// Add a field to the refusal's envelope.
    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.extra.insert(key.to_string(), value);
        self
    }

    fn failure(message: String) -> Self {
        OperationError { code: None, message, status: 500, extra: Map::new() }
    }
}

impl From<String> for OperationError {
    fn from(message: String) -> Self {
        OperationError::failure(message)
    }
}

impl From<&str> for OperationError {
    fn from(message: &str) -> Self {
        OperationError::failure(message.to_string())
    }
}

impl fmt::Display for OperationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OperationError {}

/// A runner as the adapter holds it, whichever error type `schema.rs` chose:
/// `main.rs` turns what `operation_runner` returns into one with `from`, so a
/// schema written with `String` errors keeps compiling.
#[derive(Clone, Copy)]
pub enum OperationRunner {
    Plain(Runner),
    Typed(Runner<OperationError>),
}

impl From<Runner> for OperationRunner {
    fn from(runner: Runner) -> Self {
        OperationRunner::Plain(runner)
    }
}

impl From<Runner<OperationError>> for OperationRunner {
    fn from(runner: Runner<OperationError>) -> Self {
        OperationRunner::Typed(runner)
    }
}

impl OperationRunner {
    fn run(self, args: &Value, ctx: &Value, store: &mut Store) -> Result<Value, OperationError> {
        match self {
            OperationRunner::Plain(runner) => runner(args, ctx, store).map_err(OperationError::failure),
            OperationRunner::Typed(runner) => runner(args, ctx, store),
        }
    }
}

/// Runner resolution by operation name — `schema::operation_runner`, wrapped.
pub type RunnerLookup = fn(&str) -> Option<OperationRunner>;
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
    /// `dataVersion` = `<boot_mark>.<data_writes>` (see `data_version`).
    boot_mark: String,
    data_writes: u64,
    /// Open tabs, by the opaque per-tab id their update watcher sends, with
    /// when each was last heard from. A count is all that is ever published.
    viewers: HashMap<String, i64>,
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
            if let Some(declared) = d.get("ownedBy").filter(|v| !v.is_null()) {
                // The adapter writes the owner and the guard keeps clients from
                // doing so, which only holds for a declared, read-only string
                // field.
                let owned_by = js_string(declared);
                let owner = get(d, "fields").as_array().and_then(|a| a.iter().find(|f| get(f, "name") == declared));
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
        // Any object (a list included, as `typeof` says in the reference).
        if !(get(o, "params").is_object() || get(o, "params").is_array()) {
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
        store.app = config.app_id.clone();
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
            // App text forwarded into an agent's context is bounded first; the
            // framework's own sentence is the fallback.
            credential_hint: config.credential_hint.as_deref().and_then(bound_app_text).unwrap_or_else(|| {
                "Read the app's .agent-token file (mode 0600) in the project directory.".to_string()
            }),
            env: config.env,
            limiter: RateLimiter::new(),
            app_version: config.app_version,
            sign_in_failures: FailureLimiter::new(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS),
            dummy_hash: None,
            // A restart counts as a data change: a server that came back up may
            // have been restored under a page still holding rows from before.
            boot_mark: base36(epoch_ms_now() as u64),
            data_writes: 0,
            viewers: HashMap::new(),
        };

        // A capability's agent may hold only scopes the app declares.
        let declared = adapter.all_scopes();
        if let Some(caps) = adapter.capabilities.as_object() {
            for (capability, decl) in caps {
                let unknown: Vec<String> = get(decl, "scopes")
                    .as_array()
                    .map(|a| a.iter().map(js_string).filter(|s| s != "*" && !declared.contains(s)).collect())
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
            // Moves on every record write, separately from appVersion and
            // schemaVersion: a code change means the page must be replaced, a
            // data change only that it must re-read.
            "dataVersion": self.data_version(),
            "serverNow": now_iso(), "serverTzOffsetMinutes": self.store.local_offset_minutes(),
            "authMode": self.auth_mode, "accountUrl": ACCOUNT_URL,
        });
        if let Some(env) = &self.env {
            doc["env"] = json!(env);
        }
        // Published only when the app has one: a field that is sometimes empty
        // would make a client's "did it change?" comparison lie.
        if let Some(version) = self.app_version.as_ref().map(|v| v()).filter(|v| !v.is_empty()) {
            doc["appVersion"] = json!(version);
        }
        doc
    }

    /// `<boot time, base 36>.<writes since>` — the marker that moves when
    /// RECORDS change: a successful create, update or delete, or an operation
    /// not declared read-only (the adapter cannot see whether it wrote, and a
    /// needless refetch is cheaper than a stale tab). Never on a refused write.
    fn data_version(&self) -> String {
        format!("{}.{}", self.boot_mark, self.data_writes)
    }

    fn mark_data_changed(&mut self) {
        self.data_writes += 1;
    }

    // -- viewers ------------------------------------------------------------
    // "Is anyone looking at this app?" — for the CLI's `open --if-needed`. The
    // update watcher's identity poll carries the tab's opaque id as a header;
    // a closing tab says goodbye with `?viewer=<id>&leaving=1`. Only a count is
    // ever published, never who is looking.

    fn note_viewer(&mut self, headers: &HashMap<String, String>, q: &HashMap<String, String>) {
        let Some(id) = headers.get("x-a2app-viewer").or_else(|| q.get("viewer")) else { return };
        if id.is_empty() || js_len(id) > VIEWER_ID_MAX {
            return;
        }
        if headers.contains_key("x-a2app-viewer-leaving") || q.contains_key("leaving") {
            self.viewers.remove(id);
            return;
        }
        self.viewers.insert(id.clone(), epoch_ms_now());
        // A reloaded page gets a fresh id, so prune rather than grow forever.
        if self.viewers.len() > VIEWER_CAP {
            self.count_viewers();
        }
    }

    /// Live viewers, pruning the expired as it goes.
    fn count_viewers(&mut self) -> usize {
        let cutoff = epoch_ms_now() - VIEWER_TTL_MS;
        self.viewers.retain(|_, seen| *seen >= cutoff);
        self.viewers.len()
    }

    // -- navigational describe (A2APP-SPEC 3) -------------------------------
    // One request answers for one place in the app, never for the whole app.
    // Parity oracle: adapters/adapter-core/src/describe.ts.

    fn field_doc(f: &Value) -> Value {
        let mut field = Map::new();
        field.insert("type".to_string(), get(f, "type").clone());
        if truthy(get(f, "required")) {
            field.insert("required".to_string(), json!(true));
        }
        if truthy(get(f, "readOnly")) {
            field.insert("readOnly".to_string(), json!(true));
        }
        if let Some(max) = f.get("max") {
            field.insert("max".to_string(), max.clone());
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

    /// Whether a level fits the budget, measured as the reference measures it:
    /// the length of its compact JSON in UTF-16 code units.
    fn fits(level: &Value) -> bool {
        js_len(&js_json(level)) <= DESCRIBE_BUDGET_CHARS
    }

    /// Trim a list until the level fits, always reporting what was dropped.
    /// Entries go from the end, so the order an app declared decides what
    /// survives.
    fn fit_list<F: Fn(&[Value], usize) -> Value>(build: F, items: &[Value]) -> Value {
        let whole = build(items, 0);
        if Self::fits(&whole) {
            return whole;
        }
        let (mut lo, mut hi) = (0usize, items.len());
        while lo < hi {
            let mid = (lo + hi + 1) / 2; // ceil, as the reference computes it
            if Self::fits(&build(&items[..mid], items.len() - mid)) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        build(&items[..lo], items.len() - lo)
    }

    /// Entities of one module, in declaration order.
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

    fn operation_list(&self) -> &[Value] {
        self.operations.as_array().map(Vec::as_slice).unwrap_or_default()
    }

    /// The app's home screen: every module, how big it is, and whether this
    /// caller can reach it. Over the budget, the summaries go first (every
    /// module stays named); only then are rows dropped, counted, and
    /// `describe?all=true` offered.
    fn describe_root(&self, access: &Access, show_all: bool) -> Value {
        let mut modules = Vec::new();
        for m in self.modules.as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let name = get_str(m, "name");
            let owned = self.entities_of(name);
            let ops: Vec<&Value> = self.operation_list().iter().filter(|o| get_str(o, "module") == name).collect();
            let readable = owned.iter().filter(|(n, _)| access.read(n)).count();
            let writable = owned.iter().filter(|(n, _)| access.write(n)).count();
            let runnable = ops.iter().filter(|o| access.run(get_str(o, "name"))).count();
            // An ops-only module is reachable when any of its operations is.
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
        let build = |rows: &[Value], truncated: usize, summaries: bool| -> Value {
            let rows: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let mut r = r.clone();
                    if !summaries {
                        if let Some(row) = r.as_object_mut() {
                            row.shift_remove("summary");
                        }
                    }
                    r
                })
                .collect();
            let mut next = vec![json!("describe/{module}"), json!("describe?find={term}")];
            if truncated > 0 {
                next.push(json!("describe?all=true"));
            }
            let mut level = json!({
                "level": "root",
                "app": { "id": self.app_id, "name": self.app_name },
                "modules": rows,
                "conventions": Self::conventions(),
                "next": next,
            });
            if truncated > 0 {
                level["truncated"] = json!(truncated);
            }
            level
        };
        let whole = build(&modules, 0, true);
        if show_all || Self::fits(&whole) {
            return whole;
        }
        let bare = build(&modules, 0, false);
        if Self::fits(&bare) {
            return bare;
        }
        Self::fit_list(|rows, truncated| build(rows, truncated, false), &modules)
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
        for o in self.operation_list() {
            if get_str(o, "module") != module_name || o.get("entity").is_some() || !access.run(get_str(o, "name")) {
                continue;
            }
            let mut row = json!({ "name": get(o, "name") });
            if let Some(destructive) = o.get("destructive") {
                row["destructive"] = destructive.clone();
            }
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

    /// The first level carrying schemas, for one entity. Fields are never
    /// trimmed (a field absent from describe is read as write-only, which
    /// would silently disable the read-back check); its operations are, and
    /// the count dropped is reported.
    fn describe_entity(&self, module: &str, name: &str, d: &Value, access: &Access, show_all: bool) -> Value {
        let mut fields = Map::new();
        for f in Self::readable_fields(d) {
            fields.insert(get_str(&f, "name").to_string(), Self::field_doc(&f));
        }
        let mut ops = Vec::new();
        for o in self.operation_list() {
            if get(o, "entity").as_str() != Some(name) || !access.run(get_str(o, "name")) {
                continue;
            }
            let mut decl = json!({ "name": get(o, "name") });
            if let Some(destructive) = o.get("destructive") {
                decl["destructive"] = destructive.clone();
            }
            if let Some(params) = o.get("params") {
                decl["params"] = params.clone();
            }
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
        let path = format!("{module}/{name}");
        let build = |operations: &[Value], truncated: usize| -> Value {
            let mut next = vec![json!(format!("describe/{path}/{{id}}")), json!(format!("data {name} list"))];
            if truncated > 0 {
                next.push(json!(format!("describe/{path}?all=true")));
            }
            let mut level = json!({
                "level": "entity",
                "path": path,
                "label": label_field_of(get(d, "fields")),
                "records": format!("/api/collections/{name}/records"),
                "fields": fields,
                "operations": operations,
                "next": next,
            });
            if truthy(get(d, "auth")) {
                level["auth"] = json!(true);
            }
            if truthy(get(d, "ownedBy")) {
                level["ownedBy"] = get(d, "ownedBy").clone();
            }
            if truncated > 0 {
                level["truncated"] = json!(truncated);
            }
            level
        };
        if show_all {
            build(&ops, 0)
        } else {
            Self::fit_list(build, &ops)
        }
    }

    /// The parameter that takes THIS record, when the operation names one
    /// unambiguously: exactly one required `ref` to this entity. It lets a
    /// client fill the record's id in from the path without guessing; two
    /// candidates (a `move` taking `from` and `to`) name none.
    fn target_param_of(op: &Value, entity: &str) -> Option<String> {
        let candidates: Vec<String> = js_object(get(op, "params"))
            .into_iter()
            .filter(|(_, p)| {
                get(p, "type").as_str() == Some("ref")
                    && get(p, "entity").as_str() == Some(entity)
                    && get(p, "required") == &json!(true)
            })
            .map(|(name, _)| name)
            .collect();
        (candidates.len() == 1).then(|| candidates[0].clone())
    }

    /// A label as a screen shows it: text as is, anything else as `String()`,
    /// and nothing as null (never the text "null").
    fn label_text(label: &Value) -> Value {
        match label {
            Value::Null | Value::String(_) => label.clone(),
            other => json!(js_string(other)),
        }
    }

    fn describe_record(&self, module: &str, name: &str, d: &Value, record: &Value, access: &Access) -> Value {
        let fields = Value::Array(Self::readable_fields(d));
        let label = label_field_of(get(d, "fields")).map_or(Value::Null, |lf| get(record, &lf).clone());

        let mut ops = Vec::new();
        for o in self.operation_list() {
            if get(o, "entity").as_str() != Some(name) || !access.run(get_str(o, "name")) {
                continue;
            }
            let mut row = json!({ "name": get(o, "name"), "available": true });
            if truthy(get(o, "destructive")) {
                row["destructive"] = json!(true);
            }
            if let Some(target) = Self::target_param_of(o, name) {
                row["targetParam"] = json!(target);
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
            if get_str(f, "type") != "list<ref>" || f.get("entity").is_none() {
                continue;
            }
            let mut row = json!({ "name": get(f, "name"), "entity": get(f, "entity") });
            if let Some(list) = get(record, get_str(f, "name")).as_array() {
                row["count"] = json!(list.len());
            }
            relations.push(row);
        }

        let rec_id = js_string(get(record, "id"));
        let path = format!("{module}/{name}/{rec_id}");
        let mut next: Vec<Value> = relations
            .iter()
            .map(|r| json!(format!("describe/{path}/{}", js_string(get(r, "name")))))
            .collect();
        for o in &ops {
            if get(o, "available") == &json!(true) {
                next.push(json!(format!("{path} {}", js_string(get(o, "name")))));
            }
        }
        next.push(json!(format!("data {name} get {rec_id}")));

        let mut level = json!({
            "level": "record",
            "path": path,
            "id": get(record, "id"),
            "label": Self::label_text(&label),
            "operations": ops,
        });
        if !relations.is_empty() {
            level["relations"] = json!(relations);
        }
        level["next"] = json!(next);
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
        for o in self.operation_list() {
            let op_name = get_str(o, "name");
            if access.run(op_name) && op_name.to_lowercase().contains(&needle) {
                let path = match get(o, "entity").as_str().filter(|e| !e.is_empty()) {
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

    /// Rate gate, keyed by the credential presented, else the page's origin,
    /// else "anon". Over the limit answers 429 `rate_limited` before any work.
    fn rate_gate(&mut self, headers: &HashMap<String, String>, class: &str) -> Option<Reply> {
        // A token is a secret and the audit log is kept, so a caller is keyed by
        // the token's hash, never the token.
        let token = headers.get("x-a2app-token").or_else(|| headers.get("x-lui-token"));
        let caller = match (token.filter(|t| !t.is_empty()), headers.get("origin").filter(|o| !o.is_empty())) {
            (Some(token), _) => format!("token:{}", hash_secret(token)),
            (None, Some(origin)) => format!("origin:{origin}"),
            (None, None) => "anon".to_string(),
        };
        let decision = self.limiter.check(&caller, class);
        if decision.allowed {
            return None;
        }
        // Refused before the credential is even looked at, but still traced, so
        // a flood is visible afterwards.
        let ctx = json!({ "credentialId": caller, "agentName": null, "principal": null });
        self.audit(Some(&ctx), &format!("rate:{class}"), None, false, Some(ERR_RATE_LIMITED));
        Some(Self::err_with(
            429,
            ERR_RATE_LIMITED,
            &format!("Rate limit exceeded ({} per window). Slow down and retry.", decision.limit),
            &[("retryAfterSeconds", json!(decision.retry_after_seconds))],
        ))
    }

    /// One audit row: who (the call context; None when the caller was refused
    /// before there was one), what (`data:<entity>`, `op:<name>`,
    /// `task:<action>`, `rate:<class>`), which record, and how it ended.
    fn audit(&mut self, ctx: Option<&Value>, target: &str, record_id: Option<&str>, ok: bool, code: Option<&str>) {
        let field = |key: &str| ctx.map_or(Value::Null, |c| get(c, key).clone());
        let mut entry = json!({
            "at": now_iso(), "credentialId": field("credentialId"), "agentName": field("agentName"),
            "principal": field("principal"), "target": target, "recordId": record_id,
            "outcome": if ok { "ok" } else { "rejected" },
        });
        if let Some(code) = code.filter(|c| !c.is_empty()) {
            entry["code"] = json!(code);
        }
        self.store.append_audit(&entry);
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

        let show_all = q.get("all").map(String::as_str) == Some("true");
        if segments.is_empty() {
            return (200, self.describe_root(&access, show_all));
        }

        let module_name = &segments[0];
        let module = self
            .modules
            .as_array()
            .and_then(|a| a.iter().find(|m| get_str(m, "name") == module_name.as_str()))
            .cloned();
        let Some(module) = module else {
            let names: Vec<Value> =
                self.modules.as_array().map(|a| a.iter().map(|m| get(m, "name").clone()).collect()).unwrap_or_default();
            let message = format!("No module \"{module_name}\".");
            return Self::err_with(404, "unknown_module", &message, &[("modules", json!(names))]);
        };
        if segments.len() == 1 {
            return (200, self.describe_module(&module, &access, show_all));
        }

        let entity = &segments[1];
        let Some(d) = self.entity_defs.get(entity.as_str()).cloned() else {
            return Self::err(404, "unknown_entity", &format!("No such entity \"{entity}\"."));
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
                return Self::insufficient(&format!("data:{entity}:read"));
            }
            return (200, self.describe_entity(module_name, entity, &d, &access, show_all));
        }

        // From here the level reads stored records — authorize and meter as a read.
        if let Some(limited) = self.rate_gate(headers, "data") {
            return limited;
        }
        let ctx = match self.authorize(headers, Some(&format!("data:{entity}:read")), false) {
            Ok(ctx) => ctx,
            Err(reply) => return reply,
        };

        let record_id = &segments[2];
        let Some(record) = self.store.get_record(entity, record_id).filter(|r| self.visible(&d, &ctx, r)) else {
            return Self::err(404, "record_not_found", &format!("No {entity} record \"{record_id}\"."));
        };
        if segments.len() == 3 {
            return (200, self.describe_record(module_name, entity, &d, &record, &access));
        }

        let relation = &segments[3];
        let fields = get(&d, "fields").as_array().cloned().unwrap_or_default();
        let field = fields.iter().find(|f| {
            get_str(f, "name") == relation.as_str()
                && get_str(f, "type") == "list<ref>"
                && truthy(get(f, "entity"))
                && !truthy(get(f, "writeOnly"))
        });
        let Some(field) = field else {
            let relations: Vec<Value> = fields
                .iter()
                .filter(|f| get_str(f, "type") == "list<ref>" && !truthy(get(f, "writeOnly")))
                .map(|f| get(f, "name").clone())
                .collect();
            return Self::err_with(
                404,
                "unknown_relation",
                &format!("\"{relation}\" is not a sub-resource of {entity}."),
                &[("relations", json!(relations))],
            );
        };
        let target = js_string(get(field, "entity"));
        if !access.read(&target) {
            return Self::insufficient(&format!("data:{target}:read"));
        }
        let target_label = self.entity_defs.get(&target).and_then(|td| label_field_of(get(td, "fields")));
        let mut items = Vec::new();
        for rid in get(&record, relation).as_array().map(|a| a.as_slice()).unwrap_or_default() {
            let rid = js_string(rid);
            // A dangling reference is reported as the id it is, not dropped.
            let label = match (self.store.get_record(&target, &rid), &target_label) {
                (Some(rec), Some(lf)) => get(&rec, lf).clone(),
                _ => Value::Null,
            };
            items.push(json!({ "id": rid, "label": Self::label_text(&label) }));
        }

        let path = format!("{module_name}/{entity}/{record_id}/{relation}");
        let next = json!([format!("data {target} get {{id}}"), format!("describe/{module_name}/{entity}/{record_id}")]);
        let build = |rows: &[Value], truncated: usize| -> Value {
            let mut level = json!({
                "level": "relation", "path": path.clone(), "entity": target.clone(), "items": rows,
                "next": next.clone(),
            });
            if truncated > 0 {
                level["truncated"] = json!(truncated);
            }
            level
        };
        (200, Self::fit_list(build, &items))
    }

    fn insufficient(scope: &str) -> Reply {
        Self::err_with(
            403,
            ERR_INSUFFICIENT_SCOPE,
            &format!("This credential does not hold {scope}."),
            &[("required", json!(scope))],
        )
    }

    fn is_allowed_host(&self, raw: &str) -> bool {
        if self.allowed_hosts.contains(&raw.to_ascii_lowercase()) {
            return true;
        }
        hostname_of(raw).map_or(false, |name| is_loopback_name(&name) || self.allowed_hosts.contains(&name))
    }

    /// One request. Answers every path in the adapter's namespaces (a miss
    /// there is its own 404) and the identity alias; returns None for any
    /// other path, which is the View's. The Host check comes first and covers
    /// every path — the View's included, which is why `main.rs` asks here
    /// before serving a file.
    pub fn dispatch(
        &mut self,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: Option<&Value>,
        query: &HashMap<String, String>,
    ) -> Option<Answer> {
        let headers: HashMap<String, String> =
            headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
        let method = method.to_uppercase();
        let mut q = query.clone();
        let mut path = path.to_string();
        if let Some(idx) = path.find('?') {
            let qs = path[idx + 1..].to_string();
            path.truncate(idx);
            for (k, v) in parse_qs(&qs) {
                q.insert(k, v); // last value wins, as URLSearchParams read into an object does
            }
        }
        let trimmed = path.trim_end_matches('/');
        let path = if trimmed.is_empty() { "/" } else { trimmed };
        // What every handler reads: the body, or {} when there is none.
        let body = match body {
            None | Some(Value::Null) => json!({}),
            Some(b) => b.clone(),
        };

        // Before any route, including the unauthenticated identity document,
        // which is otherwise a free fingerprint of the app for a rebound page:
        // binding loopback does not stop a page on evil.com whose DNS
        // re-resolves to 127.0.0.1, but its Host header still says evil.com.
        if let Some(host) = headers.get("host") {
            if !self.is_allowed_host(host) {
                return Some(Answer::of(Self::err(
                    403,
                    "forbidden_host",
                    &format!("Refused: this app answers only on its own host, not \"{host}\"."),
                )));
            }
        }
        self.route(&method, path, &headers, &body, &q)
    }

    /// `decodeURIComponent` on one path segment, or the reference's answer to
    /// a malformed escape: its URIError, which surfaces as 500 `adapter_error`.
    fn decode_segment(segment: &str) -> Result<String, Reply> {
        decode_uri_component(segment).ok_or_else(|| Self::err(500, "adapter_error", "URI malformed"))
    }

    /// Every route, after the Host check, in adapter-core's order.
    fn route(
        &mut self,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: &Value,
        q: &HashMap<String, String>,
    ) -> Option<Answer> {
        let reply = |r: Reply| Some(Answer::of(r));
        if path == "/.well-known/a2app.json" || path == "/api/_a2app" {
            // The update watcher polls identity anyway, so its "I am still
            // here" rides along rather than doubling every tab's requests.
            self.note_viewer(headers, q);
            return reply((200, self.identity()));
        }
        // How many people have this app open: a count only, and behind a
        // credential — not a fact to hand to anyone who asks.
        if path == "/api/_a2app/viewers" {
            if let Err(refused) = self.authorize(headers, None, false) {
                return reply(refused);
            }
            let viewers = self.count_viewers();
            return reply((200, json!({ "a2app": true, "viewers": viewers, "ttlMs": VIEWER_TTL_MS })));
        }
        // Describe is navigational: the bare path is the root level, and each
        // extra segment moves one level inward (A2APP-SPEC 3). Segments are
        // decoded, since an id or a name may hold an escaped character.
        if path == "/api/_a2app/describe" {
            return reply(self.handle_describe(headers, &[], q));
        }
        if let Some(rest) = path.strip_prefix("/api/_a2app/describe/") {
            let segments = match rest.split('/').map(Self::decode_segment).collect::<Result<Vec<_>, _>>() {
                Ok(segments) => segments,
                Err(malformed) => return reply(malformed),
            };
            if segments.len() > 4 {
                return reply(Self::err(
                    404,
                    "usage",
                    "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.",
                ));
            }
            if segments.iter().any(String::is_empty) {
                return reply(Self::err(404, "usage", "describe path has an empty segment."));
            }
            return reply(self.handle_describe(headers, &segments, q));
        }
        if path == "/api/_a2app/whoami" {
            return reply(self.whoami(headers));
        }
        if let Some(rest) = path.strip_prefix("/api/_a2app/auth/") {
            // Unauthenticated by design (an agent starts here with nothing), so
            // it is metered like an operation before anything is looked up.
            if let Some(limited) = self.rate_gate(headers, "ops") {
                return reply(limited);
            }
            if let Some(answered) = self.handle_device(method, rest, headers, body) {
                return reply(answered);
            }
        }
        if path == "/api/_a2app/credentials" || path.starts_with("/api/_a2app/credentials/") {
            let id = match path.strip_prefix("/api/_a2app/credentials/").map(Self::decode_segment).transpose() {
                Ok(id) => id,
                Err(malformed) => return reply(malformed),
            };
            return reply(self.handle_credentials(method, id.as_deref(), headers, body));
        }
        // Accounts, sessions and invites (multi-user only) — the routes that
        // set a cookie.
        let account_route = ["/api/_a2app/session", "/api/_a2app/invites", "/api/_a2app/users"]
            .iter()
            .any(|p| path == *p || path.starts_with(&format!("{p}/")));
        if account_route {
            if !self.multi_user() {
                return reply(Self::err(404, "not_multi_user", "This app has no accounts: its authMode is none."));
            }
            let (answered, cookie) = self.handle_accounts(method, path, headers, body);
            let mut out = Answer::of(answered);
            if let Some(cookie) = cookie {
                out.headers.push(("Set-Cookie".to_string(), cookie));
            }
            return Some(out);
        }
        if path == "/api/_a2app/context" {
            if let Err(refused) = self.authorize(headers, None, false) {
                return reply(refused);
            }
            return reply((200, json!({ "a2app": true, "view": null, "selected": [] })));
        }
        if path == "/api/_a2app/events" {
            return reply(self.handle_events(headers, q));
        }
        if path == "/api/_a2app/tasks" || path.starts_with("/api/_a2app/tasks/") {
            let rest: Vec<String> = match path.strip_prefix("/api/_a2app/tasks/") {
                Some(r) => r.split('/').map(str::to_string).collect(),
                None => Vec::new(),
            };
            return reply(self.handle_tasks(method, headers, &rest, body, q));
        }

        // Records: /api/collections/{entity}/records[/{id}]
        if let Some(rest) = path.strip_prefix("/api/collections/") {
            let parts: Vec<&str> = rest.split('/').collect();
            let shaped = matches!(parts.len(), 2 | 3) && parts[1] == "records" && parts.iter().all(|p| !p.is_empty());
            if shaped {
                let decoded = Self::decode_segment(parts[0]).and_then(|entity| {
                    let id = parts.get(2).map(|id| Self::decode_segment(id)).transpose()?;
                    Ok((entity, id))
                });
                return reply(match decoded {
                    Ok((entity, id)) => self.handle_records(method, headers, &entity, id.as_deref(), body, q),
                    Err(malformed) => malformed,
                });
            }
        }

        // Operations: /api/ops/{name}
        if let Some(name) = path.strip_prefix("/api/ops/") {
            if !name.is_empty() && !name.contains('/') {
                if method != "POST" {
                    return reply(Self::err(405, "usage", "Operations are POST-only."));
                }
                return reply(match Self::decode_segment(name) {
                    Ok(name) => self.handle_operation(headers, &name, body),
                    Err(malformed) => malformed,
                });
            }
        }

        // A miss in the adapter's own namespaces is the adapter's to answer;
        // anything else is the View's.
        if ADAPTER_NAMESPACES.iter().any(|ns| path == *ns || path.starts_with(&format!("{ns}/"))) {
            return reply(Self::err(404, "not_found", UNKNOWN_ROUTE_MESSAGE));
        }
        None
    }

    /// whoami answers whoever this app will actually serve, which is what
    /// `authorize` decides — so it asks the same question. The 401 that remains
    /// is the honest one: on a multi-user app `authorize` really would refuse.
    fn whoami(&mut self, headers: &HashMap<String, String>) -> Reply {
        let caller = match self.resolve(headers, false) {
            Ok(caller) => caller,
            Err(reply) => return reply,
        };
        // The reach the request was given: a credential's scopes intersected
        // with what its person may do now, or a person's own. An anonymous read
        // was never scope-checked, so it reports the reach describe renders for
        // it — one source, so the two agree.
        let scopes = match caller.held {
            Some(held) => held,
            None => self.anonymous_reach(),
        };
        let principal = get_str(&caller.ctx, "principal");
        let principal_name = self.principal_info(principal).map_or(Value::Null, |p| get(&p, "name").clone());
        let mut scopes: Vec<String> = scopes.into_iter().collect();
        js_sort(&mut scopes);
        (
            200,
            json!({
                "a2app": true,
                "credentialId": get(&caller.ctx, "credentialId"),
                "agentName": get(&caller.ctx, "agentName"),
                "principal": principal,
                "principalName": principal_name,
                "role": get(&caller.ctx, "role"),
                "expiresAt": caller.grant.as_ref().map_or(Value::Null, |g| get(g, "expiresAt").clone()),
                "scopes": scopes,
            }),
        )
    }

    /// A guard refusal: the first violation up top, every one listed.
    fn guard_envelope(violations: &[Value], server_now: &str) -> Reply {
        let first = &violations[0];
        (
            400,
            json!({
                "a2app": true, "ok": false, "code": get(first, "code"), "field": get(first, "field"),
                "expected": get(first, "expected"), "got": get(first, "got"),
                "message": describe_violation(first, Some(server_now)),
                "violations": violations,
            }),
        )
    }

    // -- records ------------------------------------------------------------

    /// Whether `ctx` sees only its own records here and `rec_id` is not one of
    /// them: another member's record answers exactly as a missing one does.
    fn hidden(&self, d: &Value, ctx: &Value, entity: &str, rec_id: &str) -> bool {
        self.owned_only(d, ctx).is_some()
            && !self.store.get_record(entity, rec_id).map_or(false, |r| self.visible(d, ctx, &r))
    }

    fn handle_records(
        &mut self,
        method: &str,
        headers: &HashMap<String, String>,
        entity: &str,
        rec_id: Option<&str>,
        body: &Value,
        query: &HashMap<String, String>,
    ) -> Reply {
        if let Some(limited) = self.rate_gate(headers, "data") {
            return limited;
        }
        let Some(d) = self.entity_defs.get(entity).cloned() else {
            return Self::err(404, "unknown_entity", &format!("No such entity \"{entity}\"."));
        };
        let fields = get(&d, "fields").clone();
        let server_now = now_iso();
        let not_found = |id: &str| Self::err(404, "record_not_found", &format!("No {entity} record \"{id}\"."));

        if method == "GET" {
            let ctx = match self.authorize(headers, Some(&format!("data:{entity}:read")), false) {
                Ok(ctx) => ctx,
                Err(reply) => return reply,
            };
            if let Some(rec_id) = rec_id {
                return match self.store.get_record(entity, rec_id).filter(|r| self.visible(&d, &ctx, r)) {
                    Some(rec) => (200, rec),
                    None => not_found(rec_id),
                };
            }
            // `where` is the adapter's alone: a member sees only the records it
            // owns, constrained before paging so the counts are theirs too.
            let mut list_query = Map::new();
            if let Some(field) = self.owned_only(&d, &ctx) {
                list_query.insert("where".to_string(), json!({ field: get(&ctx, "principal") }));
            }
            for key in ["filter", "sort", "perPage", "page"] {
                if let Some(value) = query.get(key) {
                    list_query.insert(key.to_string(), json!(value));
                }
            }
            return match self.store.list_records(entity, &Value::Object(list_query)) {
                Ok(listed) => (200, listed),
                // Refuse, never ignore: unfiltered rows under a filter would be
                // a 200 with the wrong records (see the grammar's comment).
                Err(e) => Self::err_with(400, ERR_INVALID_FILTER, &e.to_string(), &[("got", json!(e.expression))]),
            };
        }

        let target = format!("data:{entity}");
        let ctx = match self.authorize(headers, Some(&format!("data:{entity}:write")), true) {
            Ok(ctx) => ctx,
            Err(reply) => {
                let code = get_str(&reply.1, "code").to_string();
                self.audit(None, &target, rec_id, false, Some(&code));
                return reply;
            }
        };

        if method == "DELETE" {
            let Some(rec_id) = rec_id else {
                return Self::err(400, "usage", "DELETE requires a record id.");
            };
            if self.hidden(&d, &ctx, entity, rec_id) {
                return not_found(rec_id);
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
                let total: usize = blockers.iter().map(|b| get(b, "ids").as_array().map_or(0, Vec::len)).sum();
                let where_list: Vec<String> = blockers
                    .iter()
                    .map(|b| format!("{}.{}", get_str(b, "entity"), get_str(b, "field")))
                    .collect();
                let said = if total == 1 {
                    "a record still references".to_string()
                } else {
                    format!("{total} records still reference")
                };
                self.audit(Some(&ctx), &target, Some(rec_id), false, Some(ERR_RECORD_REFERENCED));
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

            let deleted = self.store.delete_record(entity, rec_id);
            self.audit(Some(&ctx), &target, Some(rec_id), deleted, None);
            if !deleted {
                return not_found(rec_id);
            }
            self.mark_data_changed();
            return (200, json!({ "a2app": true, "ok": true, "deleted": rec_id }));
        }

        if method != "POST" && method != "PATCH" {
            return Self::err(405, "usage", &format!("{method} not allowed on records."));
        }

        // Idempotency: a replayed key is a 409 naming the record, on a create
        // (keyed by entity) and on an update (keyed by the row), checked before
        // anything is written and recorded only once the write is read back.
        let idem_key = headers
            .get("idempotency-key")
            .filter(|k| !k.is_empty() && (method == "POST" || rec_id.is_some()))
            .cloned();
        let idem_scope = match (method, rec_id) {
            ("PATCH", Some(id)) => format!("{entity}#{id}"),
            _ => entity.to_string(),
        };
        if let Some(key) = &idem_key {
            if let Some(prior) = self.store.idem_get(&idem_scope, key) {
                return Self::err_with(
                    409,
                    ERR_DUPLICATE_REQUEST,
                    "This idempotency key was already applied.",
                    &[("id", json!(prior))],
                );
            }
        }

        // Guard the RAW body before any backend coercion. Required-field
        // presence is enforced on CREATE only — a PATCH is a partial write.
        let allow = get(&d, "writeAllow").as_array().map(|list| {
            Value::Object(list.iter().filter_map(Value::as_str).map(|k| (k.to_string(), json!(true))).collect())
        });
        let violations = validate(&fields, body, allow.as_ref(), method == "POST");
        if !violations.is_empty() {
            self.audit(Some(&ctx), &target, rec_id, false, violations[0].get("code").and_then(Value::as_str));
            return Self::guard_envelope(&violations, &server_now);
        }

        // Backend write, over the body as the reference sees it. The owner field
        // is the adapter's to set: the guard has already refused a client that
        // tried, because it is read-only.
        let writing = js_object(body);
        let stored = if method == "POST" {
            let mut create = writing;
            if let Some(field) = get(&d, "ownedBy").as_str().filter(|f| !f.is_empty()) {
                create.insert(field.to_string(), get(&ctx, "principal").clone());
            }
            let rec = self.materialize(entity, &Value::Object(create));
            self.store.put_record(entity, rec.clone());
            rec
        } else {
            let Some(rec_id) = rec_id else {
                return Self::err(400, "usage", "PATCH requires a record id.");
            };
            if self.hidden(&d, &ctx, entity, rec_id) {
                return not_found(rec_id);
            }
            let Some(mut existing) = self.store.get_record(entity, rec_id) else {
                return not_found(rec_id);
            };
            for f in fields.as_array().map(|a| a.as_slice()).unwrap_or_default() {
                let name = get_str(f, "name");
                let Some(v) = writing.get(name).filter(|_| !truthy(get(f, "readOnly"))) else { continue };
                if is_blank(v) {
                    if let Some(obj) = existing.as_object_mut() {
                        obj.shift_remove(name);
                    }
                } else {
                    existing[name] = coerce(f, v);
                }
            }
            self.store.put_record(entity, existing.clone());
            existing
        };

        // Read-back: did every non-blank requested value land?
        let lost = divergences(&fields, body, |n| get(&stored, n).clone());
        if !lost.is_empty() {
            self.audit(Some(&ctx), &target, stored.get("id").and_then(Value::as_str), false, Some(ERR_NOT_STORED));
            let short: Vec<Value> =
                lost.iter().map(|l| json!({ "code": ERR_NOT_STORED, "field": get(l, "field") })).collect();
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

        let stored_id = js_string(get(&stored, "id"));
        if let Some(key) = &idem_key {
            self.store.idem_put(&idem_scope, key, &stored_id);
        }
        self.audit(Some(&ctx), &target, Some(&stored_id), true, None);
        self.mark_data_changed();
        (200, stored)
    }

    // -- operations ---------------------------------------------------------

    /// A declared operation's parameters, in the shape the record guard
    /// validates: an operation IS a write, so its arguments are held to the
    /// same rules — an undeclared, ill-typed or missing required argument is
    /// refused before anything runs.
    fn param_fields(decl: &Value) -> Value {
        let fields = js_object(get(decl, "params")).into_iter().map(|(name, p)| {
            let mut field = json!({ "name": name });
            for key in ["type", "required", "max", "values", "entity"] {
                if let Some(v) = p.get(key) {
                    field[key] = v.clone();
                }
            }
            field
        });
        Value::Array(fields.collect())
    }

    fn handle_operation(&mut self, headers: &HashMap<String, String>, name: &str, args: &Value) -> Reply {
        if let Some(limited) = self.rate_gate(headers, "ops") {
            return limited;
        }
        let Some(decl) = self.op_decl(name) else {
            return Self::err(404, "unknown_operation", &format!("No declared operation \"{name}\"."));
        };
        let ctx = match self.authorize(headers, Some(&format!("op:{name}")), !truthy(get(&decl, "readOnly"))) {
            Ok(ctx) => ctx,
            Err(reply) => return reply,
        };
        let target = format!("op:{name}");

        // Guard the RAW args before anything acts on them, and before an
        // approval key is minted: a person must never be asked to approve a
        // call that cannot run. Every argument is supplied fresh on each call,
        // so a declared `required` is always enforced.
        let violations = validate(&Self::param_fields(&decl), args, None, true);
        if !violations.is_empty() {
            self.audit(Some(&ctx), &target, None, false, violations[0].get("code").and_then(Value::as_str));
            return Self::guard_envelope(&violations, &now_iso());
        }

        // Idempotency: a key already spent on this operation is a 409. Checked
        // before approval; recorded only after a success, so a first call that
        // asked for approval or failed leaves the retry free to run.
        let idem_key = headers.get("idempotency-key").filter(|k| !k.is_empty()).cloned();
        if let Some(key) = &idem_key {
            if self.store.idem_get(&target, key).is_some() {
                return Self::err_with(
                    409,
                    ERR_DUPLICATE_REQUEST,
                    "This idempotency key already ran this operation.",
                    &[("operation", json!(name))],
                );
            }
        }

        // Approval: a destructive op needs the key for this exact call.
        if truthy(get(&decl, "destructive")) {
            let key = approval_key(name, args);
            let provided = headers.get("x-a2app-approval").or_else(|| headers.get("x-lui-approval"));
            match provided.filter(|p| !p.is_empty()) {
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

        let Some(runner) = (self.runner_lookup)(name) else {
            return Self::err(
                501,
                "not_implemented",
                &format!("This app declares \"{name}\" but implements no operation runner."),
            );
        };
        // A task the runner queues records its caller as who asked. A runner
        // that panics fails its own call, never the process.
        let outcome = {
            let scope = self.store.acting_for(get_str(&ctx, "principal"));
            catch_unwind(AssertUnwindSafe(|| runner.run(args, &ctx, &mut *scope.0)))
        };
        let failed =
            |message: &str| Self::err(500, "operation_failed", &format!("Operation \"{name}\" threw: {message}"));
        match outcome {
            Ok(Ok(result)) => {
                if let Some(key) = &idem_key {
                    self.store.idem_put(&target, key, name);
                }
                // A read-only operation promises no side effects; anything else
                // is assumed to have touched data.
                if get(&decl, "readOnly") != &json!(true) {
                    self.mark_data_changed();
                }
                self.audit(Some(&ctx), &target, None, true, None);
                (200, json!({ "a2app": true, "ok": true, "operation": name, "result": result }))
            }
            Ok(Err(e)) => match &e.code {
                Some(code) => {
                    self.audit(Some(&ctx), &target, None, false, Some(code));
                    let mut refusal = Self::err(e.status, code, &e.message);
                    for (key, value) in e.extra {
                        refusal.1[key.as_str()] = value;
                    }
                    refusal
                }
                None => {
                    self.audit(Some(&ctx), &target, None, false, Some("operation_failed"));
                    failed(&e.message)
                }
            },
            Err(panic) => {
                self.audit(Some(&ctx), &target, None, false, Some("operation_failed"));
                failed(&panic_message(panic.as_ref()))
            }
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
        body: &Value,
        query: &HashMap<String, String>,
    ) -> Reply {
        if let Some(limited) = self.rate_gate(headers, "data") {
            return limited;
        }
        let caller = match self.resolve(headers, method != "GET") {
            Ok(caller) => caller,
            Err(reply) => return reply,
        };
        let ctx = caller.ctx;
        let is_owner = get_str(&ctx, "role") == "owner";
        // The one task a task credential is for, if it is one.
        let own_task = caller.grant.as_ref().and_then(|g| get(g, "task").as_str()).map(str::to_string);

        // A task holds who asked and what was asked and answered, so it is
        // reached like a record (spec auth §6.3): an owner reaches every task,
        // a task credential its own, anyone else the tasks they queued.
        let reaches = |t: &Value| match &own_task {
            Some(id) => get_str(t, "id") == id,
            None => is_owner || get(get(t, "request"), "principal") == get(&ctx, "principal"),
        };
        // Progress and completion come from whoever runs the task.
        let runs = |t: &Value| {
            let claim = get(t, "claim");
            is_owner
                || own_task.as_deref() == Some(get_str(t, "id"))
                || (!claim.is_null()
                    && get(claim, "credentialId") == get(&ctx, "credentialId")
                    && get(claim, "principal") == get(&ctx, "principal"))
        };

        self.store.sweep();

        if rest.is_empty() && method == "GET" {
            let status = query.get("status").map(String::as_str).filter(|s| !s.is_empty());
            let tasks: Vec<Value> =
                self.store.list_tasks(status).iter().filter(|t| reaches(t)).map(Self::task_wire).collect();
            return (200, json!({ "a2app": true, "tasks": tasks, "pollAfterMs": 2000 }));
        }
        let task_id = match rest.first() {
            Some(id) if !id.is_empty() => id.clone(),
            _ => return Self::err(400, "usage", "Task id required."),
        };
        let action = rest.get(1).map(String::as_str);
        // A task out of reach answers as one that does not exist: its existence
        // is itself something the caller may not learn.
        let Some(mut task) = self.store.get_task(&task_id).filter(|t| reaches(t)) else {
            return Self::err(404, ERR_TASK_NOT_FOUND, &format!("No task \"{task_id}\"."));
        };
        if action.is_none() && method == "GET" {
            return (200, Self::task_wire(&task));
        }
        if method != "POST" {
            return Self::err(405, "usage", &format!("{method} not allowed here."));
        }
        let status = get_str(&task, "status").to_string();
        let in_progress = matches!(status.as_str(), "working" | "input-required");

        match action {
            Some("claim") => {
                if status != "submitted" {
                    self.audit(Some(&ctx), "task:claim", Some(&task_id), false, Some(ERR_TASK_NOT_CLAIMABLE));
                    let message = format!("Task {task_id} is {status}, not claimable.");
                    return Self::err(409, ERR_TASK_NOT_CLAIMABLE, &message);
                }
                // An explicit agent in the body must name the caller's own
                // credential; naming another is a claim as someone else, refused
                // rather than silently recorded as the true caller.
                if let Some(requested) = body.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty()) {
                    let credential_id = get_str(&ctx, "credentialId");
                    if requested != credential_id && get(&ctx, "agentName").as_str() != Some(requested) {
                        self.audit(Some(&ctx), "task:claim", Some(&task_id), false, Some("principal_mismatch"));
                        return Self::err_with(
                            403,
                            "principal_mismatch",
                            &format!(
                                "Cannot claim task {task_id} as \"{requested}\": the credential presented is {credential_id}."
                            ),
                            &[("requested", json!(requested)), ("actual", json!(credential_id))],
                        );
                    }
                }
                task["status"] = json!("working");
                task["claim"] = json!({
                    "credentialId": get(&ctx, "credentialId"), "principal": get(&ctx, "principal"),
                    "claimedAt": now_iso(),
                });
                let task = self.store.save_task(task);
                self.audit(Some(&ctx), "task:claim", Some(&task_id), true, None);
                (200, Self::task_wire(&task))
            }
            Some("progress") => {
                if status == "canceled" {
                    return Self::err(409, ERR_TASK_CANCELED, &format!("Task {task_id} was canceled."));
                }
                if !in_progress {
                    return Self::err(409, ERR_TASK_NOT_CLAIMABLE, &format!("Task {task_id} is {status}."));
                }
                if !runs(&task) {
                    return self.task_not_held(&ctx, "progress", &task_id);
                }
                if let Some(step) = body.get("step").filter(|s| s.is_string()) {
                    task["progress"]["step"] = step.clone();
                }
                if let Some(percent) = body.get("percent").filter(|p| p.is_number()) {
                    task["progress"]["percent"] = percent.clone();
                }
                // `ask` present at all — null included — puts the task to the
                // person; its absence resumes one that was waiting.
                if let Some(ask) = body.get("ask") {
                    task["ask"] = ask.clone();
                    task["status"] = json!("input-required");
                } else if status == "input-required" {
                    task["status"] = json!("working");
                }
                let task = self.store.save_task(task);
                self.audit(Some(&ctx), "task:progress", Some(&task_id), true, None);
                (200, Self::task_wire(&task))
            }
            Some("complete") => {
                if status == "canceled" {
                    return Self::err(409, ERR_TASK_CANCELED, &format!("Task {task_id} was canceled."));
                }
                // A terminal write belongs to a live claim. Once the sweeper has
                // returned a task to the queue, a late completion from the run
                // that abandoned it must not close work someone else may now be
                // doing.
                if !in_progress {
                    return Self::err(
                        409,
                        ERR_TASK_NOT_CLAIMABLE,
                        &format!("Task {task_id} is {status}, not in progress."),
                    );
                }
                if !runs(&task) {
                    return self.task_not_held(&ctx, "complete", &task_id);
                }
                match body.get("status").and_then(Value::as_str) {
                    Some("completed") => {
                        task["status"] = json!("completed");
                        let result = body.get("result").filter(|r| !r.is_null()).cloned();
                        task["result"] = result.unwrap_or_else(|| json!({}));
                    }
                    Some("failed") => {
                        task["status"] = json!("failed");
                        task["reason"] = json!(body.get("reason").and_then(Value::as_str).unwrap_or("unspecified"));
                    }
                    _ => return Self::err(400, "usage", "complete requires status \"completed\" or \"failed\"."),
                }
                let task = self.store.save_task(task);
                let failed = (get_str(&task, "status") == "failed").then_some("failed");
                self.audit(Some(&ctx), "task:complete", Some(&task_id), true, failed);
                (200, Self::task_wire(&task))
            }
            Some("cancel") => {
                // Terminal is terminal: relabelling finished work as canceled
                // would rewrite the recorded outcome.
                if TERMINAL_TASK.contains(&status.as_str()) {
                    return Self::err(409, ERR_TASK_NOT_CLAIMABLE, &format!("Task {task_id} already reached {status}."));
                }
                task["status"] = json!("canceled");
                let task = self.store.save_task(task);
                self.audit(Some(&ctx), "task:cancel", Some(&task_id), true, None);
                (200, Self::task_wire(&task))
            }
            Some("credential") => self.issue_task_credential(headers, &ctx, &task, body),
            other => Self::err(404, "usage", &format!("Unknown task action \"{}\".", other.unwrap_or("undefined"))),
        }
    }

    /// Progress or completion from a caller that reaches the task but does not
    /// run it (spec auth §6.3): refused, and audited like the other task
    /// refusals.
    fn task_not_held(&mut self, ctx: &Value, action: &str, task_id: &str) -> Reply {
        self.audit(Some(ctx), &format!("task:{action}"), Some(task_id), false, Some(ERR_TASK_NOT_HELD));
        let message =
            format!("Task {task_id} is held by another credential; only the run that holds it reports on it.");
        Self::err(403, ERR_TASK_NOT_HELD, &message)
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
    fn issue_task_credential(
        &mut self,
        headers: &HashMap<String, String>,
        ctx: &Value,
        task: &Value,
        body: &Value,
    ) -> Reply {
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
            Some(list) => list.iter().map(js_string).collect(),
            None => vec!["*".to_string()],
        };
        let (token, grant) =
            self.mint_credential(&principal, agent_name.as_deref(), scopes, TASK_CREDENTIAL_SECONDS, Some(task_id));
        self.audit(Some(ctx), "task:credential", Some(task_id), true, None);
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
    //
    // Approving is not enough on its own: anyone can start a request and send
    // the person its link. So approval issues a one-time confirmation code, and
    // the credential goes only to the poll that presents it. An agent on the
    // person's own computer receives it on a loopback port (RFC 8252) when the
    // account page returns the browser there; an agent elsewhere is given it by
    // the person.

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
        let code = match Self::decode_segment(rest.strip_prefix("device/")?) {
            Ok(code) => code,
            Err(malformed) => return Some(malformed),
        };
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
        // Where the agent waits on 127.0.0.1, when it runs on the person's own
        // computer: a whole number in the unprivileged range.
        let loopback_port = match body.get("loopbackPort") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::Number(n))
                if js_value_number(n).fract() == 0.0
                    && (LOOPBACK_PORT_MIN..=LOOPBACK_PORT_MAX).contains(&js_value_number(n)) =>
            {
                json_number(js_value_number(n))
            }
            Some(_) => {
                return Self::err(
                    400,
                    "usage",
                    &format!(
                        "loopbackPort is the port, {} to {}, where the agent waits on 127.0.0.1.",
                        js_number_string(LOOPBACK_PORT_MIN),
                        js_number_string(LOOPBACK_PORT_MAX)
                    ),
                )
            }
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
                "loopbackPort": loopback_port, "confirmationHash": null, "confirmAttempts": 0,
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
        let interval = get(&row, "interval").as_i64().unwrap_or(DEVICE_POLL_INTERVAL_SECONDS);
        match get_str(&row, "status") {
            "denied" => {
                self.store.delete_row("devices", &key);
                return Self::err(400, "access_denied", "The person declined this agent's request.");
            }
            "approved"
                if get(&row, "approvedBy").is_string()
                    && get(&row, "approvedScopes").is_array()
                    && get(&row, "confirmationHash").is_string() =>
            {
                // Answered at once, whatever the interval: wrong guesses are
                // bounded by DEVICE_CONFIRM_ATTEMPTS instead.
                let confirmation = body.get("confirmation").and_then(Value::as_str).map(normalize_user_code);
                let Some(confirmation) = confirmation.filter(|c| !c.is_empty()) else {
                    return Self::err_with(
                        400,
                        "confirmation_required",
                        "Approved. Present the confirmation code the approval produced.",
                        &[("interval", json!(interval))],
                    );
                };
                let expected = get_str(&row, "confirmationHash").as_bytes();
                if !bool::from(hash_secret(&confirmation).as_bytes().ct_eq(expected)) {
                    let attempts = get(&row, "confirmAttempts").as_i64().unwrap_or(0) + 1;
                    if attempts >= DEVICE_CONFIRM_ATTEMPTS {
                        self.store.delete_row("devices", &key);
                        return Self::err(
                            400,
                            "access_denied",
                            "Too many wrong confirmation codes: this request is void. Start again.",
                        );
                    }
                    row["confirmAttempts"] = json!(attempts);
                    self.store.put_row("devices", &key, &row);
                    return Self::err(
                        400,
                        "confirmation_invalid",
                        &format!(
                            "That is not this request's confirmation code ({} tries left).",
                            DEVICE_CONFIRM_ATTEMPTS - attempts
                        ),
                    );
                }
                // Single use: the row goes before the credential is handed out.
                self.store.delete_row("devices", &key);
                let principal = get_str(&row, "approvedBy").to_string();
                let Some(info) = self.principal_info(&principal).filter(|i| truthy(get(i, "active"))) else {
                    return Self::err(400, "access_denied", "The person who approved this is no longer active.");
                };
                let scopes: Vec<String> = get(&row, "approvedScopes")
                    .as_array()
                    .map(|a| a.iter().map(js_string).collect())
                    .unwrap_or_default();
                let expires_in = get(&row, "expiresInSeconds").as_i64().unwrap_or(DEFAULT_EXPIRES_SECONDS);
                let agent_name = get(&row, "agentName").as_str().map(str::to_string);
                let (token, grant) = self.mint_credential(&principal, agent_name.as_deref(), scopes, expires_in, None);
                let credential = Self::credential_wire(&grant, get(&info, "name"));
                return (200, json!({ "a2app": true, "token": token, "credential": credential }));
            }
            _ => {}
        }
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
        // When it was asked for, and whether the agent waits on this computer:
        // the person should approve only a request their own agent just showed
        // them.
        (
            200,
            json!({
                "a2app": true, "userCode": get(&row, "userCode"), "agentName": get(&row, "agentName"),
                "scopes": get(&row, "scopes"), "expiresIn": get(&row, "expiresInSeconds"),
                "expiresAt": get(&row, "expiresAt"), "requestedAt": get(&row, "createdAt"),
                "loopback": !get(&row, "loopbackPort").is_null(),
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
        // Approval hands nothing over by itself: the credential goes to the poll
        // that presents this code, which is stored only as its hash.
        let confirmation = new_user_code();
        row["status"] = json!("approved");
        row["approvedBy"] = json!(manager.principal);
        row["approvedScopes"] = scopes;
        row["confirmationHash"] = json!(hash_secret(&confirmation));
        self.store.put_row("devices", &key, &row);
        let redirect = match get(&row, "loopbackPort") {
            Value::Null => Value::Null,
            port => json!(format!(
                "http://127.0.0.1:{}{LOOPBACK_CALLBACK}?confirmation={}",
                js_string(port),
                encode_uri_component(&confirmation)
            )),
        };
        (
            200,
            json!({ "a2app": true, "ok": true, "status": "approved", "confirmation": confirmation, "redirect": redirect }),
        )
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
            return match Self::decode_segment(code) {
                Ok(code) => self.handle_invite(method, &code, body),
                Err(malformed) => (malformed, None),
            };
        } else if path == "/api/_a2app/users" {
            self.handle_users(method, headers, body, None)
        } else if let Some(id) = path.strip_prefix("/api/_a2app/users/") {
            match Self::decode_segment(id) {
                Ok(id) => self.handle_users(method, headers, body, Some(&id)),
                Err(malformed) => malformed,
            }
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

/// Parse a query string as `URLSearchParams` does (form encoding: `+` is a
/// space, escapes decoded, bad bytes replaced), into pairs. Read into a map,
/// a later duplicate wins, as it does in the reference.
pub fn parse_qs(qs: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(qs.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
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
    let mut codes: Vec<String> = validate(&fields, &bad, None, false)
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
        &json!(validate(&fields, &json!({ "title": "ok", "status": "todo" }), None, true)),
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
    fn no_runner(_: &str) -> Option<OperationRunner> {
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
            check(
                &mut failures,
                "dispatch refuses a foreign host before identity",
                &json!(answer.map(|a| a.status)),
                &json!(403),
            );
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
    //     may do now, a member sees only its own records and the tasks it
    //     asked for, and an unusable credential says why.
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
        let Some(answer) = app.dispatch(method, path, &headers, body.as_ref(), &HashMap::new()) else {
            return json!({ "_status": "not the adapter's" });
        };
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
            // Who reaches a task (spec §6.3): an owner every task, a task
            // credential its own, anyone else the tasks they asked for.
            let leo = json!({ "id": "usr_leo", "name": "Leo", "login": "leo", "role": "member", "active": true,
                              "createdAt": now_iso(), "passwordHash": "" });
            app.store.put_row("users", "usr_leo", &leo);
            let (leos_own, _) = app.mint_credential("usr_leo", Some("leo"), vec!["*".into()], 3600, None);
            let queue_for = |app: &mut Adapter, n: i64, principal: &str| {
                let fired = app.store.trigger_as("work.asked", &json!({ "n": n }), Some("work"), Some(principal));
                fired.map_or(String::new(), |f| get_str(&f, "taskId").to_string())
            };
            let (mias, leos) = (queue_for(&mut app, 1, "usr_mia"), queue_for(&mut app, 1, "usr_leo"));
            let listed = |app: &mut Adapter, token: &str| -> Vec<String> {
                let tasks = ask(app, "GET", "/api/_a2app/tasks", Some(token), None)["tasks"].clone();
                tasks.as_array().map(|a| a.iter().map(|t| get_str(t, "id").to_string()).collect()).unwrap_or_default()
            };
            let (by_owner, by_member) = (listed(&mut app, "admin-token"), listed(&mut app, &wide));
            check(
                &mut failures,
                "an owner lists every task, a member only the tasks they asked for",
                &json!([by_owner.contains(&mias) && by_owner.contains(&leos), by_member]),
                &json!([true, [&mias]]),
            );
            let task_path = |id: &str, action: &str| format!("/api/_a2app/tasks/{id}{action}");
            check(
                &mut failures,
                "…another's task is not found, to read, claim or cancel",
                &json!([
                    code_of(&ask(&mut app, "GET", &task_path(&leos, ""), Some(&wide), None)),
                    code_of(&ask(&mut app, "POST", &task_path(&leos, "/claim"), Some(&wide), None)),
                    code_of(&ask(&mut app, "POST", &task_path(&leos, "/cancel"), Some(&wide), None)),
                ]),
                &json!(["task_not_found", "task_not_found", "task_not_found"]),
            );
            ask(&mut app, "POST", &task_path(&leos, "/claim"), Some("admin-token"), None);
            let run = ask(&mut app, "POST", &task_path(&leos, "/credential"), Some("admin-token"), None);
            let run = get_str(&run, "token").to_string();
            check(
                &mut failures,
                "a task credential reaches its own task and no other",
                &json!([
                    ask(&mut app, "GET", &task_path(&leos, ""), Some(&run), None)["_status"],
                    code_of(&ask(&mut app, "GET", &task_path(&mias, ""), Some(&run), None)),
                    listed(&mut app, &run),
                ]),
                &json!([200, "task_not_found", [&leos]]),
            );
            let (step, done) = (json!({ "step": "reading" }), json!({ "status": "completed", "result": {} }));
            let complete_leos = task_path(&leos, "/complete");
            check(
                &mut failures,
                "the person who asked cannot report on a run they do not hold, audited, but can cancel it",
                &json!([
                    code_of(&ask(&mut app, "POST", &complete_leos, Some(&leos_own), Some(done.clone()))),
                    app.store.audit_tail(1).first().map(|e| json!([e["target"], e["outcome"], e["code"]])),
                    ask(&mut app, "POST", &task_path(&leos, "/cancel"), Some(&leos_own), None)["_status"],
                ]),
                &json!(["task_not_held", ["task:complete", "rejected", "task_not_held"], 200]),
            );
            check(
                &mut failures,
                "a member who claims their own task holds it, and reports on it",
                &json!([
                    ask(&mut app, "POST", &task_path(&mias, "/claim"), Some(&wide), None)["_status"],
                    ask(&mut app, "POST", &task_path(&mias, "/progress"), Some(&wide), Some(step))["_status"],
                    ask(&mut app, "POST", &task_path(&mias, "/complete"), Some(&wide), Some(done))["_status"],
                ]),
                &json!([200, 200, 200]),
            );
            let open = queue_for(&mut app, 2, "usr_mia");
            let (joined, again) = (queue_for(&mut app, 2, "usr_mia"), queue_for(&mut app, 1, "usr_mia"));
            check(
                &mut failures,
                "the same request joins its open task; once it is finished, it queues a new one",
                &json!([joined == open, again != mias, app.store.get_task(&again).map(|t| t["status"].clone())]),
                &json!([true, true, "submitted"]),
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

    // 16. JavaScript's reading and writing of numbers, which the reference's
    //     guard, coercion, cursors and messages all go through.
    let read = |s: &str| json_number(js_number(s));
    check(
        &mut failures,
        "Number(text) as JavaScript reads it",
        &json!([read(""), read(" 12 "), read("1e3"), read("0x1A"), read(".5"), read("5."), read("\u{feff}7"), read("-0")]),
        &json!([0, 12, 1000, 26, 0.5, 5, 7, 0]),
    );
    check(
        &mut failures,
        "…and what it refuses (NaN)",
        &json!(["inf", "NaN", "1_0", "+-1", "0x", "1e", "e5", "Infinity "].iter().map(|s| js_number(s).is_nan()).collect::<Vec<_>>()),
        &json!([true, true, true, true, true, true, true, false]),
    );
    check(
        &mut failures,
        "a number written as JavaScript writes it",
        &json!([1.0, 0.1, 1e21, 1.5e-7, 123_456_789_012_345_680_000.0, -0.0, 9_007_199_254_740_992.0, -2.5e-7]
            .iter()
            .map(|n| js_number_string(*n))
            .collect::<Vec<_>>()),
        &json!(["1", "0.1", "1e+21", "1.5e-7", "123456789012345680000", "0", "9007199254740992", "-2.5e-7"]),
    );

    // 17. The record guard, against vectors @a2app/rules itself produced:
    //     missing_required, text max (UTF-16 length), booleans are not numbers,
    //     list<enum> wants a list, enum values compared as text, body order
    //     (index-like keys first, as JavaScript orders them).
    let guarded = json!([
        { "name": "title", "type": "string", "required": true, "max": 5 },
        { "name": "n", "type": "number" },
        { "name": "b", "type": "boolean" },
        { "name": "tags", "type": "list<enum>", "values": ["a", "b"] },
        { "name": "kind", "type": "enum", "values": [1, "x"] },
        { "name": "when", "type": "datetime" },
        { "name": "made", "type": "string", "readOnly": true },
    ]);
    let writable = "one of: title, n, b, tags, kind, when";
    let v = |code: &str, field: &str, expected: &str, got: Value| {
        json!({ "code": code, "field": field, "expected": expected, "got": got })
    };
    for (label, body, create, expected) in [
        ("a create without a required field", json!({}), true, json!([v("missing_required", "title", "a non-blank value (required field)", Value::Null)])),
        ("a required field blanked", json!({ "title": "" }), false, json!([v("missing_required", "title", "a non-blank value (required field)", json!(""))])),
        ("text past its max", json!({ "title": "toolong" }), false, json!([v("invalid_string", "title", "text of at most 5 characters", json!("toolong"))])),
        ("max counts characters, not bytes", json!({ "title": "ééééé" }), false, json!([])),
        (
            "violations in body order",
            json!({ "z": 1, "title": 5 }),
            false,
            json!([v("unknown_field", "z", writable, json!(1)), v("invalid_string", "title", "text", json!(5))]),
        ),
        (
            "index-like keys first, ascending",
            json!({ "10": 1, "2": 2, "title": "ok" }),
            false,
            json!([v("unknown_field", "2", writable, json!(2)), v("unknown_field", "10", writable, json!(1))]),
        ),
        (
            "a boolean is not a number",
            json!({ "n": true, "b": "yes" }),
            false,
            json!([v("invalid_number", "n", "a number", json!(true)), v("invalid_boolean", "b", "true or false", json!("yes"))]),
        ),
        ("number and boolean text", json!({ "n": "1e3", "b": "true" }), false, json!([])),
        ("blank text is not a number", json!({ "n": " " }), false, json!([v("invalid_number", "n", "a number", json!(" "))])),
        ("Infinity and hex read as numbers", json!({ "n": "Infinity", "kind": "x" }), false, json!([])),
        ("inf does not", json!({ "n": "inf" }), false, json!([v("invalid_number", "n", "a number", json!("inf"))])),
        ("a list wants a list", json!({ "tags": "a" }), false, json!([v("invalid_enum", "tags", "an array of: a | b", json!("a"))])),
        ("…of declared values", json!({ "tags": ["a", "c"] }), false, json!([v("invalid_enum", "tags", "each of: a | b", json!(["a", "c"]))])),
        ("enum values compare as text", json!({ "kind": "1" }), false, json!([])),
        ("…so true is not 1", json!({ "kind": true }), false, json!([v("invalid_enum", "kind", "one of: 1 | x", json!(true))])),
        ("a date that is not in the calendar", json!({ "when": "2026-02-29" }), false, json!([v("invalid_date", "when", "an ISO 8601 date", json!("2026-02-29"))])),
        ("JavaScript white space before the zone", json!({ "when": "2024-02-29 10:00\u{a0}Z" }), false, json!([])),
        ("a read-only field", json!({ "made": "x" }), false, json!([v("read_only_field", "made", "not writable (server-managed)", json!("x"))])),
        ("a body that is a list is walked by index", json!([1]), false, json!([v("unknown_field", "0", writable, json!(1))])),
    ] {
        check(&mut failures, &format!("guard: {label}"), &json!(validate(&guarded, &body, None, create)), &expected);
    }
    check(
        &mut failures,
        "guard: nothing writable says so",
        &json!(validate(&json!([{ "name": "id", "type": "string", "readOnly": true }]), &json!({ "x": 1 }), None, false)),
        &json!([v("unknown_field", "x", "nothing — no writable fields are declared", json!(1))]),
    );
    let first = validate(&guarded, &json!({ "n": 1.0, "title": [1.5, { "a": 2 }] }), None, false);
    check(
        &mut failures,
        "a refusal's message writes the value as JSON.stringify does",
        &json!(first.first().map(|f| describe_violation(f, Some("2026-10-29T00:00:00.000Z")))),
        &json!("Rejected by a2app (invalid_string): field \"title\" expects text; got [1.5,{\"a\":2}]. Server time is 2026-10-29T00:00:00.000Z."),
    );
    check(
        &mut failures,
        "read-back exempts a write-only field",
        &json!(divergences(&json!([{ "name": "pw", "type": "string", "writeOnly": true }]), &json!({ "pw": "x" }), |_| Value::Null)),
        &json!([]),
    );

    // 18. The fingerprint and approval keys, against the reference's values:
    //     a numeric enum value and a fractional max move the hash, and an
    //     approval key is the sha256 of the RFC 8785 call.
    let ops = json!([
        { "name": "op", "module": "core", "destructive": true, "params": { "x": { "type": "number", "max": 2.5 } }, "appliesWhen": {} },
        { "name": "two", "module": "core", "entity": "tasks", "params": {} },
    ]);
    check(
        &mut failures,
        "schemaVersion is adapter-core's for the same model",
        &json!(schema_fingerprint(&json!({ "tasks": { "fields": guarded, "module": "core" } }), Some(&ops))),
        &json!("sv_a73d0ed4"),
    );
    check(
        &mut failures,
        "approval keys are adapter-core's",
        &json!([
            approval_key("clear-done", &json!({})),
            approval_key("move", &json!({ "to": [1.5, "x", null], "from": { "b": true, "a": 1e21 }, "é": "\n" })),
        ]),
        &json!([
            "7d745c845ebc004f343ea667d5b6e711ae3a8b842858cb0e79e4d3026519c00c",
            "68bb55b6be59b5333da220c9cf95ff930ffc1a3ec7b7abd07225d7e5b4d045d2"
        ]),
    );
    let pfields = json!([{ "name": "status", "type": "enum", "values": ["a", "b"] }, { "name": "n", "type": "number" }]);
    let precord = json!({ "status": "a", "n": "1.0" });
    check(
        &mut failures,
        "blocked reasons are adapter-core's",
        &json!([
            explain_predicate(&json!({ "not": { "field": "status", "in": ["a"] } }), &precord, &pfields),
            explain_predicate(&json!({ "not": { "all": [{ "field": "status", "eq": "a" }] } }), &precord, &pfields),
            explain_predicate(&json!({ "field": "n", "eq": 2 }), &precord, &pfields),
            explain_predicate(&json!({ "field": "n", "in": [1, 2.5] }), &precord, &pfields),
        ]),
        &json!([
            "the condition on status is not met",
            "the condition on the record is not met",
            "n is 1, not 2",
            "the condition holds"
        ]),
    );

    // 19. Device sign-in (spec §7): approving hands nothing over by itself.
    //     The credential goes only to the poll that presents the one-time
    //     confirmation code; five wrong codes void the request; an agent on
    //     the person's computer is sent the code on its loopback port.
    match Adapter::new(AdapterConfig {
        app_id: "selftest".into(),
        app_name: None,
        entities: json!({ "tasks": { "module": "core", "fields": [{ "name": "title", "type": "string" }] } }),
        operations: json!([]),
        store: Store::memory(json!({})),
        token: "admin-token".into(),
        permissions_of: None,
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
    }) {
        Err(e) => failures.push(format!("could not build an adapter for device sign-in: {e}")),
        Ok(mut app) => {
            let start = |app: &mut Adapter, body: Value| ask(app, "POST", "/api/_a2app/auth/device", None, Some(body));
            let poll = |app: &mut Adapter, device: &Value, confirmation: Option<&str>| {
                let mut body = json!({ "deviceCode": device["deviceCode"] });
                if let Some(c) = confirmation {
                    body["confirmation"] = json!(c);
                }
                ask(app, "POST", "/api/_a2app/auth/token", None, Some(body))
            };
            let local = start(&mut app, json!({ "agentName": "here", "loopbackPort": 53682, "scopes": ["data:tasks:read"] }));
            let device_path = format!("/api/_a2app/auth/device/{}", local["userCode"].as_str().unwrap_or(""));
            let review = ask(&mut app, "GET", &device_path, Some("admin-token"), None);
            check(
                &mut failures,
                "the review says when it was asked for and that the agent waits on this computer",
                &json!([review["requestedAt"].is_string(), review["loopback"]]),
                &json!([true, true]),
            );
            check(
                &mut failures,
                "polling before approval waits",
                &code_of(&poll(&mut app, &local, None)),
                &json!("authorization_pending"),
            );
            let approved = ask(&mut app, "POST", &device_path, Some("admin-token"), Some(json!({ "approve": true })));
            let confirmation = approved["confirmation"].as_str().unwrap_or("").to_string();
            check(
                &mut failures,
                "approving issues a confirmation code and sends the browser to the agent's port",
                &json!([
                    confirmation.len() == 9 && normalize_user_code(&confirmation) == confirmation,
                    approved["redirect"],
                ]),
                &json!([true, format!("http://127.0.0.1:53682/a2app/callback?confirmation={confirmation}")]),
            );
            check(
                &mut failures,
                "approval alone hands nothing over, whatever the interval",
                &json!([code_of(&poll(&mut app, &local, None)), code_of(&poll(&mut app, &local, Some("BBBB-BBBB")))]),
                &json!(["confirmation_required", "confirmation_invalid"]),
            );
            let typed = confirmation.to_lowercase().replace('-', "");
            let issued = poll(&mut app, &local, Some(&typed));
            check(
                &mut failures,
                "the right code, in any case and without the dash, gets the credential once",
                &json!([issued["credential"]["principal"], issued["credential"]["scopes"], code_of(&poll(&mut app, &local, Some(&typed)))]),
                &json!(["owner", ["data:tasks:read"], "expired_token"]),
            );
            let remote = start(&mut app, json!({}));
            let remote_path = format!("/api/_a2app/auth/device/{}", remote["userCode"].as_str().unwrap_or(""));
            let sent = ask(&mut app, "POST", &remote_path, Some("admin-token"), Some(json!({ "approve": true })));
            let wrong: Vec<Value> = (0..5).map(|_| code_of(&poll(&mut app, &remote, Some("BBBB-BBBB")))).collect();
            check(
                &mut failures,
                "an agent elsewhere is sent nowhere, and five wrong codes void the request",
                &json!([sent["redirect"], wrong, code_of(&poll(&mut app, &remote, sent["confirmation"].as_str()))]),
                &json!([
                    null,
                    ["confirmation_invalid", "confirmation_invalid", "confirmation_invalid", "confirmation_invalid", "access_denied"],
                    "expired_token"
                ]),
            );
            check(
                &mut failures,
                "a loopback port is a whole number from 1024 to 65535",
                &json!([
                    code_of(&start(&mut app, json!({ "loopbackPort": 80 }))),
                    code_of(&start(&mut app, json!({ "loopbackPort": 5000.5 }))),
                    code_of(&start(&mut app, json!({ "loopbackPort": "5000" }))),
                    start(&mut app, json!({ "loopbackPort": 65535 }))["_status"],
                ]),
                &json!(["usage", "usage", "usage", 200]),
            );
        }
    }

    // 20. Operations: arguments guarded like a record write, typed refusals
    //     answered with the runner's own status and code, a failure or a panic
    //     answered 500 operation_failed — the process carries on — idempotency
    //     keys spent once, and dataVersion moved only by a change.
    fn refusing(_: &Value, _: &Value, _: &mut Store) -> Result<Value, OperationError> {
        Err(OperationError::new("over_budget", "That would go over budget.").status(402).with("limit", json!(3)))
    }
    fn failing(_: &Value, _: &Value, _: &mut Store) -> Result<Value, String> {
        Err("the ledger is closed".to_string())
    }
    fn panicking(_: &Value, _: &Value, _: &mut Store) -> Result<Value, OperationError> {
        panic!("a runner bug")
    }
    fn counting(_: &Value, _: &Value, store: &mut Store) -> Result<Value, String> {
        let listed = store.list_records("tasks", &json!({})).map_err(|e| e.to_string())?;
        Ok(json!({ "count": listed["totalItems"] }))
    }
    fn runners(name: &str) -> Option<OperationRunner> {
        match name {
            "refuse" => Some(OperationRunner::from(refusing as Runner<OperationError>)),
            "fail" => Some(OperationRunner::from(failing as Runner)),
            "panic" => Some(OperationRunner::from(panicking as Runner<OperationError>)),
            "count" | "wipe" => Some(OperationRunner::from(counting as Runner)),
            _ => None,
        }
    }
    let op = |name: &str, extra: Value| {
        let mut decl = json!({ "name": name, "module": "core", "destructive": false, "params": {} });
        for (k, val) in extra.as_object().cloned().unwrap_or_default() {
            decl[k.as_str()] = val;
        }
        decl
    };
    match Adapter::new(AdapterConfig {
        app_id: "selftest".into(),
        app_name: None,
        entities: json!({ "tasks": { "module": "core", "fields": [{ "name": "title", "type": "string", "required": true }] } }),
        operations: json!([
            op("refuse", json!({})),
            op("fail", json!({})),
            op("panic", json!({})),
            op("count", json!({ "readOnly": true, "params": { "task": { "type": "ref", "entity": "tasks", "required": true }, "n": { "type": "number" } } })),
            op("wipe", json!({ "destructive": true })),
        ]),
        store: Store::memory(json!({})),
        token: "admin-token".into(),
        permissions_of: None,
        capabilities: json!({}),
        modules: json!([{ "name": "core" }]),
        allowed_origins: vec![],
        public_url: None,
        runner_lookup: runners,
        events: json!([]),
        auth_mode: "none".into(),
        credential_hint: None,
        env: None,
        app_version: None,
    }) {
        Err(e) => failures.push(format!("could not build an adapter for operations: {e}")),
        Ok(mut app) => {
            let run = |app: &mut Adapter, name: &str, body: Value| {
                ask(app, "POST", &format!("/api/ops/{name}"), Some("admin-token"), Some(body))
            };
            check(
                &mut failures,
                "an operation's arguments are guarded",
                &json!([
                    code_of(&run(&mut app, "count", json!({}))),
                    code_of(&run(&mut app, "count", json!({ "task": "t", "extra": 1 }))),
                    code_of(&run(&mut app, "count", json!({ "task": "t", "n": "many" }))),
                    run(&mut app, "count", json!({ "task": "t", "n": "2" }))["_status"],
                ]),
                &json!(["missing_required", "unknown_field", "invalid_number", 200]),
            );
            let refused = run(&mut app, "refuse", json!({}));
            check(
                &mut failures,
                "a typed refusal keeps its status, code, message and fields",
                &json!([refused["_status"], refused["code"], refused["message"], refused["limit"]]),
                &json!([402, "over_budget", "That would go over budget.", 3]),
            );
            let quiet = std::panic::take_hook();
            std::panic::set_hook(Box::new(|_| {}));
            let panicked = run(&mut app, "panic", json!({}));
            std::panic::set_hook(quiet);
            check(
                &mut failures,
                "a failing or panicking runner is a 500 operation_failed, and the app carries on",
                &json!([
                    run(&mut app, "fail", json!({}))["message"],
                    panicked["_status"],
                    panicked["message"],
                    run(&mut app, "count", json!({ "task": "t" }))["_status"],
                ]),
                &json!(["Operation \"fail\" threw: the ledger is closed", 500, "Operation \"panic\" threw: a runner bug", 200]),
            );
            let keyed = |app: &mut Adapter, key: &str| {
                let headers: HashMap<String, String> =
                    [("x-a2app-token", "admin-token"), ("idempotency-key", key)].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                let body = json!({ "task": "t" });
                app.dispatch("POST", "/api/ops/count", &headers, Some(&body), &HashMap::new()).map(|a| a.status)
            };
            check(
                &mut failures,
                "an operation's idempotency key is spent once; an empty one is no key",
                &json!([keyed(&mut app, "k"), keyed(&mut app, "k"), keyed(&mut app, ""), keyed(&mut app, "")]),
                &json!([200, 409, 200, 200]),
            );
            let before = app.data_version();
            run(&mut app, "count", json!({ "task": "t" }));
            ask(&mut app, "POST", "/api/collections/tasks/records", Some("admin-token"), Some(json!({})));
            let unmoved = app.data_version();
            ask(&mut app, "POST", "/api/collections/tasks/records", Some("admin-token"), Some(json!({ "title": "x" })));
            check(
                &mut failures,
                "dataVersion moves on a write, not on a read-only operation or a refused write",
                &json!([before == unmoved, unmoved != app.data_version()]),
                &json!([true, true]),
            );
            check(
                &mut failures,
                "a body that is not an object is walked as the reference walks it",
                &json!([
                    code_of(&ask(&mut app, "POST", "/api/collections/tasks/records", Some("admin-token"), Some(json!([])))),
                    code_of(&ask(&mut app, "POST", "/api/collections/tasks/records", Some("admin-token"), Some(json!(["x"])))),
                ]),
                &json!(["missing_required", "unknown_field"]),
            );
            let wipe = run(&mut app, "wipe", json!({}));
            check(
                &mut failures,
                "a destructive call asks for approval with the reference's key",
                &json!([wipe["_status"], wipe["approvalKey"]]),
                &json!([428, approval_key("wipe", &json!({}))]),
            );
            // Rate limits: keyed by the token's hash, which is all the audit
            // log ever records of it.
            let limited: Vec<Value> = (0..RATE_LIMIT_OPS + 1).map(|_| run(&mut app, "count", json!({ "task": "t" }))["_status"].clone()).collect();
            let last = app.store.audit_tail(1);
            check(
                &mut failures,
                "past the ops limit a caller is told when to come back, and the audit keeps the token's hash",
                &json!([
                    limited.last(),
                    last.first().map(|e| e["target"].clone()),
                    last.first().map(|e| e["credentialId"] == json!(format!("token:{}", hash_secret("admin-token")))),
                    stable_json(&json!(app.store.audit_tail(10_000))).contains("admin-token"),
                ]),
                &json!([429, "rate:ops", true, false]),
            );
        }
    }

    // 21. Viewers: an identity poll's heartbeat counts a tab, a goodbye
    //     uncounts it, and the count is all that is published.
    match Adapter::new(AdapterConfig {
        app_id: "selftest".into(),
        app_name: None,
        entities: json!({}),
        operations: json!([]),
        store: Store::memory(json!({})),
        token: "admin-token".into(),
        permissions_of: None,
        capabilities: json!({}),
        modules: json!([{ "name": "core" }]),
        allowed_origins: vec![],
        public_url: None,
        runner_lookup: no_runner,
        events: json!([]),
        auth_mode: "none".into(),
        credential_hint: None,
        env: None,
        app_version: None,
    }) {
        Err(e) => failures.push(format!("could not build an adapter for viewers: {e}")),
        Ok(mut app) => {
            let poll = |app: &mut Adapter, headers: &[(&str, &str)], query: &str| {
                let headers: HashMap<String, String> = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                app.dispatch("GET", &format!("/api/_a2app{query}"), &headers, None, &HashMap::new());
            };
            poll(&mut app, &[("x-a2app-viewer", "tab-1")], "");
            poll(&mut app, &[("x-a2app-viewer", "tab-2")], "");
            poll(&mut app, &[("x-a2app-viewer", &"x".repeat(65))], "");
            let two = ask(&mut app, "GET", "/api/_a2app/viewers", Some("admin-token"), None);
            poll(&mut app, &[], "?viewer=tab-2&leaving=1");
            check(
                &mut failures,
                "viewers are counted by heartbeat and uncounted by goodbye",
                &json!([two["viewers"], two["ttlMs"], ask(&mut app, "GET", "/api/_a2app/viewers", Some("admin-token"), None)["viewers"]]),
                &json!([2, 60_000, 1]),
            );
        }
    }

    // 22. Persistence: tasks, their dedup keys, the event log and its cursor,
    //     approvals and idempotency keys outlive a restart, with their TTLs;
    //     the event log keeps the newest 5000 and `seq` counts on.
    let tmp = std::env::temp_dir().join(format!("a2app-selftest-{}", random_hex(8)));
    let db_path = tmp.join("data").join("db.sqlite");
    let restart_run = (|| -> Result<(), String> {
        let (task_id, cursor) = {
            let mut first = Store::sqlite(&db_path, json!({}))?;
            first.app = "selftest".into();
            let fired = first.trigger_as("work.asked", &json!({ "n": 1 }), Some("work"), Some("usr_mia"))?;
            first.approval_issue("approved-call");
            first.idem_put("op:wipe", "key-1", "wipe");
            first.append_audit(&json!({ "target": "op:wipe", "outcome": "ok" }));
            let (_, cursor) = first.events_since(None);
            (fired["taskId"].as_str().unwrap_or("").to_string(), cursor)
        };
        let mut second = Store::sqlite(&db_path, json!({}))?;
        second.app = "selftest".into();
        let task = second.get_task(&task_id).unwrap_or_default();
        let again = second.trigger_as("work.asked", &json!({ "n": 1 }), Some("work"), Some("usr_mia"))?;
        let other = second.trigger_as("work.asked", &json!({ "n": 2 }), Some("work"), None)?;
        let (newer, _) = second.events_since(Some(&cursor));
        check(
            &mut failures,
            "a task survives a restart, with its app, principal and fresh progress",
            &json!([task["app"], task["request"]["principal"], task["progress"], task["status"]]),
            &json!(["selftest", "usr_mia", { "step": null, "percent": 0 }, "submitted"]),
        );
        check(
            &mut failures,
            "the same occurrence is still the same task; a new one gets a fresh id",
            &json!([again["taskId"] == json!(task_id), other["taskId"] != json!(task_id), other["taskId"].as_str().map_or(false, |t| t.starts_with("tsk_"))]),
            &json!([true, true, true]),
        );
        check(
            &mut failures,
            "a cursor saved before a restart returns only newer events",
            &json!([newer.len(), newer.iter().all(|e| e["id"].as_str().map_or(false, |i| i.starts_with("evt_")))]),
            &json!([2, true]),
        );
        check(
            &mut failures,
            "approvals, idempotency keys and the audit log survive a restart",
            &json!([second.approval_consume("approved-call"), second.approval_consume("approved-call"), second.idem_get("op:wipe", "key-1"), second.audit_tail(1).len()]),
            &json!([true, false, "wipe", 1]),
        );
        if let Backend::Sqlite(db) = &second.backend {
            lock(db).execute("UPDATE idem SET at = 0", []).map_err(|e| e.to_string())?;
        }
        second.put_row("approvals", "stale-call", &json!({ "expiresAt": epoch_ms_now() - 1 }));
        check(
            &mut failures,
            "an idempotency key lapses after a day, an approval after ten minutes",
            &json!([second.idem_get("op:wipe", "key-1"), second.approval_consume("stale-call")]),
            &json!([null, false]),
        );
        drop(second);
        // A database from before keys expired: its keys count from the upgrade.
        let legacy = tmp.join("legacy.sqlite");
        let old = Connection::open(&legacy).map_err(|e| e.to_string())?;
        old.execute_batch(
            "CREATE TABLE idem (entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, PRIMARY KEY (entity, key));
             INSERT INTO idem VALUES ('tasks', 'old-key', 'rec_1');",
        )
        .map_err(|e| e.to_string())?;
        drop(old);
        let mut upgraded = Store::sqlite(&legacy, json!({}))?;
        check(&mut failures, "an older database's keys still hold", &json!(upgraded.idem_get("tasks", "old-key")), &json!("rec_1"));
        Ok(())
    })();
    if let Err(e) = restart_run {
        failures.push(format!("restart persistence errored: {e}"));
    }
    let _ = std::fs::remove_dir_all(&tmp);
    let mut ring = Store::memory(json!({}));
    for n in 0..EVENT_RETENTION + 3 {
        ring.append_event("tick", &json!({ "n": n }));
    }
    let (kept, next) = ring.events_since(Some("abc"));
    check(
        &mut failures,
        "the event log keeps the newest 5000, seq counting on; a junk cursor reads from the start",
        &json!([kept.len(), kept.first().map(|e| e["seq"].clone()), next, ring.events_since(Some("5003")).1, ring.events_since(Some("1.5")).0.len()]),
        &json!([5000, 4, "5003", "5003", 5000]),
    );

    if !failures.is_empty() {
        println!("a2app_adapter selftest FAILED:\n  - {}", failures.join("\n  - "));
        return 1;
    }
    println!(
        "a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store, \
         host and network policy, secrets, passwords, user codes, cookies, sign-in limits, grant requests, \
         the ceiling, record ownership, credential refusals, who reaches a task, asking again, \
         ownedBy and capability declarations, the runner's caller, JavaScript numbers, the reference's guard \
         vectors, fingerprint, approval keys and blocked reasons, device sign-in confirmation and loopback, \
         operation guard, typed errors, runner panics, idempotency, dataVersion, rate-limit audit, viewers, \
         restart persistence, the event ring)"
    );
    0
}
