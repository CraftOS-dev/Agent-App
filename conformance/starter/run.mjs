#!/usr/bin/env node
/**
 * Starter conformance: the protocol behaviours every starter's adapter shares
 * with the reference (adapter-core), checked from outside against a running
 * starter on any stack, in either auth mode, with its admin credential.
 *
 *   node conformance/starter/run.mjs --base http://127.0.0.1:8091 --token <.agent-token>
 *
 * It relies only on HTTP and the starters' shared model: the `tasks` entity
 * (`title` required, at most 200 characters) in module `planning`, and the
 * operations `clear-done` (destructive), `count-tasks` and `request-triage
 * { task }`. It writes a few records and queues one task, so run it against a
 * scratch app. Behaviour across a restart (persisted tasks, events and
 * approvals) is not visible from here; each stack's own tests cover it.
 */
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const base = (arg("base") ?? "").replace(/\/+$/, "");
const admin = arg("token");
if (!base || !admin) {
  console.error("usage: run.mjs --base <app URL> --token <admin credential>");
  process.exit(2);
}

const failures = [];
let passed = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

async function call(method, path, { body, headers = {}, raw } = {}) {
  const h = { "content-type": "application/json", "x-a2app-token": admin, ...headers };
  const res = await fetch(base + path, { method, headers: h, ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}
const code = (r) => r.json?.code ?? null;

/** Status and code for a GET naming a foreign Host (fetch cannot set Host). */
const foreignHost = (path) =>
  new Promise((done) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, path, headers: { host: "evil.example" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        let c = null;
        try {
          c = JSON.parse(body).code ?? null;
        } catch {
          /* not JSON */
        }
        done([res.statusCode, c]);
      });
    });
    req.on("error", () => done([0, null]));
    req.end();
  });

/** RFC 8785 canonical JSON, enough for plain objects, arrays, strings, numbers. */
function jcs(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
}
const run = randomBytes(3).toString("hex");

/* -------------------------------------------------------- identity, Host */

const identity = (await call("GET", "/api/_a2app")).json;
const appId = identity?.app?.id;
check("identity: protocol 0.2", identity?.protocol, "0.2");
ok("identity publishes dataVersion", typeof identity?.dataVersion === "string");
for (const path of ["/", "/api/_a2app", "/_a2app/account", "/no-such-page"]) {
  check(`a foreign Host is refused on ${path}`, await foreignHost(path), [403, "forbidden_host"]);
}
const viewers = await call("GET", "/api/_a2app/viewers");
ok("the viewers count is served", viewers.status === 200 && typeof viewers.json?.viewers === "number" && typeof viewers.json?.ttlMs === "number");

/* -------------------------------------------------------- records: guard */

const created = await call("POST", "/api/collections/tasks/records", { body: { title: `Parity ${run}` } });
ok("a record is created", created.status < 300 && typeof created.json?.id === "string");
ok("…and dataVersion moves", (await call("GET", "/api/_a2app")).json?.dataVersion !== identity?.dataVersion);
check("a required field left out is missing_required", code(await call("POST", "/api/collections/tasks/records", { body: {} })), "missing_required");
check("…and blanked on update too", code(await call("PATCH", `/api/collections/tasks/records/${created.json?.id}`, { body: { title: "" } })), "missing_required");
check("text past its max is refused", (await call("POST", "/api/collections/tasks/records", { body: { title: "x".repeat(201) } })).status, 400);
check("an undeclared field is unknown_field", code(await call("POST", "/api/collections/tasks/records", { body: { title: "t", nope: 1 } })), "unknown_field");
check("a body that is not an object is refused", (await call("POST", "/api/collections/tasks/records", { raw: "[]" })).status, 400);

/* ---------------------------------------------------- records: idempotency */

