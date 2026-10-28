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
#
# WHOSE RECORDS. `ownedBy` names a read-only string field the adapter fills
# with the caller's principal on create. On a multi-user app a member then
# lists, reads, changes and deletes only its own records (anyone else's answer
# 404), and the owner sees all; on a single-user app every record is the
# owner's. Operation runners get the caller as `ctx` ({"principal", "role"})
# and hold themselves to the same rule — see `mine` below.
#
# WHAT EACH PERSON MAY DO. On a multi-user app, an optional PERMISSIONS_OF
# returns the scopes a person may use (`data:<entity>:read|write`,
# `op:<name>`, `*`); every agent acting for them is limited to the same, on
# every request. Without it everyone active may use everything (their records
# stay their own):
#
#     PERMISSIONS_OF = lambda do |p|
#       p["role"] == "owner" ? ["*"] : ["data:tasks:read", "data:tasks:write", "op:request-triage"]
#     end
module A2appSchema
  # The record if `ctx` may touch it: an owner may touch any task, a member
  # only its own.
  def self.mine(ctx, rec)
    rec && (ctx["role"] == "owner" || rec["owner"] == ctx["principal"]) ? rec : nil
  end

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
        { "name" => "owner", "type" => "string", "readOnly" => true },
      ],
      "ownedBy" => "owner",
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
    {
      "name" => "request-triage",
      "description" => "Ask an agent to work out what this task actually needs.",
      "destructive" => false,
      "module" => "planning",
      "entity" => "tasks",
      "appliesWhen" => { "field" => "status", "ne" => "done" },
      "params" => { "task" => { "type" => "ref", "entity" => "tasks", "required" => true } },
    },
  ].freeze

  # The event types this app may emit (the app->agent direction). Declaring a
  # type is what lets `store.trigger` fire it — an undeclared type is refused —
  # so this list is the fixed set of things the app can ever ask an agent to
  # react to, decided here by its author rather than at the moment of firing.
  #
  # Leave it empty until a feature genuinely needs agent judgment. Plain events
  # want plain code; a task is for work a person would otherwise have to think
  # about.
  EVENTS = [
    { "type" => "task.needs_triage" },
  ].freeze

  # What the agent taking each capability's tasks may do, as scopes. The bridge
  # runs it with a credential that acts for the person who asked, holds only
  # these, and dies with the task — so an agent asked to triage cannot do more
  # than triage, nor more than that person could. A capability left out gets
  # `*`, still within the person's own reach.
  CAPABILITIES = {
    "triage" => { "scopes" => ["data:tasks:read", "data:tasks:write"] },
  }.freeze

  # Operation runners: (args, ctx, store) -> JSON-able result. The adapter
  # calls these for a declared operation; a destructive op is gated by approval
  # first. `ctx` is who is calling ({"credentialId", "agentName", "principal",
  # "role"}). `store` is the live SQLite-backed store — read with
  # store.get_record / store.list_records, write with store.put_record /
  # store.delete_record. Writes are durable when the call returns. A record
  # read from the store is a COPY: mutate it, then put_record() it back, or
  # the change never happened. store.trigger(type, payload, capability)
  # emits a declared event (see "request-triage" below); a task it queues is
  # done by an agent acting as the caller.
  OPERATION_RUNNERS = {
    "clear-done" => lambda do |_args, ctx, store|
      removed = 0
      store.list_records("tasks", {})["items"].each do |r|
        removed += 1 if r["status"] == "done" && mine(ctx, r) && store.delete_record("tasks", r["id"])
      end
      { "removed" => removed }
    end,
    "count-tasks" => lambda do |_args, ctx, store|
      { "count" => store.list_records("tasks", {})["items"].count { |r| mine(ctx, r) } }
    end,
    "complete-task" => lambda do |args, ctx, store|
      task = mine(ctx, store.get_record("tasks", args["task"]))
      next { "ok" => false, "reason" => "no such task" } if task.nil?
      task["status"] = "done"
      store.put_record("tasks", task)
      { "ok" => true, "task" => task["id"], "status" => task["status"] }
    end,
    # The app->agent direction, in full. store.trigger emits a DECLARED event
    # and, because a capability is named, queues a task on the app's own
    # queue. From there an agent takes it — either because a harness is
    # polling (`a2app <app> tasks next --wait`) or because `agent-app <app>
    # bridge` is running and triggers one.
    #
    # Send IDS, not prose. The agent re-reads the record itself, so what goes
    # in the payload is what it needs to find the work — never instructions,
    # and never a copy of the data, which would be stale by the time it is
    # read. Nothing here can widen what the agent may do: the payload is data
    # on the other side, and the capability names the kind of work, not a
    # command to run.
    "request-triage" => lambda do |args, ctx, store|
      task = mine(ctx, store.get_record("tasks", args["task"]))
      next { "ok" => false, "reason" => "no such task" } if task.nil?
      fired = store.trigger("task.needs_triage", { "task" => task["id"] }, "triage")
      { "ok" => true, "task" => task["id"], "queued" => fired["taskId"] }
    end,
  }.freeze

  SEED = {
    "tasks" => [
      { "id" => "task_welcome", "title" => "Welcome — edit or delete me",
        "status" => "todo", "created" => "2026-01-01T00:00:00Z", "owner" => "owner" },
    ],
  }.freeze
end
