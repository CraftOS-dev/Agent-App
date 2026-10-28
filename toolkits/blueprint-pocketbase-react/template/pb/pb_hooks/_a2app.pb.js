/// <reference path="../pb_data/types.d.ts" />
/**
 * A2App adapter — PocketBase hook REGISTRATIONS (SYSTEM-OWNED — hash-locked).
 *
 * PocketBase serializes each hook handler and runs it in an ISOLATED runtime, so
 * a handler cannot reference anything declared at this file's scope — a bare
 * `(e) => a2appDescribe(e)` throws `ReferenceError: a2appDescribe is not defined`.
 * The only things a handler may use are the PocketBase globals and `require()`.
 * So every handler below is a self-contained one-liner that `require()`s the
 * implementation module INSIDE its own body and calls into it; all the logic —
 * identity, describe, the record guards, operations, and the app→agent task
 * queue and event log — lives in `_a2app_impl.js`.
 * (`require()` is cached per runtime, so the module loads once per pooled VM.)
 *
 * Runtime: PocketBase JSVM (Goja) on the 0.23+ hook API (binary pinned to
 * v0.26.x). `node --check` validates syntax in the gate; this file only executes
 * inside `pocketbase serve`.
 */

/* -------------------------------------------------------------- bootstrap */

// The queue's own tables (tasks, events, approval keys) in data.db. Idempotent,
// and after `e.next()` so the database is open.
onBootstrap((e) => {
  e.next();
  require(`${__hooks}/_a2app_impl.js`).ensureStore(e.app);
});

/* --------------------------------------------------------------- identity */

routerAdd("GET", "/api/_a2app", (e) => require(`${__hooks}/_a2app_impl.js`).identity(e));

/* --------------------------------------------------------------- describe */

routerAdd("GET", "/api/_a2app/describe", (e) => require(`${__hooks}/_a2app_impl.js`).describe(e, []));
routerAdd("GET", "/api/_a2app/describe/{p1}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).describe(e, [e.request.pathValue("p1")]),
);
routerAdd("GET", "/api/_a2app/describe/{p1}/{p2}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).describe(e, [e.request.pathValue("p1"), e.request.pathValue("p2")]),
);
routerAdd("GET", "/api/_a2app/describe/{p1}/{p2}/{p3}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).describe(e, [
    e.request.pathValue("p1"),
    e.request.pathValue("p2"),
    e.request.pathValue("p3"),
  ]),
);
routerAdd("GET", "/api/_a2app/describe/{p1}/{p2}/{p3}/{p4}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).describe(e, [
    e.request.pathValue("p1"),
    e.request.pathValue("p2"),
    e.request.pathValue("p3"),
    e.request.pathValue("p4"),
  ]),
);

/* ------------------------------------------------------------ operations */

// A declared operation (operations.json), run by the app's own runner in
// pb/pb_hooks/operations.js. Destructive ones answer 428 + an approval key first.
routerAdd("POST", "/api/ops/{name}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).runOperation(e, e.request.pathValue("name")),
);
routerAdd("GET", "/api/ops/{name}", (e) => require(`${__hooks}/_a2app_impl.js`).operationMethod(e));

/* --------------------------------------------------- app→agent: tasks, events */

routerAdd("GET", "/api/_a2app/tasks", (e) => require(`${__hooks}/_a2app_impl.js`).listTasks(e));
routerAdd("GET", "/api/_a2app/tasks/{id}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).getTask(e, e.request.pathValue("id")),
);
routerAdd("POST", "/api/_a2app/tasks/{id}/{action}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).taskAction(e, e.request.pathValue("id"), e.request.pathValue("action")),
);
routerAdd("GET", "/api/_a2app/events", (e) => require(`${__hooks}/_a2app_impl.js`).listEvents(e));
routerAdd("GET", "/api/_a2app/context", (e) => require(`${__hooks}/_a2app_impl.js`).context(e));

/* ----------------------------------------------------------------- guard */

// Validate the RAW submitted body before PocketBase coerces it, on both create
// and update. The handler stays self-contained: it requires the module and calls
// its `guard`, which either throws an ApiError (rejection) or calls `e.next()`.
onRecordCreateRequest((e) => require(`${__hooks}/_a2app_impl.js`).guard(e));
onRecordUpdateRequest((e) => require(`${__hooks}/_a2app_impl.js`).guard(e));

// Delete was the unhooked one. An app that guards deletion inside an operation
// guards its own UI; the native records route is the other way in, and it went
// straight to the store — so the rule held until an agent took the path it did
// not cover, and the orphan that left was reported as a successful delete.
onRecordDeleteRequest((e) => require(`${__hooks}/_a2app_impl.js`).deleteGuard(e));
