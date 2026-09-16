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
 * identity, describe, and the create/update guard — lives in `_a2app_impl.js`.
 * (`require()` is cached per runtime, so the module loads once per pooled VM.)
 *
 * Runtime: PocketBase JSVM (Goja) on the 0.23+ hook API (binary pinned to
 * v0.26.x). `node --check` validates syntax in the gate; this file only executes
 * inside `pocketbase serve`.
 */

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

/* ----------------------------------------------------------------- guard */

// Validate the RAW submitted body before PocketBase coerces it, on both create
// and update. The handler stays self-contained: it requires the module and calls
// its `guard`, which either throws an ApiError (rejection) or calls `e.next()`.
onRecordCreateRequest((e) => require(`${__hooks}/_a2app_impl.js`).guard(e));
onRecordUpdateRequest((e) => require(`${__hooks}/_a2app_impl.js`).guard(e));
