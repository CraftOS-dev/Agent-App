/**
 * The app's data model + operations (AGENT-OWNED — edit this to evolve the app).
 *
 * `fields` are declared in the A2App protocol type vocabulary (string · number ·
 * boolean · datetime · enum · ref · list<enum> · list<ref> · json · binary).
 * `describe` and `schemaVersion` are DERIVED from this, so an agent always sees
 * the live model — you never hand-write describe.
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
  ],

  operationRunners: {
    "clear-done": (_args, _ctx, { db, persist }) => {
      let removed = 0;
      for (const [id, rec] of Object.entries(db.tasks ?? {})) {
        if (rec.status === "done") {
          delete db.tasks[id];
          removed++;
        }
      }
      persist();
      return { removed };
    },
    "count-tasks": (_args, _ctx, { db }) => ({ count: Object.keys(db.tasks ?? {}).length }),
    "complete-task": (args, _ctx, { db, persist }) => {
      const task = db.tasks?.[args?.task];
      if (!task) return { ok: false, reason: "no such task" };
      task.status = "done";
      persist();
      return { ok: true, task: task.id, status: task.status };
    },
  },
};
