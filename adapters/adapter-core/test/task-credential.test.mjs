/**
 * Task credentials (spec/v0_2/auth.md §6): a task records who queued it, and the
 * credential its agent runs with acts as that person, holds only what the
 * capability needs, and stops working when the task ends.
 */
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const ORIGIN = "http://127.0.0.1:9953";
const ADMIN = "admin-token-tasks";
const binding = () =>
  new MemoryBinding({
    appId: "taskcred",
    appName: "Task Credentials",
    authMode: "multi-user",
    entities: {
      notes: {
        module: "desk",
        ownedBy: "owner",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "owner", type: "string", readOnly: true },
        ],
        seed: [],
      },
    },
  });
const config = (capabilities) => ({
  modules: [{ name: "desk" }],
  allowedOrigins: [ORIGIN],
  events: [{ type: "note.ask" }],
  capabilities,
  credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
});

const app = createA2App(binding(), config({ summarize: { scopes: ["data:notes:read"] } }));
const call = (method, path, headers = {}, body) => app.handle({ method, path, query: {}, headers, body });
const as = (token) => ({ "x-a2app-token": token });

async function account(name, role) {
  const invite = (await call("POST", "/api/_a2app/invites", as(ADMIN), { role })).json;
  const accepted = await call("POST", `/api/_a2app/invites/${invite.code}`, { origin: ORIGIN }, { name, login: name.toLowerCase(), password: "a long enough password" });
  return { id: accepted.json.id, session: { origin: ORIGIN, cookie: accepted.headers["set-cookie"].split(";")[0] } };
}
const alice = await account("Alice", "owner");
const bob = await account("Bob", "member");
await call("POST", "/api/collections/notes/records", alice.session, { title: "Alice's note" });
await call("POST", "/api/collections/notes/records", bob.session, { title: "Bob's note" });

/* ------------------------------------------------------ who queued it */

const asked = app.trigger({ type: "note.ask", payload: { note: "n1" }, capability: "summarize", principal: bob.id });
check("a task records who queued it", (await call("GET", `/api/_a2app/tasks/${asked.taskId}`, as(ADMIN))).json.request.principal, bob.id);
const own = app.trigger({ type: "note.ask", payload: { note: "n1" }, capability: "digest" });
check("work the app queues on its own has no principal", (await call("GET", `/api/_a2app/tasks/${own.taskId}`, as(ADMIN))).json.request.principal, null);
check("the same request from the same person is one task", app.trigger({ type: "note.ask", payload: { note: "n1" }, capability: "summarize", principal: bob.id }).taskId, asked.taskId);
ok("…and from someone else, another", app.trigger({ type: "note.ask", payload: { note: "n1" }, capability: "summarize", principal: alice.id }).taskId !== asked.taskId);

/* ------------------------------------------------ the task credential */

const before = Date.now();
const issued = await call("POST", `/api/_a2app/tasks/${asked.taskId}/credential`, as(ADMIN), { agentName: "bridge:claude" });
check("the admin credential issues a task's credential", issued.status, 201);
const cred = issued.json.credential;
check("…acting for the person who queued it", [cred.principal, cred.principalName], [bob.id, "Bob"]);
check("…holding what the capability needs", cred.scopes, ["data:notes:read"]);
check("…bound to the task", cred.task, asked.taskId);
ok("…for an hour at most", Date.parse(cred.expiresAt) <= before + 3_600_000 + 1_000);
const task = issued.json.token;

const who = (await call("GET", "/api/_a2app/whoami", as(task))).json;
check("the agent acts as that person", [who.principal, who.scopes], [bob.id, ["data:notes:read"]]);
check("…sees only what that person sees", (await call("GET", "/api/collections/notes/records", as(task))).json.items.map((n) => n.title), ["Bob's note"]);
check("…and cannot write beyond the capability", (await call("POST", "/api/collections/notes/records", as(task), { title: "x" })).json.code, "insufficient_scope");

check("an app-queued task's credential acts as the owner", (await call("POST", `/api/_a2app/tasks/${own.taskId}/credential`, as(ADMIN))).json.credential.principal, "owner");
check("…with every scope when the capability declares none", (await call("POST", `/api/_a2app/tasks/${own.taskId}/credential`, as(ADMIN))).json.credential.scopes, ["*"]);

check("a member cannot issue one", (await call("POST", `/api/_a2app/tasks/${asked.taskId}/credential`, bob.session)).json.code, "not_a_manager");
check("nor can an agent's credential, even the task's own", (await call("POST", `/api/_a2app/tasks/${asked.taskId}/credential`, as(task))).json.code, "not_a_manager");

/* ------------------------------------------------ dies with the task */

