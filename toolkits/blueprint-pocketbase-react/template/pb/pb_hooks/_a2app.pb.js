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
 * identity, describe, the record guards, operations, the app→agent task queue
 * and event log, and who may do what (accounts, sessions, credentials, device
 * sign-in) — lives in `_a2app_impl.js`.
 * (`require()` is cached per runtime, so the module loads once per pooled VM.)
 *
 * Runtime: PocketBase JSVM (Goja) on the 0.39 line (pb-serve.mjs pins the
 * binary to v0.39.7). Since 0.27 PocketBase checks a collection's API rules
 * BEFORE the record request hooks below, so the create rule is decided before
 * the guard fills a record's owner. `node --check` validates syntax in the gate;
 * this file only executes inside `pocketbase serve`.
 */

/* -------------------------------------------------------------- bootstrap */

// The adapter's own tables (tasks, events, approval keys, credentials,
// sessions, invites, device requests) in data.db, and the app's .agent-token
// seeded as its admin credential. Idempotent, and after `e.next()` so the
// database is open.
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

/* ------------------------------------- who may do what (spec/v0_2/auth.md) */

routerAdd("GET", "/api/_a2app/whoami", (e) => require(`${__hooks}/_a2app_impl.js`).whoami(e));

// Accounts, sessions and invites (multi-user only; elsewhere 404 not_multi_user).
routerAdd("GET", "/api/_a2app/session", (e) => require(`${__hooks}/_a2app_impl.js`).session(e));
routerAdd("POST", "/api/_a2app/session", (e) => require(`${__hooks}/_a2app_impl.js`).session(e));
routerAdd("DELETE", "/api/_a2app/session", (e) => require(`${__hooks}/_a2app_impl.js`).session(e));
routerAdd("POST", "/api/_a2app/invites", (e) => require(`${__hooks}/_a2app_impl.js`).createInvite(e));
routerAdd("GET", "/api/_a2app/invites/{code}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).invite(e, e.request.pathValue("code")),
);
routerAdd("POST", "/api/_a2app/invites/{code}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).invite(e, e.request.pathValue("code")),
);
routerAdd("GET", "/api/_a2app/users", (e) => require(`${__hooks}/_a2app_impl.js`).users(e, null));
routerAdd("PATCH", "/api/_a2app/users/{id}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).users(e, e.request.pathValue("id")),
);

// Delegated agent credentials.
routerAdd("GET", "/api/_a2app/credentials", (e) => require(`${__hooks}/_a2app_impl.js`).listCredentials(e));
routerAdd("POST", "/api/_a2app/credentials", (e) => require(`${__hooks}/_a2app_impl.js`).issueCredential(e));
routerAdd("DELETE", "/api/_a2app/credentials/{id}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).revokeCredential(e, e.request.pathValue("id")),
);

// Device-code sign-in for agents.
routerAdd("POST", "/api/_a2app/auth/device", (e) => require(`${__hooks}/_a2app_impl.js`).startDevice(e));
routerAdd("GET", "/api/_a2app/auth/device/{code}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).reviewDevice(e, e.request.pathValue("code")),
);
routerAdd("POST", "/api/_a2app/auth/device/{code}", (e) =>
  require(`${__hooks}/_a2app_impl.js`).decideDevice(e, e.request.pathValue("code")),
);
routerAdd("POST", "/api/_a2app/auth/token", (e) => require(`${__hooks}/_a2app_impl.js`).pollDevice(e));

// The framework's account page: sign in, accept an invite, people, the agents
// acting for you, and approving an agent's sign-in.
routerAdd("GET", "/_a2app/account", (e) => require(`${__hooks}/_a2app_impl.js`).accountPage(e));

/* ------------------------------------------- access to PocketBase's own routes */

// PocketBase serves records, realtime, files and batch itself, outside the
// adapter's routes, and decides what each caller sees with collection rules
// evaluated against `e.auth`. This middleware resolves the caller in front of
// them (host, origin, credential or session, scope) and makes it `e.auth`, and
// puts the host/origin half in front of the adapter's own routes (see
// nativeGate in _a2app_impl.js). One middleware covers every one of those
// paths, and unlike the onRecord*Request events it can read the request's Host
// header, which the DNS-rebinding check needs.
routerUse((e) => require(`${__hooks}/_a2app_impl.js`).nativeGate(e));

/* ----------------------------------------------------------------- guard */

// Validate the RAW submitted body before PocketBase coerces it, on both create
// and update, and on create record whose record it is (`ownedBy`). The handler
// stays self-contained: it requires the module and calls its `guard`, which
// either throws an ApiError (rejection) or calls `e.next()`.
onRecordCreateRequest((e) => require(`${__hooks}/_a2app_impl.js`).guard(e));
onRecordUpdateRequest((e) => require(`${__hooks}/_a2app_impl.js`).guard(e));

// Delete was the unhooked one. An app that guards deletion inside an operation
// guards its own UI; the native records route is the other way in, and it went
// straight to the store — so the rule held until an agent took the path it did
// not cover, and the orphan that left was reported as a successful delete.
onRecordDeleteRequest((e) => require(`${__hooks}/_a2app_impl.js`).deleteGuard(e));
