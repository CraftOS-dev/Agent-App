//! The app's data model + operations (AGENT-OWNED — edit this to evolve the app).
//!
//! Fields use the A2App protocol type vocabulary. `describe` and
//! `schemaVersion` are DERIVED from this by the adapter, so an agent always
//! sees the live model. Everything is expressed as `serde_json::Value` built
//! with the `json!` macro — the file stays declarative, and adding a field is
//! one line, not a type dance.
//!
//! MODULES COME FIRST. Every entity names the module it lives in, and every
//! operation names the module it appears under; modules themselves are
//! declared in `manifest.json`. That is what gives describe a root screen to
//! serve and keeps discovery bounded however large the app grows — an entity
//! or operation outside every module has no screen and cannot be reached by
//! walking.
//!
//! TWO FILES, ONE TRUTH: every operation below also lives in
//! `operations.json`, byte-agreeing on name/module/entity/params/flags — that
//! is the copy describe and the approval flow read. The gate fails a mismatch.

use serde_json::{json, Value};

use crate::a2app_adapter::{Runner, Store};

pub fn entities() -> Value {
    json!({
        "tasks": {
            "module": "planning",
            "summary": "what needs doing, and what is done",
            "fields": [
                { "name": "title", "type": "string", "required": true, "max": 200 },
                { "name": "status", "type": "enum", "values": ["todo", "doing", "done"] },
                { "name": "due", "type": "string", "max": 10, "dayKey": true },
                { "name": "notes", "type": "string", "max": 2000 },
                { "name": "created", "type": "datetime", "readOnly": true },
            ],
        },
    })
}

// `params` is REQUIRED and typed — the record screen renders it as the
// operation's signature, so arguments described only in prose can neither be
// shown nor checked. Declare {} for an operation that takes none.
//
// `entity` attaches an operation to a record screen; `appliesWhen` decides
// whether it is available on a given record, and the adapter derives the
// "blocked" reason from it. Comparisons only — never a natural-language rule.
pub fn operations() -> Value {
    json!([
        {
            "name": "clear-done",
            "description": "Delete every task whose status is done.",
            "destructive": true,
            "module": "planning",
            "params": {},
        },
        {
            "name": "count-tasks",
            "description": "Count the tasks.",
            "destructive": false,
            "readOnly": true,
            "idempotent": true,
            "module": "planning",
            "params": {},
        },
        {
            "name": "complete-task",
            "description": "Mark one task done.",
            "destructive": false,
            "module": "planning",
            "entity": "tasks",
            "appliesWhen": { "field": "status", "ne": "done" },
            "params": { "task": { "type": "ref", "entity": "tasks", "required": true } },
        },
    ])
}

pub fn seed() -> Value {
    json!({
        "tasks": [
            { "id": "task_welcome", "title": "Welcome — edit or delete me", "status": "todo",
              "created": "2026-01-01T00:00:00Z" },
        ],
    })
}

// Operation runners: (args, ctx, store) -> Ok(JSON result) or Err(message).
// The adapter calls the runner for a declared operation; a destructive op is
// gated by approval first. `store` is the live SQLite-backed store — read with
// `store.get_record` / `store.list_records`, write with `store.put_record` /
// `store.delete_record`. Writes are durable when the call returns. A record
// read from the store is a COPY: mutate it, then `put_record` it back, or the
// change never happened.
pub fn operation_runner(name: &str) -> Option<Runner> {
    match name {
        "clear-done" => Some(run_clear_done),
        "count-tasks" => Some(run_count_tasks),
        "complete-task" => Some(run_complete_task),
        _ => None,
    }
}

fn run_clear_done(_args: &Value, _ctx: &Value, store: &mut Store) -> Result<Value, String> {
    let listed = store.list_records("tasks", &json!({})).map_err(|e| e.to_string())?;
    let done_ids: Vec<String> = listed
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|rec| rec.get("status").and_then(Value::as_str) == Some("done"))
                .filter_map(|rec| rec.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut removed = 0;
    for id in &done_ids {
        if store.delete_record("tasks", id) {
            removed += 1;
        }
    }
    Ok(json!({ "removed": removed }))
}

fn run_count_tasks(_args: &Value, _ctx: &Value, store: &mut Store) -> Result<Value, String> {
    let listed = store.list_records("tasks", &json!({})).map_err(|e| e.to_string())?;
    Ok(json!({ "count": listed.get("totalItems").cloned().unwrap_or(json!(0)) }))
}

fn run_complete_task(args: &Value, _ctx: &Value, store: &mut Store) -> Result<Value, String> {
    let task_id = args.get("task").and_then(Value::as_str).unwrap_or("");
    let mut task = match store.get_record("tasks", task_id) {
        Some(t) => t,
        None => return Ok(json!({ "ok": false, "reason": "no such task" })),
    };
    task["status"] = json!("done");
    store.put_record("tasks", task);
    Ok(json!({ "ok": true, "task": task_id, "status": "done" }))
}
