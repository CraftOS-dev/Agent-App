//! Server wiring (SYSTEM-OWNED — hash-locked in the ownership canon).
//!
//! Mounts the A2App adapter (`a2app_adapter.rs`) on a tiny_http server. The
//! adapter owns the protocol; this file only translates HTTP <-> the adapter's
//! `dispatch()`, serves the built React View, and dispatches the toolkit's
//! command-line checks (`--selftest`, `--check-ops`, `--promote-check`).
//!
//! Run: `cargo run --release --quiet` from the project root — the launch
//! contract always starts the app with the project directory as the working
//! directory, so every path below (manifest.json, dist/, .agent-token, data/)
//! is resolved relative to it.
//!
//! The launch contract (`serve` and `dev` both set these; defaults cover a
//! direct `cargo run`):
//!   PORT            which port to bind. `serve` passes manifest.port; `dev` a
//!                   hidden port. Fallback: manifest.port, then 8095.
//!   A2APP_DATA_DIR  where records live (SQLite at <dir>/db.sqlite). `serve`
//!                   passes the toolkit's declared lifecycle dataDir ("data" —
//!                   what backup/restore/promote protect); `dev` passes a fresh
//!                   per-boot directory, which is how a dev instance runs
//!                   against a disposable database that re-seeds from empty.
//!   A2APP_ENV       "live" or "dev" — decides how the static View is served.
//!
//! tiny_http is synchronous; the request loop below is single-threaded, which
//! is deliberate and acceptable for this starter — one owner, one agent, a
//! handful of open tabs. An app that outgrows it moves the loop onto a thread
//! pool without touching the adapter.

mod a2app_adapter;
mod schema;

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use a2app_adapter::{parse_qs, random_hex, Adapter, AdapterConfig, Store};

// A protocol write is tiny; anything larger is a mistake or an attack. The
// body is read before the origin, credential and rate checks — the path does
// not even have to exist — so an unauthenticated caller must never be able to
// make the app buffer an arbitrary amount of memory. Same cap and envelope as
// the other blueprints' transports.
const MAX_REQUEST_BODY_BYTES: u64 = 5 * 1024 * 1024;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(a2app_adapter::selftest());
    }
    if args.iter().any(|a| a == "--check-ops") {
        std::process::exit(check_ops());
    }
    if args.iter().any(|a| a == "--promote-check") {
        std::process::exit(promote_check());
    }
    if let Err(message) = serve() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

/// Gate step "operations resolve": every operation declared in the schema must
/// have a runner, or the build fails before the app can 501 at runtime.
fn check_ops() -> i32 {
    let ops = schema::operations();
    let missing: Vec<String> = ops
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|o| schema::operation_runner(o.get("name").and_then(Value::as_str).unwrap_or("")).is_none())
                .map(|o| o.get("name").and_then(Value::as_str).unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default();
    if !missing.is_empty() {
        eprintln!("declared with no runner: {}", missing.join(", "));
        return 1;
    }
    println!("operations resolve ok");
    0
}

/// lifecycle.promote — apply a code change to the live database.
///
/// For a schema-in-code SQLite store there is no destructive migration chain:
/// changes are additive (a new field simply defaults to absent, an existing
/// record stays valid). By the time this runs, the framework has ALREADY taken
/// the mandatory pre-promote backup. The python blueprint's first step is "the
/// app must compile" — for a cargo binary, reaching this line proves it. So
/// this step:
///   1. confirms the current LIVE database is still readable under the new
///      schema,
///   2. REFUSES the one destructive case — an entity that still holds live
///      data being removed from the schema — so promote can never silently
///      orphan data.
fn promote_check() -> i32 {
    let live = Path::new("data").join("db.sqlite");
    if !live.exists() {
        println!("first install — no live database to migrate");
        return 0;
    }

    let held = read_live_counts(&live);
    let held = match held {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("live database is unreadable ({err}) — refusing to promote");
            return 1;
        }
    };

    let declared: BTreeSet<String> = schema::entities()
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let orphaned: Vec<String> = held
        .iter()
        .filter(|(entity, count)| *count > 0 && !declared.contains(entity))
        .map(|(entity, _)| entity.clone())
        .collect();
    if !orphaned.is_empty() {
        let plural = if orphaned.len() == 1 { "y" } else { "ies" };
        eprintln!(
            "refusing to promote: live data exists for entit{plural} removed from the schema ({}). \
             Removing an entity that holds data is destructive — migrate or export that data first.",
            orphaned.join(", ")
        );
        return 1;
    }

    let live_entities: Vec<String> = held
        .iter()
        .filter(|(_, count)| *count > 0)
        .map(|(entity, _)| entity.clone())
        .collect();
    println!(
        "live database compatible with the new schema ({} declared; live data in: {})",
        declared.len(),
        if live_entities.is_empty() { "none".to_string() } else { live_entities.join(", ") }
    );
    0
}

