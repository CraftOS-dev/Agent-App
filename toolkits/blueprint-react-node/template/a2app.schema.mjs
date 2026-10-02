/**
 * The app's data model + operations (AGENT-OWNED — edit this to evolve the app).
 *
 * `fields` are declared in the A2App protocol type vocabulary (string · number ·
 * boolean · datetime · enum · ref · list<enum> · list<ref> · json · binary).
 * `describe` and `schemaVersion` are DERIVED from this, so an agent always sees
 * the live model — you never hand-write describe.
 *
 * REFERENCES GUARD DELETION. A `ref` (or `list<ref>`) names the entity it points
 * at, and that declaration is enforced: deleting a record something still points
 * at is refused with `record_referenced`, naming the records in the way. You do
 * not write that check, and you cannot be routed around it — it runs inside the
 * adapter, so it holds for your own UI and for `a2app <app> data <entity> delete`
 * alike. Guarding deletion only inside an operation guards one of those two.
 *
 * If an app genuinely wants references to outlive the record, say so on the
 * field and the delete is allowed:
 *
 *     { name: "client", type: "ref", entity: "clients", onDelete: "ignore" }
 *
 * There is no `cascade` or `detach` on purpose: both would let one delete write
 * to records the caller never named, which an agent cannot approve up front and
 * an audit log cannot explain later. Declare an operation for that instead,
 * where it is named, described and approved like any other write.
 *
 * MODULES COME FIRST. Every entity names the module it lives in, and every
 * operation names the module it appears under; the modules themselves are
 * declared in `manifest.json`. That is what gives describe a root screen to
 * serve and keeps discovery bounded however large the app grows — an entity or
 * operation outside every module has no screen and cannot be reached by walking.
 *
 * This starter models a to-do list. Replace it with your own entities.
 */
export const schema = {
  entities: {
    tasks: {
      module: "planning",
      summary: "what needs doing, and what is done",
      fields: [
        { name: "title", type: "string", required: true, max: 200 },
        { name: "status", type: "enum", values: ["todo", "doing", "done"] },
        { name: "due", type: "string", max: 10, dayKey: true },
        { name: "notes", type: "string", max: 2000 },
        { name: "created", type: "datetime", readOnly: true },
        // The queue task an agent is (or was last) working on for this record.
        // The runner sets it; the View follows it, so the person can see the
        // work they asked for until it is done.
        { name: "agentTask", type: "string", max: 64, readOnly: true },
      ],
      seed: [
        { id: "task_welcome", title: "Welcome — edit or delete me", status: "todo", created: "2026-01-01T00:00:00.000Z" },
      ],
    },
  },

  // Declared operations (operations.json is the mirror an agent keeps in sync;
  // the adapter reads this list for describe + approval).
  //
  // `params` is REQUIRED and typed — the record screen renders it as the
  // operation's signature, so arguments described only in prose can neither be
  // shown nor checked before a call. Declare `{}` for one that takes none.
  //
  // `entity` attaches an operation to a record screen; `appliesWhen` decides
  // whether it is available on a given record, and the adapter derives the
  // "blocked" reason from it. Comparisons only — never a natural-language rule.
  operations: [
    { name: "clear-done", description: "Delete every task whose status is done.", destructive: true, module: "planning", params: {} },
    { name: "count-tasks", description: "Count the tasks.", destructive: false, readOnly: true, idempotent: true, module: "planning", params: {} },
    {
      name: "complete-task",
      description: "Mark one task done.",
      destructive: false,
      module: "planning",
      entity: "tasks",
      appliesWhen: { field: "status", ne: "done" },
      params: { task: { type: "ref", entity: "tasks", required: true } },
    },
    {
      name: "request-triage",
      description: "Ask an agent to work out what this task actually needs.",
      destructive: false,
      module: "planning",
      entity: "tasks",
      appliesWhen: { field: "status", ne: "done" },
      params: { task: { type: "ref", entity: "tasks", required: true } },
    },
  ],

  // The event types this app may emit (the app→agent direction). Declaring a
  // type is what lets `trigger` fire it — an undeclared type is refused — so
  // this list is the fixed set of things the app can ever ask an agent to react
  // to, decided here by its author rather than at the moment of firing.
  //
  // Leave it empty until a feature genuinely needs agent judgment. Plain events
  // want plain code; a task is for work a person would otherwise have to think
  // about.
  events: [{ type: "task.needs_triage" }],

  // Runner signature: (args, ctx, { store, trigger }) => jsonable result. `store` is the
  // SQLite-backed record store — list(entity) · get(entity, id) · put(entity,
  // record) · remove(entity, id). Writes are durable when the call returns;
  // there is no separate persist() step on this stack. `trigger(type, payload,
  // capability?)` emits a declared event (see `request-triage` below).
  operationRunners: {
    "clear-done": (_args, _ctx, { store }) => {
      let removed = 0;
      for (const rec of store.list("tasks")) {
        if (rec.status === "done" && store.remove("tasks", rec.id)) removed++;
      }
      return { removed };
    },
    "count-tasks": (_args, _ctx, { store }) => ({ count: store.list("tasks").length }),
    "complete-task": (args, _ctx, { store }) => {
      const task = store.get("tasks", args?.task);
      if (!task) return { ok: false, reason: "no such task" };
      task.status = "done";
      store.put("tasks", task);
      return { ok: true, task: task.id, status: task.status };
    },
    // The app→agent direction, in full. `trigger` emits a DECLARED event and,
    // because a capability is named, enqueues a task on the app's own queue.
    // From there an agent takes it — either because a harness is polling
    // (`a2app <app> tasks next --wait`) or because `agent-app <app> bridge` is
    // running and triggers one.
    //
    // Send IDS, not prose. The agent re-reads the record itself, so what goes
    // in the payload is what it needs to find the work — never instructions,
    // and never a copy of the data, which would be stale by the time it is
    // read. Nothing here can widen what the agent may do: the payload is data
    // on the other side, and the capability names the kind of work, not a
    // command to run.
    //
    // Identical triggers dedupe to ONE task, even after it has finished, so
    // asking again with the same payload would hand back the old failure.
    // Naming the previous task makes each request a new occurrence. The View
    // disables the control while a run is open, so a double click cannot
    // queue two.
    //
    // The task id goes on the record so the View can show the work until it is
    // done (src/AgentTask.jsx). The validate gate checks that it does.
    "request-triage": (args, _ctx, { store, trigger }) => {
      const task = store.get("tasks", args?.task);
      if (!task) return { ok: false, reason: "no such task" };
      const payload = task.agentTask ? { task: task.id, previous: task.agentTask } : { task: task.id };
      const { taskId } = trigger("task.needs_triage", payload, "triage");
      task.agentTask = taskId;
      store.put("tasks", task);
      return { ok: true, task: task.id, queued: taskId };
    },
  },
};
