/**
 * The forwarding binding against a fake upstream: what reaches the app, and
 * what the caller is told when it does not.
 *
 * Each declared operation must become exactly the request its mapping states —
 * path segments filled and escaped, the rest as a query string or a JSON body —
 * and nothing of the caller's (its credential above all) may travel with it.
 * Every way the upstream can fail must come back as the adapter's own error
 * envelope, never a 500 with a stack. And the sidecar must enforce the whole
 * 0.2 auth chain in front of an app that has none: approval for destructive
 * operations, the admin credential, delegated credentials held to their
 * scopes, accounts and sign-in on a multi-user app, the person's ceiling.
 *
 * Run: node test/proxy.test.mjs (after tsc)
 */
import { createServer } from "node:http";
import { createReverseProxy } from "../dist/index.js";

const ADMIN = "proxy-test-admin-token";
const HOST = "127.0.0.1:9999";
const ORIGIN = `http://${HOST}`;

const failures = [];
let passed = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

/* ------------------------------------------------------ the fake upstream */

/** Every request the upstream received, as it received it. */
const seen = [];
const notes = new Map([["n1", { id: "n1", text: "first" }]]);
const stalled = new Set();

const upstream = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, "http://upstream");
  seen.push({ method: req.method, url: req.url, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw });
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const one = /^\/notes\/([^/]+)$/.exec(url.pathname);

  if (url.pathname === "/notes" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return send(200, [...notes.values()].filter((n) => n.text.includes(q)));
  }
  if (url.pathname === "/notes" && req.method === "POST") {
    const note = { id: `n${notes.size + 1}`, text: JSON.parse(raw).text };
    notes.set(note.id, note);
    return send(201, note);
  }
  if (one && req.method === "GET") {
    const note = notes.get(decodeURIComponent(one[1]));
    return note ? send(200, note) : send(404, { error: "no such note" });
  }
  if (one && req.method === "DELETE") return send(200, { deleted: notes.delete(decodeURIComponent(one[1])) });
  if (url.pathname.endsWith("/tags") && req.method === "POST") return send(200, { tagged: url.searchParams.getAll("tags") });
  if (url.pathname === "/boom") return send(500, "kaput", "text/plain");
  if (url.pathname === "/secret") return send(401, { error: "who are you" });
  if (url.pathname === "/slow") {
    stalled.add(res); // never answered: the adapter's deadline must fire
    return undefined;
  }
  if (url.pathname === "/huge") return send(200, "x".repeat(6 * 1024 * 1024), "text/plain");
  return send(404, { error: "no such route" });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

/* ------------------------------------------------------------ the adapter */

const string = (required = false) => ({ type: "string", ...(required ? { required: true } : {}) });
const OPERATIONS = [
  { name: "list-notes", module: "notes", destructive: false, readOnly: true, params: { q: string() }, method: "GET", path: "/notes" },
  { name: "add-note", module: "notes", destructive: false, params: { text: string(true) }, method: "POST", path: "/notes" },
  { name: "get-note", module: "notes", destructive: false, readOnly: true, params: { id: string(true) }, method: "GET", path: "/notes/{id}" },
  { name: "delete-note", module: "notes", destructive: true, params: { id: string(true) }, method: "DELETE", path: "/notes/{id}" },
  { name: "tag-note", module: "notes", destructive: false, params: { id: string(true), tags: { type: "json" } }, method: "POST", path: "/notes/{id}/tags", send: "query" },
  { name: "explode", module: "trouble", destructive: false, readOnly: true, params: {}, method: "GET", path: "/boom" },
  { name: "intrude", module: "trouble", destructive: false, readOnly: true, params: {}, method: "GET", path: "/secret" },
  { name: "dawdle", module: "trouble", destructive: false, readOnly: true, params: {}, method: "GET", path: "/slow" },
  { name: "flood", module: "trouble", destructive: false, readOnly: true, params: {}, method: "GET", path: "/huge" },
];
const MODULES = [
  { name: "notes", summary: "the notes the app keeps" },
  { name: "trouble", summary: "routes that fail" },
];

function proxy(authMode, baseUrl = upstreamUrl) {
  return createReverseProxy(
    { appId: `proxy_${authMode.replace("-", "_")}`, appName: "Proxy Test", authMode, upstreamBaseUrl: baseUrl, operations: OPERATIONS, modules: MODULES, timeoutMs: 400 },
    {
      credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
      allowedOrigins: [ORIGIN],
      rateLimits: { data: 0, ops: 0 },
    },
  );
}

