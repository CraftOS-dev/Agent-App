// The app's data model + operations (AGENT-OWNED — edit this to evolve the app).
//
// Fields use the A2App protocol type vocabulary (string · number · boolean ·
// datetime · enum · ref · list<enum> · list<ref> · json · binary). `describe`
// and `schemaVersion` are DERIVED from this by the adapter, so an agent always
// sees the live model — you never hand-write describe.
//
// MODULES COME FIRST. Every entity names the module it lives in, and every
// operation names the module it appears under; modules themselves are declared
// in `manifest.json`. That is what gives describe a root screen to serve and
// keeps discovery bounded however large the app grows — an entity or operation
// outside every module has no screen and cannot be reached by walking.
//
// REFERENCES GUARD DELETION. A `ref` (or `list<ref>`) names the entity it
// points at, and that declaration is enforced by the adapter: deleting a record
// something still points at is refused with `record_referenced`. An app that
// wants references to outlive the record says so on the field with
// `"onDelete": "ignore"`; there is deliberately no cascade or detach.
//
// This starter models a to-do list. Replace it with your own entities.
package main

var ENTITIES = map[string]M{
	"tasks": {
		"module":  "planning",
		"summary": "what needs doing, and what is done",
		"fields": []M{
			{"name": "title", "type": "string", "required": true, "max": 200},
			{"name": "status", "type": "enum", "values": []string{"todo", "doing", "done"}},
			{"name": "due", "type": "string", "max": 10, "dayKey": true},
			{"name": "notes", "type": "string", "max": 2000},
			{"name": "created", "type": "datetime", "readOnly": true},
		},
	},
}

// TWO FILES, ONE TRUTH: every operation lives HERE and in `operations.json`,
// byte-agreeing on name/module/entity/appliesWhen/params/flags. The adapter
// reads this list for describe + approval; the framework reads the JSON mirror.
// The gate fails a mismatch — keep them in sync when you add or change one.
//
// `params` is REQUIRED and typed — the record screen renders it as the
// operation's signature, so arguments described only in prose can neither be
// shown nor checked. Declare {} for an operation that takes none.
//
// `entity` attaches an operation to a record screen; `appliesWhen` decides
// whether it is available on a given record, and the adapter derives the
// "blocked" reason from it. Comparisons only — never a natural-language rule.
var OPERATIONS = []M{
	{
		"name":        "clear-done",
		"description": "Delete every task whose status is done.",
		"destructive": true,
		"module":      "planning",
		"params":      M{},
	},
	{
		"name":        "count-tasks",
		"description": "Count the tasks.",
		"destructive": false,
		"readOnly":    true,
		"idempotent":  true,
		"module":      "planning",
		"params":      M{},
	},
	{
		"name":        "complete-task",
		"description": "Mark one task done.",
		"destructive": false,
		"module":      "planning",
		"entity":      "tasks",
		"appliesWhen": M{"field": "status", "ne": "done"},
		"params":      M{"task": M{"type": "ref", "entity": "tasks", "required": true}},
	},
}

// Operation runners: (args, ctx, store) -> JSON-able result. The adapter calls
// these for a declared operation; a destructive op is gated by approval first.
// `store` is the live SQLite-backed store — read with store.getRecord /
// store.listRecords, write with store.putRecord / store.deleteRecord.
// Writes are durable when the call returns; there is no separate persist()
// step. A record fetched from the store is a COPY: mutate it, then
// putRecord() it back, or the change never happened.
var OPERATION_RUNNERS = map[string]OperationRunner{
	"clear-done": func(_ M, _ M, store *Store) (any, error) {
		result, err := store.listRecords("tasks", M{})
		if err != nil {
			return nil, err
		}
		removed := 0
		for _, rec := range toMList(result["items"]) {
			if rec["status"] == "done" && store.deleteRecord("tasks", getStr(rec, "id")) {
				removed++
			}
		}
		return M{"removed": removed}, nil
	},
	"count-tasks": func(_ M, _ M, store *Store) (any, error) {
		result, err := store.listRecords("tasks", M{})
		if err != nil {
			return nil, err
		}
		return M{"count": result["totalItems"]}, nil
	},
	"complete-task": func(args M, _ M, store *Store) (any, error) {
		task := store.getRecord("tasks", getStr(args, "task"))
		if task == nil {
			return M{"ok": false, "reason": "no such task"}, nil
		}
		task["status"] = "done"
		store.putRecord("tasks", task)
		return M{"ok": true, "task": task["id"], "status": "done"}, nil
	},
}

// Seed records are applied exactly once — when a boot CREATES the database
// file (first live boot, and every fresh dev database). Seeded data survives;
// test data you add at runtime does not carry to a fresh DB.
var SEED = map[string][]M{
	"tasks": {
		{"id": "task_welcome", "title": "Welcome — edit or delete me", "status": "todo", "created": "2026-01-01T00:00:00Z"},
	},
}
