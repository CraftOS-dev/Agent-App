/// <reference path="../pb_data/types.d.ts" />
/**
 * The starter's `tasks` collection (AGENT-OWNED — the first link in YOUR
 * migration chain).
 *
 * Applied once per database: the first live boot, and every fresh dev boot,
 * which replays the whole chain from empty. Once it has run anywhere, NEVER edit,
 * rename or delete this file — PocketBase knows a migration by its filename and
 * would try to apply the "new" one over the existing collection. Change the
 * collection with a NEW migration file.
 *
 * `agentTask` holds the queue task an agent is (or was last) working on for
 * this record. The `request-triage` runner (pb/pb_hooks/operations.js) sets it;
 * the View follows it, so the person can see the work they asked for until it
 * is done. operations.js declares it read-only, so no client can overwrite it.
 *
 * `created`/`updated` are marked `system`, so the adapter leaves them out of
 * the fields it publishes and a client cannot write them.
 */
migrate(
  (app) => {
    const collection = new Collection({
      type: "base",
      name: "tasks",
      // Single-user app: the View and the agent read and write the same records.
      // A multi-user app replaces these with real rules.
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        { type: "text", name: "title", required: true, max: 200 },
        { type: "select", name: "status", values: ["todo", "doing", "done"], maxSelect: 1 },
        { type: "text", name: "due", max: 10 },
        { type: "text", name: "notes", max: 2000 },
        { type: "text", name: "agentTask", max: 64 },
        { type: "autodate", name: "created", onCreate: true, system: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true, system: true },
      ],
    });
    app.save(collection);

    const welcome = new Record(collection);
    welcome.set("title", "Welcome — edit or delete me");
    welcome.set("status", "todo");
    app.save(welcome);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("tasks"));
  },
);