check("the bridge claims the task", (await call("POST", `/api/_a2app/tasks/${asked.taskId}/claim`, as(ADMIN))).status, 200);
check("the agent reports progress with its task credential", (await call("POST", `/api/_a2app/tasks/${asked.taskId}/progress`, as(task), { step: "reading" })).status, 200);
check("…and completes the task", (await call("POST", `/api/_a2app/tasks/${asked.taskId}/complete`, as(task), { status: "completed", result: {} })).status, 200);
check("then its credential is refused", (await call("GET", "/api/_a2app/whoami", as(task))).json.code, "credential_revoked");
check("…and none is issued for a finished task", (await call("POST", `/api/_a2app/tasks/${asked.taskId}/credential`, as(ADMIN))).json.code, "task_not_claimable");
ok("…nor is it listed any more", !(await call("GET", "/api/_a2app/credentials", as(ADMIN))).json.credentials.some((c) => c.credentialId === cred.credentialId));

/* --------------------------------------------- who reaches a task (§6.3) */

// A task holds who asked and what was asked and answered, so it is reached like
// a record: an owner every task, a task credential its own, anyone else theirs.
const carol = await account("Carol", "member");
const bobs = app.trigger({ type: "note.ask", payload: { note: "b" }, capability: "summarize", principal: bob.id });
const carols = app.trigger({ type: "note.ask", payload: { note: "c" }, capability: "summarize", principal: carol.id });
const listed = async (headers) => (await call("GET", "/api/_a2app/tasks", headers)).json.tasks.map((t) => t.id);

const byAlice = await listed(alice.session);
const byBob = await listed(bob.session);
ok("an owner lists every task", [bobs.taskId, carols.taskId, own.taskId].every((id) => byAlice.includes(id)));
check("a member lists only the tasks they asked for", byBob.filter((id) => [bobs.taskId, carols.taskId, own.taskId].includes(id)), [bobs.taskId]);
check("…another's answers as one that does not exist", (await call("GET", `/api/_a2app/tasks/${carols.taskId}`, bob.session)).json.code, "task_not_found");
check("…and cannot cancel it", (await call("POST", `/api/_a2app/tasks/${carols.taskId}/cancel`, bob.session)).json.code, "task_not_found");
check("…nor claim it", (await call("POST", `/api/_a2app/tasks/${carols.taskId}/claim`, bob.session)).json.code, "task_not_found");
check("…while their own task is theirs to read", (await call("GET", `/api/_a2app/tasks/${bobs.taskId}`, bob.session)).status, 200);

check("the bridge claims Carol's task", (await call("POST", `/api/_a2app/tasks/${carols.taskId}/claim`, as(ADMIN))).status, 200);
const run = (await call("POST", `/api/_a2app/tasks/${carols.taskId}/credential`, as(ADMIN))).json.token;
check("a task credential reaches its own task", (await call("GET", `/api/_a2app/tasks/${carols.taskId}`, as(run))).status, 200);
check("…and no other", (await call("GET", `/api/_a2app/tasks/${bobs.taskId}`, as(run))).json.code, "task_not_found");
check("…nor lists any other", await listed(as(run)), [carols.taskId]);
check("the person who asked cannot report on a run they do not hold", (await call("POST", `/api/_a2app/tasks/${carols.taskId}/complete`, carol.session, { status: "completed", result: {} })).json.code, "task_not_held");
check("…but can cancel it", (await call("POST", `/api/_a2app/tasks/${carols.taskId}/cancel`, carol.session)).status, 200);

check("a member who claims their own task holds it", (await call("POST", `/api/_a2app/tasks/${bobs.taskId}/claim`, bob.session)).status, 200);
check("…and reports on it", (await call("POST", `/api/_a2app/tasks/${bobs.taskId}/complete`, bob.session, { status: "completed", result: { summary: "done" } })).status, 200);
const again = app.trigger({ type: "note.ask", payload: { note: "b" }, capability: "summarize", principal: bob.id });
ok("once a task is finished, the same request queues a new one", again.taskId !== bobs.taskId);
check("…which waits to be taken", (await call("GET", `/api/_a2app/tasks/${again.taskId}`, bob.session)).json.status, "submitted");

const later = app.trigger({ type: "note.ask", payload: { note: "n2" }, capability: "summarize", principal: bob.id });
await call("PATCH", `/api/_a2app/users/${bob.id}`, as(ADMIN), { active: false });
check("no credential for a task whose person is no longer active", (await call("POST", `/api/_a2app/tasks/${later.taskId}/credential`, as(ADMIN))).json.code, "principal_inactive");

/* ------------------------------------------------------- declarations */

let refused = null;
try {
  createA2App(binding(), config({ summarize: { scopes: ["data:notez:read"] } }));
} catch (e) {
  refused = e.message;
}
ok("a capability needing an undeclared scope is refused at boot", refused !== null && refused.includes("data:notez:read"));

if (failures.length) {
  console.log(`task credentials: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("task credentials: all checks passed");