const key = `idem-${run}`;
await call("POST", "/api/collections/tasks/records", { body: { title: `Idem ${run}` }, headers: { "idempotency-key": key } });
check("a repeated create is duplicate_request", code(await call("POST", "/api/collections/tasks/records", { body: { title: `Idem ${run}` }, headers: { "idempotency-key": key } })), "duplicate_request");
await call("PATCH", `/api/collections/tasks/records/${created.json?.id}`, { body: { title: `Patched ${run}` }, headers: { "idempotency-key": `${key}-p` } });
check("…and so is a repeated update", code(await call("PATCH", `/api/collections/tasks/records/${created.json?.id}`, { body: { title: `Patched ${run}` }, headers: { "idempotency-key": `${key}-p` } })), "duplicate_request");

/* ------------------------------------------------------- records: reading */

const badFilter = await call("GET", `/api/collections/tasks/records?filter=${encodeURIComponent("title ~~ 'x'")}`);
ok("a filter it cannot honour is invalid_filter, naming it", code(badFilter) === "invalid_filter" && typeof badFilter.json?.got === "string");
check("an escaped id is decoded, then not found", code(await call("GET", "/api/collections/tasks/records/no%20such")), "record_not_found");

/* ----------------------------------------------------------- operations */

check("an escaped operation name is decoded", (await call("POST", "/api/ops/count%2Dtasks", { body: {} })).status, 200);
check("a required parameter is enforced", (await call("POST", "/api/ops/request-triage", { body: {} })).status, 400);
check("an undeclared parameter is refused", (await call("POST", "/api/ops/request-triage", { body: { task: created.json?.id, extra: 1 } })).status, 400);
const asked = await call("POST", "/api/ops/clear-done", { body: {} });
check("a destructive operation asks for approval", [asked.status, code(asked)], [428, "approval_required"]);
check("…with the reference's approval key (sha256 of the JCS call)", asked.json?.approvalKey, createHash("sha256").update(jcs({ operation: "clear-done", args: {} })).digest("hex"));
check("…which then runs it", (await call("POST", "/api/ops/clear-done", { body: {}, headers: { "x-a2app-approval": asked.json?.approvalKey } })).status, 200);
const opKey = `op-${run}`;
await call("POST", "/api/ops/count-tasks", { body: {}, headers: { "idempotency-key": opKey } });
check("a repeated operation is duplicate_request", code(await call("POST", "/api/ops/count-tasks", { body: {}, headers: { "idempotency-key": opKey } })), "duplicate_request");

/* --------------------------------------------------------------- describe */

const record = (await call("GET", `/api/_a2app/describe/planning/tasks/${created.json?.id}`)).json;
const triage = (record?.operations ?? []).find((o) => o.name === "request-triage");
check("a record's operations name the parameter that takes the record", triage?.targetParam, "task");

/* ------------------------------------------------------------ tasks, events */

const queued = (await call("POST", "/api/ops/request-triage", { body: { task: created.json?.id } })).json;
const taskId = queued?.queued ?? queued?.result?.queued;
const task = (await call("GET", `/api/_a2app/tasks/${taskId}`)).json;
check("a task names its app", task?.app, appId);
check("…and starts with no progress", task?.progress, { step: null, percent: 0 });
check("claiming as someone else is principal_mismatch", code(await call("POST", `/api/_a2app/tasks/${taskId}/claim`, { body: { agent: "someone-else" } })), "principal_mismatch");
await call("POST", `/api/_a2app/tasks/${taskId}/claim`, { body: {} });
await call("POST", `/api/_a2app/tasks/${taskId}/complete`, { body: { status: "completed", result: {} } });
check("a finished task cannot be canceled", code(await call("POST", `/api/_a2app/tasks/${taskId}/cancel`, { body: {} })), "task_not_claimable");
const events = (await call("GET", "/api/_a2app/events")).json?.events ?? [];
ok("events name their app", events.length > 0 && events.every((e) => e.app === appId));
const fromStart = (await call("GET", "/api/_a2app/events")).json;
const fromJunk = (await call("GET", "/api/_a2app/events?since=abc")).json;
check("a cursor that is not one reads from the beginning", [fromJunk?.events?.length, fromJunk?.nextCursor], [fromStart?.events?.length, fromStart?.nextCursor]);

/* -------------------------------------------------------------- report */

if (failures.length > 0) {
  console.log(`starter conformance against ${base}: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log(`starter conformance against ${base}: all ${passed} checks passed`);
