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

use crate::a2app_adapter::{OperationError, Runner, Store};

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
                // The queue task an agent is (or was last) working on for this
                // record. The runner sets it; the View follows it, so the person
                // can see the work they asked for until it is done.
                { "name": "agentTask", "type": "string", "max": 64, "readOnly": true },
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

pub fn seed() -> Value {
    json!({
        "tasks": [
            { "id": "task_welcome", "title": "Welcome — edit or delete me", "status": "todo",
              "created": "2026-01-01T00:00:00Z" },
        ],
    })
}

// Operation runners return JSON or OperationError. String errors convert with
// `?` / `.into()` to ordinary 500 operation_failed responses.
// The adapter calls the runner for a declared operation; a destructive op is
// gated by approval first. `store` is the live SQLite-backed store — read with
// `store.get_record` / `store.list_records`, write with `store.put_record` /
// `store.delete_record`. Writes are durable when the call returns. A record
// read from the store is a COPY: mutate it, then `put_record` it back, or the
// change never happened. `store.trigger(type, payload, capability)` emits a
// declared event (see `request-triage` below).
pub fn operation_runner(name: &str) -> Option<Runner> {
    match name {
        "clear-done" => Some(run_clear_done),
        "count-tasks" => Some(run_count_tasks),
        "complete-task" => Some(run_complete_task),
        "request-triage" => Some(run_request_triage),
        _ => None,
    }
}

fn run_clear_done(_args: &Value, _ctx: &Value, store: &mut Store) -> Result<Value, OperationError> {
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

fn run_count_tasks(_args: &Value, _ctx: &Value, store: &mut Store) -> Result<Value, OperationError> {
    let listed = store.list_records("tasks", &json!({})).map_err(|e| e.to_string())?;
    Ok(json!({ "count": listed.get("totalItems").cloned().unwrap_or(json!(0)) }))
}

fn run_complete_task(args: &Value, _ctx: &Value, store: &mut Store) -> Result<Value, OperationError> {
    let task_id = args.get("task").and_then(Value::as_str).unwrap_or("");
    let mut task = match store.get_record("tasks", task_id) {
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
// the capability names the kind of work, not a command to run.
//
// Identical triggers dedupe to ONE task, even after it has finished, so
// asking again with the same payload would hand back the old failure.
// Naming the previous task makes each request a new occurrence. The runner
// must refuse while that task is open, including CLI and second-tab calls.
//
// The task id goes on the record so the View can show the work until it is done
// (view/AgentTask.jsx). The validate gate checks that it does.
fn run_request_triage(args: &Value, _ctx: &Value, store: &mut Store) -> Result<Value, OperationError> {
    let task_id = args.get("task").and_then(Value::as_str).unwrap_or("");
    let mut task = match store.get_record("tasks", task_id) {
        Some(t) => t,
        None => return Ok(json!({ "ok": false, "reason": "no such task" })),
    };
    let mut payload = json!({ "task": task_id });
    if let Some(prev) = task.get("agentTask").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        let current = store.get_task(prev).ok_or_else(|| OperationError {
            status: 409, code: "agent_task_unavailable".into(),
            message: "The previous agent task could not be found.".into(), extra: json!({ "taskId": prev }),
        })?;
        if !matches!(current.get("status").and_then(Value::as_str), Some("completed" | "failed" | "canceled")) {
            return Err(OperationError {
                status: 409, code: "already_queued".into(),
                message: "This record already has unfinished agent work.".into(), extra: json!({ "taskId": prev }),
            });
        }
        payload["previous"] = json!(prev);
    }
    let fired = store.trigger("task.needs_triage", &payload, Some("triage"))?;
    task["agentTask"] = fired["taskId"].clone();
    store.put_record("tasks", task);
    Ok(json!({ "ok": true, "task": task_id, "queued": fired["taskId"] }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use crate::a2app_adapter::{Adapter, AdapterConfig};

    fn fixture() -> Adapter {
        Adapter::new(AdapterConfig {
            app_id: "triage-test".into(), app_name: None,
            entities: entities(), operations: operations(), store: Store::memory(seed()),
            token: "test".into(), modules: json!([{ "name": "planning" }]),
            allowed_origins: vec![], runner_lookup: operation_runner, events: events(),
            auth_mode: "none".into(), credential_hint: None, env: None, app_version: None,
        }).unwrap()
    }

    fn ask(app: &mut Adapter) -> (u16, Value) {
        app.dispatch("POST", "/api/ops/request-triage",
            &HashMap::from([("x-a2app-token".into(), "test".into())]),
            Some(&json!({ "task": "task_welcome" })), &HashMap::new())
    }

    #[test]
    fn triage_states() {
        for state in ["submitted", "working", "input-required", "completed", "failed", "canceled"] {
            let mut app = fixture();
            let (status, body) = ask(&mut app);
            assert_eq!(status, 200);
            let previous = body["result"]["queued"].as_str().unwrap().to_string();
            let mut task = app.store.get_task(&previous).unwrap();
            task["status"] = json!(state);
            app.store.save_task(task);
            let before = app.store.get_record("tasks", "task_welcome");
            let events = app.store.events_since(None).0.len();
            let (status, body) = ask(&mut app);
            if matches!(state, "completed" | "failed" | "canceled") {
                assert_eq!(status, 200, "{state}: {body}");
                let id = body["result"]["queued"].as_str().unwrap();
                assert_ne!(id, previous);
                assert_eq!(app.store.get_task(id).unwrap()["request"]["payload"]["previous"], previous);
            } else {
                assert_eq!(status, 409, "{state}: {body}");
                assert_eq!(body["code"], "already_queued");
                assert_eq!(body["taskId"], previous);
                assert_eq!(app.store.list_tasks(None).len(), 1);
                assert_eq!(app.store.events_since(None).0.len(), events);
                assert_eq!(app.store.get_record("tasks", "task_welcome"), before);
            }
        }
    }

    #[test]
    fn triage_unavailable() {
        let mut app = fixture();
        let mut record = app.store.get_record("tasks", "task_welcome").unwrap();
        record["agentTask"] = json!("missing");
        app.store.put_record("tasks", record);
        let (status, body) = ask(&mut app);
        assert_eq!(status, 409);
        assert_eq!(body["code"], "agent_task_unavailable");
        assert_eq!(body["taskId"], "missing");
        assert_eq!(app.store.list_tasks(None).len(), 0);
        assert_eq!(app.store.events_since(None).0.len(), 0);
    }

    #[test]
    fn ordinary_runner_failure() {
        fn fail(_: &Value, _: &Value, _: &mut Store) -> Result<Value, OperationError> {
            Err("ordinary failure".to_string().into())
        }
        let mut app = Adapter::new(AdapterConfig {
            runner_lookup: |_| Some(fail),
            app_id: "test".into(), app_name: None, entities: entities(), operations: operations(),
            store: Store::memory(seed()), token: "test".into(), modules: json!([{ "name": "planning" }]),
            allowed_origins: vec![], events: events(), auth_mode: "none".into(),
            credential_hint: None, env: None, app_version: None,
        }).unwrap();
        let (status, body) = ask(&mut app);
        assert_eq!(status, 500);
        assert_eq!(body["code"], "operation_failed");
        assert_eq!(body["message"], "Operation \"request-triage\" threw: ordinary failure");
    }
}