function caller(app) {
  return async (method, path, { headers = {}, body } = {}) => {
    const reply = await app.handle({ method, path, query: {}, headers: { host: HOST, ...headers }, ...(body !== undefined ? { body } : {}) });
    return { status: reply.status, json: reply.json, headers: reply.headers ?? {} };
  };
}
const admin = { "x-a2app-token": ADMIN };
const op = (call, name, body, headers = admin) => call("POST", `/api/ops/${name}`, { headers, body });

const single = proxy("none");
const call = caller(single);

try {
  /* ---------------------------------------------------- operate-only shape */

  const identity = await call("GET", "/api/_a2app");
  check("identity names the sidecar adapter and the app's auth mode", [identity.json.adapterVersion, identity.json.authMode], ["0.1.0", "none"]);
  const root = (await call("GET", "/api/_a2app/describe", { headers: admin })).json;
  check("the root lists the modules, with no entities", root.modules.map((m) => [m.name, m.entities, m.operations]), [["notes", 0, 5], ["trouble", 0, 4]]);
  const notesModule = (await call("GET", "/api/_a2app/describe/notes", { headers: admin })).json;
  check("a module lists its operations", notesModule.operations.map((o) => o.name).sort(), ["add-note", "delete-note", "get-note", "list-notes", "tag-note"]);
  check("there are no records to reach", (await call("GET", "/api/collections/notes/records", { headers: admin })).json.code, "unknown_entity");

  /* ------------------------------------------------- what reaches the app */

  const added = await op(call, "add-note", { text: "hello there" }, { ...admin, cookie: "session=abc", authorization: "Bearer caller" });
  check("an operation answers with the app's result", [added.status, added.json.result], [200, { id: "n2", text: "hello there" }]);
  let last = seen.at(-1);
  check("…sent as the mapped request with a JSON body", [last.method, last.url, last.headers["content-type"], JSON.parse(last.body)], ["POST", "/notes", "application/json", { text: "hello there" }]);
  ok("…carrying none of the caller's credentials", !("x-a2app-token" in last.headers) && !("cookie" in last.headers) && !("authorization" in last.headers));

  const listed = await op(call, "list-notes", { q: "hello there" });
  last = seen.at(-1);
  check("a GET sends its args as the query string", [last.method, last.url, last.body], ["GET", "/notes?q=hello+there", ""]);
  check("…and returns the app's answer", listed.json.result, [{ id: "n2", text: "hello there" }]);

  await op(call, "get-note", { id: "a b/c" });
  check("a path parameter fills its segment, escaped", seen.at(-1).url, "/notes/a%20b%2Fc");
  const tagged = await op(call, "tag-note", { id: "n1", tags: ["red", "blue"] });
  last = seen.at(-1);
  check("send: query puts the rest on the query string, a list as repeated keys", [last.url, last.body, tagged.json.result], ["/notes/n1/tags?tags=red&tags=blue", "", { tagged: ["red", "blue"] }]);

  let before = seen.length;
  const dotted = await op(call, "get-note", { id: ".." });
  check("a dot segment, which would reach another route, is refused", [dotted.status, dotted.json.code, dotted.json.field], [400, "invalid_argument", "id"]);
  check("…before anything reaches the app", seen.length, before);

  before = seen.length;
  const missing = await op(call, "add-note", {});
  check("args are guarded before the app is called", [missing.status, missing.json.code], [400, "missing_required"]);
  check("…so nothing reached it", seen.length, before);

  /* ------------------------------------------- destructive needs approval */

  before = seen.length;
  const asked = await op(call, "delete-note", { id: "n1" });
  check("a destructive operation needs approval first", [asked.status, asked.json.code], [428, "approval_required"]);
  check("…and nothing reached the app", seen.length, before);
  const approved = await op(call, "delete-note", { id: "n1" }, { ...admin, "x-a2app-approval": asked.json.approvalKey });
  check("with the approval key it runs", [approved.status, approved.json.result], [200, { deleted: true }]);
  check("…as a DELETE on the note", [seen.at(-1).method, seen.at(-1).url], ["DELETE", "/notes/n1"]);
  const replayed = await op(call, "delete-note", { id: "n1" }, { ...admin, "x-a2app-approval": asked.json.approvalKey });
  check("an approval key is spent once", replayed.status, 428);

  /* ------------------------------------------------ unknown and failures */

  check("an unknown operation is the adapter's 404", [(await op(call, "no-such-op", {})).status, (await op(call, "no-such-op", {})).json.code], [404, "unknown_operation"]);

  const notFound = await op(call, "get-note", { id: "n99" });
  check("an app 4xx is relayed with its status", [notFound.status, notFound.json.code, notFound.json.upstreamStatus, notFound.json.upstream], [404, "upstream_error", 404, { error: "no such note" }]);
  const exploded = await op(call, "explode", {});
  check("an app 5xx is a gateway error, carrying what the app said", [exploded.status, exploded.json.code, exploded.json.upstreamStatus, exploded.json.upstream], [502, "upstream_error", 500, "kaput"]);
  const intruded = await op(call, "intrude", {});
  check("an app 401 is a gateway error, not the caller's credential problem", [intruded.status, intruded.json.upstreamStatus], [502, 401]);
  const dawdled = await op(call, "dawdle", {});
  check("an app that does not answer in time", [dawdled.status, dawdled.json.code], [504, "upstream_timeout"]);
  const flooded = await op(call, "flood", {});
  check("an answer past the cap is refused, not buffered", [flooded.status, flooded.json.code, flooded.json.limitBytes], [502, "upstream_response_too_large", 5 * 1024 * 1024]);

  const closed = createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const down = await op(caller(proxy("none", `http://127.0.0.1:${deadPort}`)), "list-notes", {});
  check("an app that is down is a clean envelope", [down.status, down.json.a2app, down.json.ok, down.json.code], [503, true, false, "upstream_unavailable"]);
  ok("…saying why", /not answering \(ECONNREFUSED\)/.test(down.json.message));

  /* ------------------------------------------------- auth, single-user */

  check("an anonymous program may run a read-only operation on a single-user app", (await op(call, "list-notes", {}, {})).status, 200);
  check("…but not one that changes anything", [(await op(call, "add-note", { text: "x" }, {})).status, (await op(call, "add-note", { text: "x" }, {})).json.code], [401, "agent_token_required"]);
  check("a write from a foreign origin is refused", (await op(call, "add-note", { text: "x" }, { ...admin, origin: "http://evil.example" })).json.code, "forbidden_origin");
  check("the app answers only on its own host", (await single.handle({ method: "GET", path: "/api/_a2app", query: {}, headers: { host: "evil.example" } })).json.code, "forbidden_host");

  const issued = await call("POST", "/api/_a2app/credentials", { headers: admin, body: { agentName: "notes reader", scopes: ["op:list-notes"] } });
  check("the admin credential issues a delegated one", issued.status, 201);
  const reader = { "x-a2app-token": issued.json.token };
  check("…which runs what its scopes hold", (await op(call, "list-notes", {}, reader)).status, 200);
  check("…and nothing else", (await op(call, "add-note", { text: "x" }, reader)).json.code, "insufficient_scope");
  check("…which whoami reports", (await call("GET", "/api/_a2app/whoami", { headers: reader })).json.scopes, ["op:list-notes"]);

  /* -------------------------------------------------- auth, multi-user */

  const multi = proxy("multi-user");
  const mcall = caller(multi);
  check("a multi-user sidecar says so", (await mcall("GET", "/api/_a2app")).json.authMode, "multi-user");
  check("…and serves nothing to a stranger", (await op(mcall, "list-notes", {}, {})).json.code, "agent_token_required");
  check("…telling a page to sign in", (await mcall("GET", "/api/_a2app/session", { headers: { origin: ORIGIN } })).json.code, "sign_in_required");

  const invite = (await mcall("POST", "/api/_a2app/invites", { headers: admin, body: { role: "member" } })).json;
  const signup = await mcall("POST", `/api/_a2app/invites/${invite.code}`, { headers: { origin: ORIGIN }, body: { name: "Bea", login: "bea", password: "a long enough password" } });
  check("a person joins by invite", signup.status, 201);
  const bea = { origin: ORIGIN, cookie: signup.headers["set-cookie"].split(";")[0] };
  check("…and, signed in, runs an operation from the app's own page", (await op(mcall, "add-note", { text: "from bea" }, bea)).status, 200);

  const delegated = await mcall("POST", "/api/_a2app/credentials", { headers: bea, body: { agentName: "bea's agent", scopes: ["op:add-note"] } });
  check("she issues her agent a credential", [delegated.status, delegated.json.credential.principal], [201, signup.json.id]);
  const agent = { "x-a2app-token": delegated.json.token };
  check("…that acts for her within its scopes", (await op(mcall, "add-note", { text: "by the agent" }, agent)).status, 200);
  check("…and no further", (await op(mcall, "list-notes", {}, agent)).json.code, "insufficient_scope");
  await mcall("PATCH", `/api/_a2app/users/${signup.json.id}`, { headers: admin, body: { active: false } });
  check("once she is deactivated, her agent can do nothing (the ceiling)", (await op(mcall, "add-note", { text: "x" }, agent)).json.code, "principal_inactive");
} finally {
  for (const res of stalled) res.destroy();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
}

if (failures.length) {
  console.log(`reverse-proxy: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log(`reverse-proxy: all ${passed} checks passed`);
