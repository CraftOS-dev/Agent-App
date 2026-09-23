# The app's data model + operations (AGENT-OWNED — edit this to evolve the app).
#
# Fields use the A2App protocol type vocabulary. `describe` and `schemaVersion`
# are DERIVED from this by the adapter, so an agent always sees the live model.
# Everything here is string-keyed — records travel as JSON, and what the wire
# carries is what the rules see.
#
# MODULES COME FIRST. Every entity names the module it lives in, and every
# operation names the module it appears under; modules themselves are declared
# in `manifest.json`. That is what gives describe a root screen to serve and
# keeps discovery bounded however large the app grows — an entity or operation
# outside every module has no screen and cannot be reached by walking.
module A2appSchema
  ENTITIES = {
    "tasks" => {
      "module" => "planning",
      "summary" => "what needs doing, and what is done",
      "fields" => [
        { "name" => "title", "type" => "string", "required" => true, "max" => 200 },
        { "name" => "status", "type" => "enum", "values" => ["todo", "doing", "done"] },
        { "name" => "due", "type" => "string", "max" => 10, "dayKey" => true },
        { "name" => "notes", "type" => "string", "max" => 2000 },
        { "name" => "created", "type" => "datetime", "readOnly" => true },
      ],
    },
  }.freeze

  # `params` is REQUIRED and typed — the record screen renders it as the
  # operation's signature, so arguments described only in prose can neither be
  # shown nor checked. Declare {} for an operation that takes none.
  #
  # `entity` attaches an operation to a record screen; `appliesWhen` decides
  # whether it is available on a given record, and the adapter derives the
  # "blocked" reason from it. Comparisons only — never a natural-language rule.
  #
  # Two files, one truth: every row here has an identical row in
  # `operations.json`, byte-agreeing on name/module/params/flags. The gate
  # fails a mismatch.
  OPERATIONS = [
    {
      "name" => "clear-done",
      "description" => "Delete every task whose status is done.",
      "destructive" => true,
      "module" => "planning",
      "params" => {},
    },
    {
      "name" => "count-tasks",
      "description" => "Count the tasks.",
      "destructive" => false,
      "readOnly" => true,
      "idempotent" => true,
      "module" => "planning",
      "params" => {},
    },
    {
      "name" => "complete-task",
      "description" => "Mark one task done.",
      "destructive" => false,
      "module" => "planning",
      "entity" => "tasks",
      "appliesWhen" => { "field" => "status", "ne" => "done" },
      "params" => { "task" => { "type" => "ref", "entity" => "tasks", "required" => true } },
    },
  ].freeze

  # Operation runners: (args, ctx, store) -> JSON-able result. The adapter
  # calls these for a declared operation; a destructive op is gated by approval
  # first. `store` is the live SQLite-backed store — read with
  # store.get_record / store.list_records, write with store.put_record /
  # store.delete_record. Writes are durable when the call returns. A record
  # read from the store is a COPY: mutate it, then put_record() it back, or
  # the change never happened.
  OPERATION_RUNNERS = {
    "clear-done" => lambda do |_args, _ctx, store|
      removed = 0
      store.list_records("tasks", {})["items"].each do |r|
        removed += 1 if r["status"] == "done" && store.delete_record("tasks", r["id"])
      end
      { "removed" => removed }
    end,
    "count-tasks" => lambda do |_args, _ctx, store|
      { "count" => store.list_records("tasks", {})["totalItems"] }
    end,
    "complete-task" => lambda do |args, _ctx, store|
      task = store.get_record("tasks", args["task"])
      next { "ok" => false, "reason" => "no such task" } if task.nil?
      task["status"] = "done"
      store.put_record("tasks", task)
      { "ok" => true, "task" => task["id"], "status" => task["status"] }
    end,
  }.freeze

  SEED = {
    "tasks" => [
      { "id" => "task_welcome", "title" => "Welcome — edit or delete me",
        "status" => "todo", "created" => "2026-01-01T00:00:00Z" },
    ],
  }.freeze
end