fn read_live_counts(live: &Path) -> Result<Vec<(String, i64)>, rusqlite::Error> {
    let db = rusqlite::Connection::open_with_flags(live, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = db.prepare("SELECT entity, COUNT(*) FROM records GROUP BY entity")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    rows.collect()
}

/* ------------------------------------------------------- structured log */

/// One JSON line per event on stdout (the log `agent-app serve` captures):
/// a single schema — ts, level, evt, then event fields — so diagnosis filters
/// by field instead of parsing prose. Never log record contents or secrets.
fn log_line(level: &str, evt: &str, fields: Value) {
    let mut line = json!({ "ts": a2app_adapter::now_iso(), "level": level, "evt": evt });
    if let (Some(dst), Some(src)) = (line.as_object_mut(), fields.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    println!("{line}");
}

/* ------------------------------------------------------------ credential */

fn agent_token() -> Result<String, String> {
    let file = Path::new(".agent-token");
    if file.exists() {
        return fs::read_to_string(file)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("cannot read .agent-token: {e}"));
    }
    let token = format!("a2app_{}", random_hex(24));
    fs::write(file, format!("{token}\n")).map_err(|e| format!("cannot write .agent-token: {e}"))?;
    // Restrict to the owner where the platform can express it; Windows ACLs
    // inherit from the project directory, which the framework already treats
    // as private.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/* ------------------------------------------------------------ static View */

/// Content types for the file kinds a Vite-built View is made of.
fn content_type_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "map" => "application/json",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Recursive copy (no symlink following) — the live boot snapshots `dist/`
/// into `.a2app/public` with this.
fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&from)?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Every regular file under `path` (a file is itself), as (rel, abs) pairs
/// sorted by the forward-slash relative path, never following a symlink — the
/// same containment rule the ownership canon walks with. `rel` keeps its
/// leading "/" for directory children and is "" for a file root, matching the
/// framework's static-view fingerprint.
fn files_under(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    fn walk(root: &Path, current: &Path, out: &mut Vec<(String, PathBuf)>) {
        let meta = match fs::symlink_metadata(current) {
            Ok(m) => m,
            Err(_) => return,
        };
        if meta.file_type().is_symlink() {
            return;
        }
        if meta.is_dir() {
            let entries = match fs::read_dir(current) {
                Ok(e) => e,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                walk(root, &entry.path(), out);
            }
        } else {
            let rel = current
                .strip_prefix(root)
                .map(|p| {
                    let s = p.to_string_lossy().replace('\\', "/");
                    if s.is_empty() {
                        s
                    } else {
                        format!("/{s}")
                    }
                })
                .unwrap_or_default();
            out.push((rel, current.to_path_buf()));
        }
    }
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// `appVersion`: "av_" + the first 16 hex of a sha256 over the version salt
/// (manifest.appVersion) and then, for every served file in sorted relative-
/// path order, path + NUL + content + NUL — plus the schema source file, which
/// shapes what the app tells an agent without being served itself. Content,
/// not mtime: a re-copy of identical bytes must NOT look like a new version.
/// It moves for exactly the changes `schemaVersion` is blind to — a new
/// component, a CSS tweak, reworded copy.
fn app_version(roots: &[PathBuf], salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b"\0");
    for root in roots {
        for (rel, file) in files_under(root) {
            hasher.update(rel.as_bytes());
            hasher.update(b"\0");
            hasher.update(fs::read(&file).unwrap_or_default());
            hasher.update(b"\0");
        }
    }
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    format!("av_{}", &hex[..16])
}

/// RFC 1123 date for Last-Modified, from unix seconds. Day 0 of the epoch was
/// a Thursday.
fn http_date(secs: i64) -> String {
    const WDAY: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = a2app_adapter::civil_from_days(days);
    let wday = WDAY[days.rem_euclid(7) as usize];
    format!(
        "{wday}, {d:02} {} {y:04} {:02}:{:02}:{:02} GMT",
        MON[(m - 1) as usize],
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Parse the RFC 1123 form this server emits ("Sun, 06 Nov 1994 08:49:37
/// GMT"). Anything else reads as unparseable, which conditionals treat as
/// not-fresh — the safe direction.
fn parse_http_date(s: &str) -> Option<i64> {
    const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let day: u32 = parts[1].parse().ok()?;
    let month = MON.iter().position(|m| *m == parts[2])? as u32 + 1;
    let year: i64 = parts[3].parse().ok()?;
    let hms: Vec<&str> = parts[4].split(':').collect();
    if hms.len() != 3 {
        return None;
    }
    let (h, mi, sec): (i64, i64, i64) = (hms[0].parse().ok()?, hms[1].parse().ok()?, hms[2].parse().ok()?);
    Some(a2app_adapter::days_from_civil(year, month, day) * 86_400 + h * 3600 + mi * 60 + sec)
}

/// Parse an `If-None-Match` list. `*` matches anything; weak comparison is the
/// correct one for a conditional GET (RFC 9110 13.1.2), so `W/` is stripped.
fn matches_etag(header: &str, etag: &str) -> bool {
    let strip = |s: &str| s.trim().trim_start_matches("W/").to_string();
    header.split(',').any(|candidate| {
        let value = strip(candidate);
        value == "*" || value == strip(etag)
    })
}

/// The file a static request names, or None when there is none to serve.
/// Containment is by construction: the decoded path is rebuilt from vetted
/// segments (no "..", no empty segment, no backslash or drive colon that
/// Windows would treat as an escape), so the join can never leave `root`.
fn resolve_static(root: &Path, raw_path: &str) -> Option<PathBuf> {
    let decoded = a2app_adapter::percent_decode(raw_path);
    if decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    let rel = decoded.trim_start_matches('/');
    let mut file = root.to_path_buf();
    if rel.is_empty() {
        file.push("index.html");
    } else {
        for segment in rel.split('/') {
            if segment.is_empty() || segment == ".." || segment.contains(':') {
                return None;
            }
            file.push(segment);
        }
    }
    // A directory is not a file: serving one would read EISDIR and turn a
    // simple miss into a 500.
    if file.is_file() {
        Some(file)
    } else {
        None
    }
}

/* ------------------------------------------------------------- responses */

fn respond_json(request: tiny_http::Request, status: u16, payload: &Value) -> u16 {
    let response = tiny_http::Response::from_string(payload.to_string())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"));
    let _ = request.respond(response);
    status
}

fn header(field: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(field.as_bytes(), value.as_bytes())
        .expect("static header strings are valid")
}

fn not_found_envelope() -> Value {
    json!({ "a2app": true, "ok": false, "code": "not_found", "message": "No such route." })
}

/* ---------------------------------------------------------------- serve */

fn serve() -> Result<(), String> {
    // Fail fast and loudly: a structured last line beats a silent wedge, and
    // the launch contract's supervisor is what restarts the process, not the
    // process.
    std::panic::set_hook(Box::new(|info| {
        let line = json!({
            "ts": a2app_adapter::now_iso(), "level": "error", "evt": "crash",
            "message": info.to_string(),
        });
        println!("{line}");
    }));

    let manifest: Value = serde_json::from_str(
        &fs::read_to_string("manifest.json").map_err(|e| format!("cannot read manifest.json: {e}"))?,
    )
    .map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;

    // The CLI reaches a running app at manifest.port; bind the same port so
    // the two always agree. PORT env overrides (`serve` passes manifest.port;
    // `dev` a hidden port), then manifest.port.
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or_else(|| manifest.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()))
        .unwrap_or(8095);
    let env = std::env::var("A2APP_ENV").unwrap_or_else(|_| "live".to_string());
    let data_dir = PathBuf::from(std::env::var("A2APP_DATA_DIR").unwrap_or_else(|_| "data".to_string()));

    // The React View is served BUILT: `npm run build` (part of the pipeline
    // build step) compiles `index.html` + `view/` into `dist/`. Source is
    // never served.
    let dist_dir = PathBuf::from("dist");
    if !dist_dir.is_dir() {
        // Refuse to serve an app with no View rather than 404-ing every human
        // who opens it: the build step is part of the pipeline, so a missing
        // dist/ means the pipeline has not run, not that this app is API-only.
        return Err("dist/ not found — the View is not built. Run the pipeline build (npm run build) first.".to_string());
    }

    // "Live loads code at boot": in the live environment the View is served
    // from a SNAPSHOT of dist/ taken at this boot (.a2app/public), matching
    // how the rest of the code is fixed at process start. Without it, a
    // rebuild mid-iteration would reach live users on their next refresh —
    // before any gate or verify has seen it. The dev instance serves dist/
    // directly (rebuild -> refresh); for tight View iteration `npm run dev:ui`
    // runs Vite's dev server with /api proxied here.
    let served_dir = if env == "live" {
        let snapshot = Path::new(".a2app").join("public");
        let _ = fs::remove_dir_all(&snapshot);
        copy_dir(&dist_dir, &snapshot).map_err(|e| format!("cannot snapshot dist/ to .a2app/public: {e}"))?;
        snapshot
    } else {
        dist_dir
    };

    // The update watcher lives at the project root, not inside the View build:
    // it is system-owned, and the View is the agent's to rewrite entirely.
    let update_js = PathBuf::from("a2app-update.js");

    let token = agent_token()?;
    let allowed_origins = vec![
        format!("http://localhost:{port}"),
        format!("http://127.0.0.1:{port}"),
    ];

    // appVersion is re-derived per identity request, so it stays true for a
    // server whose files changed under it — the same "derive, do not declare"
    // rule schemaVersion follows. The schema source is folded in: an
    // operation's description is not in schemaVersion either, yet it changes
    // what the app tells an agent.
    let version_roots = vec![served_dir.clone(), update_js.clone(), PathBuf::from("src/schema.rs")];
    let version_salt = manifest.get("appVersion").and_then(Value::as_str).unwrap_or("").to_string();
    let version_fn: Box<dyn Fn() -> String> = Box::new(move || app_version(&version_roots, &version_salt));

    let store = Store::sqlite(&data_dir.join("db.sqlite"), schema::seed())?;
    let mut adapter = Adapter::new(AdapterConfig {
        app_id: manifest.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        app_name: manifest.get("name").and_then(Value::as_str).map(str::to_string),
        entities: schema::entities(),
        operations: schema::operations(),
        store,
        token,
        // Modules are declared in the manifest and are what describe's root
        // level lists; every entity and operation names one.
        modules: manifest.get("modules").cloned().unwrap_or_else(|| json!([])),
        allowed_origins,
        runner_lookup: schema::operation_runner,
        auth_mode: manifest.get("authMode").and_then(Value::as_str).unwrap_or("none").to_string(),
        credential_hint: None,
        env: Some(env),
        app_version: Some(version_fn),
    })?;

    // Bind loopback explicitly. Binding every interface would make the app
    // reachable from the network while its own log line said localhost — and a
    // same-origin request is trusted as the owner without a credential, which
    // would make a scaffolded Agent App remotely writable by anyone who could
    // reach the port. Exposing it must be a deliberate act, hence the env var.
    let host = std::env::var("A2APP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let server = tiny_http::Server::http((host.as_str(), port))
        .map_err(|e| format!("cannot bind http://{host}:{port}: {e}"))?;

    log_line(
        "info",
        "boot",
        json!({
            "app": manifest.get("name").and_then(Value::as_str)
                .or_else(|| manifest.get("id").and_then(Value::as_str)),
            "a2appId": manifest.get("id").and_then(Value::as_str),
            "url": format!("http://{host}:{port}"),
        }),
    );

    // Observe every request for the log: id, method, path, status, duration.
    // Paths only — query strings can carry filters over user data.
    let mut next_request_id: u64 = 0;
    for request in server.incoming_requests() {
        next_request_id += 1;
        let id = next_request_id;
        let started = Instant::now();
        let method = request.method().as_str().to_uppercase();
        let url = request.url().to_string();
        let (path, query_string) = match url.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (url.clone(), String::new()),
        };
        let status = handle_request(&mut adapter, request, &method, &path, &query_string, &served_dir, &update_js);
        log_line(
            if status >= 500 { "error" } else { "info" },
            "http",
            json!({
                "id": id, "method": method, "path": path, "status": status,
                "ms": started.elapsed().as_millis() as u64,
            }),
        );
    }
    Ok(())
}

/// Route ownership, in order: (1) the A2App adapter answers every path it owns
/// (identity, describe, records, operations, tasks/events); (2) anything else
/// falls through to the static View, with `/_a2app/update.js` aliased to the
/// project-root watcher. Returns the status responded with, for the log.
fn handle_request(
    adapter: &mut Adapter,
    mut request: tiny_http::Request,
    method: &str,
    path: &str,
    query_string: &str,
    served_dir: &Path,
    update_js: &Path,
) -> u16 {
    let is_api = path == "/.well-known/a2app.json" || path.starts_with("/api/");
    if is_api {
        // Read the body under the cap, counting bytes as they arrive rather
        // than trusting Content-Length, so a client that lies gains nothing.
        let mut body: Option<Value> = None;
        if matches!(method, "POST" | "PATCH" | "PUT") {
            let mut buf: Vec<u8> = Vec::new();
            {
                let reader = request.as_reader();
                let mut limited = reader.take(MAX_REQUEST_BODY_BYTES + 1);
                if limited.read_to_end(&mut buf).is_err() {
                    buf.clear();
                }
            }
            if buf.len() as u64 > MAX_REQUEST_BODY_BYTES {
                return respond_json(
                    request,
                    413,
                    &json!({
                        "a2app": true, "ok": false, "code": "payload_too_large",
                        "message": format!("Request body exceeds the {MAX_REQUEST_BODY_BYTES}-byte limit."),
                        "limitBytes": MAX_REQUEST_BODY_BYTES,
                    }),
                );
            }
            let raw = String::from_utf8_lossy(&buf).into_owned();
            body = Some(if raw.trim().is_empty() {
                json!({})
            } else {
                // Hand the guard something it can reject by its own rules,
                // rather than 500-ing on a body that is not JSON. Same
                // envelope as the other blueprints' parsers.
                serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "__unparsed__": raw }))
            });
        }

        let headers: HashMap<String, String> = request
            .headers()
            .iter()
            .map(|h| (h.field.as_str().as_str().to_lowercase(), h.value.as_str().to_string()))
            .collect();
        let query: HashMap<String, String> = parse_qs(query_string).into_iter().collect();
        let (status, payload) = adapter.dispatch(method, path, &headers, body.as_ref(), &query);
        return respond_json(request, status, &payload);
    }

    // ---------------------------------------------------------- static View
    if method != "GET" && method != "HEAD" {
        let response = tiny_http::Response::from_string(
            json!({
                "a2app": true, "ok": false, "code": "method_not_allowed",
                "message": "Static assets are GET-only.",
            })
            .to_string(),
        )
        .with_status_code(405)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Allow", "GET, HEAD"));
        let _ = request.respond(response);
        return 405;
    }

    // Alias before path resolution: the watcher is served from the project
    // root, outside the built tree, so it survives any View rewrite.
    let file = if path == "/_a2app/update.js" {
        if update_js.is_file() {
            Some(update_js.to_path_buf())
        } else {
            None
        }
    } else {
        resolve_static(served_dir, path)
    };
    let file = match file {
        Some(f) => f,
        None => return respond_json(request, 404, &not_found_envelope()),
    };

    let body = match fs::read(&file) {
        Ok(b) => b,
        Err(_) => return respond_json(request, 404, &not_found_envelope()),
    };
    let digest = Sha256::digest(&body);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let etag = format!("\"{}\"", &hex[..32]);
    let mtime_secs = fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let last_modified = http_date(mtime_secs);

    // `Cache-Control: no-cache` is "cache it, but revalidate before every
    // use" — the right default for plain, unhashed filenames edited in place:
    // a reload always re-checks, and an unchanged file costs a bodyless 304.
    let validators = |resp: tiny_http::Response<std::io::Empty>| {
        resp.with_header(header("Content-Type", content_type_of(&file)))
            .with_header(header("Cache-Control", "no-cache"))
            .with_header(header("ETag", &etag))
            .with_header(header("Last-Modified", &last_modified))
    };

    // ETag wins where both validators are present: it compares content, while
    // If-Modified-Since compares a whole-second timestamp that an edit inside
    // the same second cannot move.
    let inm = request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("if-none-match"))
        .map(|h| h.value.as_str().to_string());
    let mut fresh = match &inm {
        Some(value) => matches_etag(value, &etag),
        None => false,
    };
    if !fresh && inm.is_none() {
        let ims = request
            .headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("if-modified-since"))
            .and_then(|h| parse_http_date(h.value.as_str()));
        if let Some(ims) = ims {
            fresh = mtime_secs <= ims;
        }
    }
    if fresh {
        let response = validators(tiny_http::Response::empty(304));
        let _ = request.respond(response);
        return 304;
    }

    if method == "HEAD" {
        let response =
            validators(tiny_http::Response::empty(200)).with_header(header("Content-Length", &body.len().to_string()));
        let _ = request.respond(response);
        return 200;
    }

    let response = tiny_http::Response::from_data(body)
        .with_status_code(200)
        .with_header(header("Content-Type", content_type_of(&file)))
        .with_header(header("Cache-Control", "no-cache"))
        .with_header(header("ETag", &etag))
        .with_header(header("Last-Modified", &last_modified));
    let _ = request.respond(response);
    200
}
