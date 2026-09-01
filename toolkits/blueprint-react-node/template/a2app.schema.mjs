/**
 * The app's data model + operations (AGENT-OWNED — edit this to evolve the app).
 *
 * `fields` are declared in the A2App protocol type vocabulary (string · number ·
 * boolean · datetime · enum · ref · list<enum> · list<ref> · json · binary).
 * `describe` and `schemaVersion` are DERIVED from this, so an agent always sees
 * the live model — you never hand-write describe.
 *
 * This starter models a to-do list. Replace it with your own entities.
 */
export const schema = {
  entities: {
    tasks: {
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

  // Declared operations (operations.json is the framework-file mirror an agent
  // keeps in sync; the adapter reads this list for describe + approval).
  operations: [
    { name: "clear-done", description: "Delete every task whose status is done.", destructive: true },
    { name: "count-tasks", description: "Count the tasks.", destructive: false, readOnly: true, idempotent: true },
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
  },
};
