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
 * `owner` is whose record it is: operations.js declares `ownedBy: { tasks:
 * "owner" }`, so the adapter fills it with the creator's principal (an account
 * id, or `owner`) and no client can write it.
 *
 * Who may see and change a task are the collection's rules, chosen here by the
 * app's mode (`A2APP_AUTH_MODE`, which pb-serve.mjs sets from manifest.json):
 *
 *   none        one person, the owner: the View and the agent read and write
 *               the same records, so the rules are public ("") and the adapter
 *               decides who gets in.
 *   multi-user  a signed-in person sees and changes their own tasks; an owner
 *               sees and changes everyone's. The adapter makes the caller
 *               `@request.auth` (the person's `users` record; the app's
 *               superuser for the owner's own credential).
 *
 * `created`/`updated` are marked `system`, so the adapter leaves them out of
 * the fields it publishes and a client cannot write them.
 */
migrate(
  (app) => {
    const multiUser = $os.getenv("A2APP_AUTH_MODE") === "multi-user";
    const theirs = '@request.auth.id != "" && (owner = @request.auth.id || @request.auth.role = "owner")';
    const collection = new Collection({
      type: "base",
      name: "tasks",
      listRule: multiUser ? theirs : "",
      viewRule: multiUser ? theirs : "",
      createRule: multiUser ? '@request.auth.id != ""' : "",
      updateRule: multiUser ? theirs : "",
      deleteRule: multiUser ? theirs : "",
      fields: [
        { type: "text", name: "title", required: true, max: 200 },
        { type: "select", name: "status", values: ["todo", "doing", "done"], maxSelect: 1 },
        { type: "text", name: "due", max: 10 },
        { type: "text", name: "notes", max: 2000 },
        { type: "text", name: "agentTask", max: 64 },
        { type: "text", name: "owner", max: 64 },
        { type: "autodate", name: "created", onCreate: true, system: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true, system: true },
      ],
    });
    app.save(collection);

    const welcome = new Record(collection);
    welcome.set("title", "Welcome — edit or delete me");
    welcome.set("status", "todo");
    welcome.set("owner", "owner");
    app.save(welcome);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("tasks"));
  },
);
