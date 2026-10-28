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
//!
//! WHOSE RECORDS. `ownedBy` names a read-only string field the adapter fills
//! with the caller's principal on create. On a multi-user app a member then
//! lists, reads, changes and deletes only its own records (anyone else's
//! answer 404), and the owner sees all; on a single-user app every record is
//! the owner's. Operation runners get the caller as `ctx` (`principal`,
//! `role`) and hold themselves to the same rule — see `mine` below.

use serde_json::{json, Value};

use crate::a2app_adapter::{App, Runner, Store};

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
                { "name": "owner", "type": "string", "readOnly": true },
            ],
            "ownedBy": "owner",
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
        {
            "name": "request-triage",
            "description": "Ask an agent to work out what this task actually needs.",
            "destructive": false,
            "module": "planning",
            "entity": "tasks",
            "appliesWhen": { "field": "status", "ne": "done" },
            "params": { "task": { "type": "ref", "entity": "tasks", "required": true } },
        },
    ])
}

// The event types this app may emit (the app->agent direction). Declaring a
// type is what lets `store.trigger` fire it — an undeclared type is refused —
// so this list is the fixed set of things the app can ever ask an agent to
// react to, decided here by its author rather than at the moment of firing.
//
// Leave it empty until a feature genuinely needs agent judgment. Plain events
// want plain code; a task is for work a person would otherwise have to think
// about.
pub fn events() -> Value {
    json!([
        { "type": "task.needs_triage" },
    ])
}

// The app's optional hooks are methods on `App`; one left out takes the
// adapter's default.
impl App {
    // What the agent taking each capability's tasks may do, as scopes. The
    // bridge runs it with a credential that acts for the person who asked,
    // holds only these, and dies with the task — so an agent asked to triage
    // cannot do more than triage, nor more than that person could. A
    // capability left out gets `*`, still within the person's own reach.
    pub fn capabilities(&self) -> Value {
        json!({
            "triage": { "scopes": ["data:tasks:read", "data:tasks:write"] },
        })
    }

    // What each person may do is the other hook. Left out, as here, everyone
    // active may use everything (their records stay their own). To narrow it,
    // add a method beside `capabilities` returning scopes
    // (`data:<entity>:read|write`, `op:<name>`, `*`) for `{ id, name, role,
    // active }`; on a multi-user app every agent acting for that person is
    // limited to the same, on every request:
    //
    //     pub fn permissions_of(&self, principal: &Value) -> Vec<String> {
    //         if principal["role"] == "owner" { return vec!["*".into()]; }
    //         vec!["data:tasks:read".into(), "data:tasks:write".into(), "op:request-triage".into()]
    //     }
}

pub fn seed() -> Value {
    json!({
        "tasks": [
            { "id": "task_welcome", "title": "Welcome — edit or delete me", "status": "todo",
              "created": "2026-01-01T00:00:00Z", "owner": "owner" },
        ],
    })
}

// Operation runners: (args, ctx, store) -> Ok(JSON result) or Err(message).
// The adapter calls the runner for a declared operation once its arguments
// have passed the same guard as a record write; a destructive op is gated by
// approval first. An Err — or a panic — answers 500 operation_failed. `ctx` is
// who is calling: `{ credentialId, agentName, principal, role }`. `store` is
// the live SQLite-backed store — read with `store.get_record` /
// `store.list_records`, write with `store.put_record` /
// `store.delete_record`. Writes are durable when the call returns. A record
// read from the store is a COPY: mutate it, then `put_record` it back, or the
// change never happened. `store.trigger(type, payload, capability)` emits a
// declared event (see `request-triage` below); a task it queues is done by an
// agent acting as the caller.
//
// To refuse a call with a code of your own, runners return `Result<Value,
// OperationError>` and `operation_runner` returns
// `Option<Runner<OperationError>>`; then
// `Err(OperationError::new("over_budget", "why").status(402))` answers 402
// with that code (400 when no status is set).
pub fn operation_runner(name: &str) -> Option<Runner> {
    match name {
        "clear-done" => Some(run_clear_done),
        "count-tasks" => Some(run_count_tasks),
        "complete-task" => Some(run_complete_task),
        "request-triage" => Some(run_request_triage),
        _ => None,
    }
}

/// The record if `ctx` may touch it: an owner may touch any task, a member
/// only its own.
fn mine(ctx: &Value, rec: Option<Value>) -> Option<Value> {
    let owner = ctx["role"] == "owner";
    rec.filter(|r| owner || r["owner"].as_str().is_some_and(|o| ctx["principal"].as_str() == Some(o)))
}

/// Every task `ctx` may touch.
fn my_tasks(ctx: &Value, store: &Store) -> Result<Vec<Value>, String> {
    let listed = store.list_records("tasks", &json!({})).map_err(|e| e.to_string())?;
    let items = listed.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(items.into_iter().filter_map(|rec| mine(ctx, Some(rec))).collect())
}

fn run_clear_done(_args: &Value, ctx: &Value, store: &mut Store) -> Result<Value, String> {
    let done_ids: Vec<String> = my_tasks(ctx, store)?
        .iter()
        .filter(|rec| rec.get("status").and_then(Value::as_str) == Some("done"))
        .filter_map(|rec| rec.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut removed = 0;
    for id in &done_ids {
        if store.delete_record("tasks", id) {
            removed += 1;
        }
    }
    Ok(json!({ "removed": removed }))
}

fn run_count_tasks(_args: &Value, ctx: &Value, store: &mut Store) -> Result<Value, String> {
    Ok(json!({ "count": my_tasks(ctx, store)?.len() }))
}

fn run_complete_task(args: &Value, ctx: &Value, store: &mut Store) -> Result<Value, String> {
    let task_id = args.get("task").and_then(Value::as_str).unwrap_or("");
    let mut task = match mine(ctx, store.get_record("tasks", task_id)) {
        Some(t) => t,
        None => return Ok(json!({ "ok": false, "reason": "no such task" })),
    };
    task["status"] = json!("done");
    store.put_record("tasks", task);
    Ok(json!({ "ok": true, "task": task_id, "status": "done" }))
}

// The app->agent direction, in full. `store.trigger` emits a DECLARED event
// and, because a capability is named, queues a task on the app's own queue.
// From there an agent takes it — either because a harness is polling
// (`a2app <app> tasks next --wait`) or because `agent-app <app> bridge` is
// running and triggers one.
//
// Send IDS, not prose. The agent re-reads the record itself, so what goes in
// the payload is what it needs to find the work — never instructions, and never
// a copy of the data, which would be stale by the time it is read. Nothing here
// can widen what the agent may do: the payload is data on the other side, and
// the capability names the kind of work, not a command to run. The task
// records this runner's caller as who asked, and the agent that takes it acts
// as them, holding only the "triage" scopes in `App::capabilities`.
fn run_request_triage(args: &Value, ctx: &Value, store: &mut Store) -> Result<Value, String> {
    let task_id = args.get("task").and_then(Value::as_str).unwrap_or("");
    if mine(ctx, store.get_record("tasks", task_id)).is_none() {
        return Ok(json!({ "ok": false, "reason": "no such task" }));
    }
    let fired = store.trigger("task.needs_triage", &json!({ "task": task_id }), Some("triage"))?;
    Ok(json!({ "ok": true, "task": task_id, "queued": fired["taskId"] }))
}
