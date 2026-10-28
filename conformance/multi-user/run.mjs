#!/usr/bin/env node
/**
 * Multi-user conformance (spec/v0_2/auth.md), black-box: run against any
 * starter served fresh as `authMode: multi-user`, on any stack.
 *
 *   node conformance/multi-user/run.mjs --base http://127.0.0.1:8091 --token <.agent-token>
 *
 * It needs only HTTP, the app's admin credential, and the starters' shared
 * model: an entity `tasks` (string field `title`, owned by its creator) and an
 * operation `request-triage { task }` whose runner queues a task. Logins are
 * unique per run, so it can be run more than once against one app.
 */
import { randomBytes } from "node:crypto";
import { request } from "node:http";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const base = (arg("base") ?? "").replace(/\/+$/, "");
const admin = arg("token");
const entity = arg("entity", "tasks");
const op = arg("op", "request-triage");
if (!base || !admin) {
  console.error("usage: run.mjs --base <app URL> --token <admin credential> [--entity tasks] [--op request-triage]");
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

/** One request. `as` is a token, a session cookie `{ cookie }`, or nothing. */
async function call(method, path, { as, body, origin = true, headers = {} } = {}) {
  const h = { "content-type": "application/json", ...headers };
  if (typeof as === "string") h["x-a2app-token"] = as;
  else if (as?.cookie) h.cookie = as.cookie;
  if (origin && as?.cookie) h.origin = base;
  const res = await fetch(base + path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: the account page */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const code = (r) => r.json?.code ?? null;
/** The refusal code for a request naming another Host (fetch cannot set one). */
const foreignHost = () =>
  new Promise((done) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, path: "/api/_a2app/whoami", headers: { host: "evil.example", "x-a2app-token": admin } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          done(JSON.parse(body).code ?? null);
        } catch {
          done(null);
        }
      });
    });
    req.on("error", () => done(null));
    req.end();
  });
const items = (r) => r.json?.items ?? [];
const cookieOf = (r) => r.headers.get("set-cookie")?.split(";")[0] ?? null;

const run = randomBytes(3).toString("hex");
const password = "a long enough password";

/* -------------------------------------------------------------- identity */

const identity = await call("GET", "/api/_a2app");
check("identity: protocol 0.2", identity.json?.protocol, "0.2");
const page = await call("GET", "/_a2app/account");
ok("the account page is served", page.status === 200 && (page.headers.get("content-type") ?? "").startsWith("text/html"));
check("a foreign Host is refused", await foreignHost(), "forbidden_host");

/* ------------------------------------------------- nobody without sign-in */

check("a stranger cannot read records", (await call("GET", `/api/collections/${entity}/records`)).status, 401);
check("a stranger is asked to sign in", code(await call("GET", "/api/_a2app/session")), "sign_in_required");
const adminWho = (await call("GET", "/api/_a2app/whoami", { as: admin })).json;
check("the admin credential acts as the owner", [adminWho?.principal, adminWho?.role], ["owner", "owner"]);

/* ---------------------------------------------------- invites and sign-in */

async function join(role, name) {
  const invite = await call("POST", "/api/_a2app/invites", { as: admin, body: { role } });
  const login = `${name.toLowerCase()}-${run}`;
  const accepted = await call("POST", `/api/_a2app/invites/${invite.json?.code}`, { as: {}, body: { name, login, password }, headers: { origin: base } });
  return { invite, accepted, login, id: accepted.json?.id, session: { cookie: cookieOf(accepted) } };
}
const alice = await join("owner", "Alice");
check("an invite is issued", [alice.invite.status, alice.invite.json?.role], [201, "owner"]);
ok("…with a link to the account page", alice.invite.json?.url?.includes("/_a2app/account#setup/"));
check("accepting it makes the account", [alice.accepted.status, alice.accepted.json?.role], [201, "owner"]);
const setCookie = alice.accepted.headers.get("set-cookie") ?? "";
ok("…and signs them in with an HttpOnly, SameSite=Lax cookie", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
check("an invite works once", code(await call("POST", `/api/_a2app/invites/${alice.invite.json?.code}`, { body: { name: "X", login: `x-${run}`, password }, headers: { origin: base } })), "invite_invalid");

const bob = await join("member", "Bob");
check("a member joins", bob.accepted.json?.role, "member");
const dup = await call("POST", "/api/_a2app/invites", { as: admin, body: { role: "member" } });
check("a login is taken once", code(await call("POST", `/api/_a2app/invites/${dup.json?.code}`, { body: { name: "Bob 2", login: bob.login, password }, headers: { origin: base } })), "login_taken");

check("the session says who is signed in", (await call("GET", "/api/_a2app/session", { as: bob.session })).json?.id, bob.id);
check("a wrong password is refused", code(await call("POST", "/api/_a2app/session", { body: { login: bob.login, password: "not the password" }, headers: { origin: base } })), "sign_in_failed");
const signIn = await call("POST", "/api/_a2app/session", { body: { login: bob.login, password }, headers: { origin: base } });
check("the right one signs in", [signIn.status, signIn.json?.id], [200, bob.id]);
const bobAgain = { cookie: cookieOf(signIn) };
check("signing out ends that session", (await call("DELETE", "/api/_a2app/session", { as: bobAgain })).status, 200);
check("…for good", code(await call("GET", "/api/_a2app/session", { as: bobAgain })), "sign_in_required");

/* ------------------------------------------------------------ ownership */

const aliceRec = await call("POST", `/api/collections/${entity}/records`, { as: alice.session, body: { title: `Alice's ${run}` } });
const bobRec = await call("POST", `/api/collections/${entity}/records`, { as: bob.session, body: { title: `Bob's ${run}` } });
ok("people create records", aliceRec.status < 300 && bobRec.status < 300);
check("a signed-in change needs the app's own Origin", code(await call("POST", `/api/collections/${entity}/records`, { as: bob.session, origin: false, body: { title: "csrf" } })), "forbidden_origin");
const mine = (r) => items(r).filter((x) => x.title?.endsWith(run)).map((x) => x.title).sort();
check("a member sees only their own records", mine(await call("GET", `/api/collections/${entity}/records`, { as: bob.session })), [`Bob's ${run}`]);
check("…and not anyone else's, even by id", (await call("GET", `/api/collections/${entity}/records/${aliceRec.json?.id}`, { as: bob.session })).status, 404);
check("…nor changes them", (await call("PATCH", `/api/collections/${entity}/records/${aliceRec.json?.id}`, { as: bob.session, body: { title: "mine now" } })).status, 404);
check("an owner sees everyone's", mine(await call("GET", `/api/collections/${entity}/records`, { as: alice.session })), [`Alice's ${run}`, `Bob's ${run}`]);

/* --------------------------------------------------------------- people */

ok("an owner lists people", (await call("GET", "/api/_a2app/users", { as: alice.session })).json?.users?.some((u) => u.id === bob.id));
check("a member cannot", code(await call("GET", "/api/_a2app/users", { as: bob.session })), "not_a_manager");

/* ---------------------------------------------------------- credentials */

const issued = await call("POST", "/api/_a2app/credentials", { as: bob.session, body: { agentName: "suite", scopes: [`data:${entity}:read`], expiresIn: 3600 } });
check("a person issues a credential", [issued.status, issued.json?.credential?.principal], [201, bob.id]);
const bobToken = issued.json?.token;
ok("…a 256-bit a2a_ token", /^a2a_[A-Za-z0-9_-]{43}$/.test(bobToken ?? ""));
const who = (await call("GET", "/api/_a2app/whoami", { as: bobToken })).json;
check("it acts as that person, with what it was given", [who?.principal, who?.principalName, who?.role, who?.scopes], [bob.id, "Bob", "member", [`data:${entity}:read`]]);
check("…seeing what they see", mine(await call("GET", `/api/collections/${entity}/records`, { as: bobToken })), [`Bob's ${run}`]);
check("…and no more than it was given", code(await call("POST", `/api/collections/${entity}/records`, { as: bobToken, body: { title: "x" } })), "insufficient_scope");
const listed = (await call("GET", "/api/_a2app/credentials", { as: bob.session })).json?.credentials ?? [];
ok("people list their credentials", listed.some((c) => c.credentialId === issued.json?.credential?.credentialId));
ok("…never their tokens", !JSON.stringify(listed).includes(bobToken));
check("an agent's credential manages nothing", code(await call("GET", "/api/_a2app/credentials", { as: bobToken })), "not_a_manager");
check("an unknown token is refused", code(await call("GET", "/api/_a2app/whoami", { as: `a2a_${"x".repeat(43)}` })), "credential_invalid");

const wide = (await call("POST", "/api/_a2app/credentials", { as: bob.session, body: { agentName: "wide" } })).json?.token;
await call("PATCH", `/api/_a2app/users/${bob.id}`, { as: alice.session, body: { active: false } });
check("deactivating a person stops their agents", code(await call("GET", "/api/_a2app/whoami", { as: wide })), "principal_inactive");
await call("PATCH", `/api/_a2app/users/${bob.id}`, { as: alice.session, body: { active: true } });
check("…and reactivating restores them", (await call("GET", "/api/_a2app/whoami", { as: wide })).status, 200);

check("a person revokes their credential", (await call("DELETE", `/api/_a2app/credentials/${issued.json?.credential?.credentialId}`, { as: bob.session })).status, 200);
check("…and it stops working", code(await call("GET", "/api/_a2app/whoami", { as: bobToken })), "credential_revoked");

/* ------------------------------------------------------ device sign-in */

const started = await call("POST", "/api/_a2app/auth/device", { body: { agentName: "suite device", scopes: [`data:${entity}:read`, `data:${entity}:write`] } });
ok("an agent asks to sign in", started.status === 200 && /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(started.json?.userCode ?? ""));
ok("…with a link to approve it", started.json?.verificationUriComplete?.endsWith(`/_a2app/account#approve/${started.json?.userCode}`));
const poll = (deviceCode, confirmation) =>
  call("POST", "/api/_a2app/auth/token", { body: confirmation === undefined ? { deviceCode } : { deviceCode, confirmation } });
check("polling waits for the person", code(await poll(started.json?.deviceCode)), "authorization_pending");
check("…and says to slow down when too fast", code(await poll(started.json?.deviceCode)), "slow_down");
const review = (await call("GET", `/api/_a2app/auth/device/${started.json?.userCode}`, { as: bob.session })).json;
check("the person reviews the request: who, when, and that no agent waits on their computer", [review?.agentName, typeof review?.requestedAt, review?.loopback], ["suite device", "string", false]);
const approval = (await call("POST", `/api/_a2app/auth/device/${started.json?.userCode}`, { as: bob.session, body: { approve: true, scopes: [`data:${entity}:read`] } })).json;
check("…and approves it, narrowing it", approval?.status, "approved");
ok("…getting a confirmation code for their agent, with nowhere to send it", /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(approval?.confirmation ?? "") && approval?.redirect === null);
check("approval alone hands nothing over", code(await poll(started.json?.deviceCode)), "confirmation_required");
check("…nor does a wrong confirmation code", code(await poll(started.json?.deviceCode, "BBBB-BBBB")), "confirmation_invalid");
const got = await poll(started.json?.deviceCode, approval?.confirmation);
check("the agent holding the code receives a credential for that person", [got.json?.credential?.principal, got.json?.credential?.scopes], [bob.id, [`data:${entity}:read`]]);
check("…once", code(await poll(started.json?.deviceCode, approval?.confirmation)), "expired_token");

const guessed = (await call("POST", "/api/_a2app/auth/device", { body: {} })).json;
await call("POST", `/api/_a2app/auth/device/${guessed?.userCode}`, { as: bob.session, body: { approve: true } });
for (let i = 0; i < 4; i++) await poll(guessed?.deviceCode, "BBBB-BBBB");
check("five wrong confirmation codes void the request", code(await poll(guessed?.deviceCode, "BBBB-BBBB")), "access_denied");

check("a loopback port must be a real one", code(await call("POST", "/api/_a2app/auth/device", { body: { loopbackPort: 80 } })), "usage");
const local = (await call("POST", "/api/_a2app/auth/device", { body: { agentName: "suite local", loopbackPort: 53682 } })).json;
check("an agent on the person's computer is shown as such", (await call("GET", `/api/_a2app/auth/device/${local?.userCode}`, { as: bob.session })).json?.loopback, true);
const sent = (await call("POST", `/api/_a2app/auth/device/${local?.userCode}`, { as: bob.session, body: { approve: true } })).json;
check("approval sends the browser back to the agent's port with the code", sent?.redirect, `http://127.0.0.1:53682/a2app/callback?confirmation=${sent?.confirmation}`);
check("…which completes the sign-in", (await poll(local?.deviceCode, sent?.confirmation)).json?.credential?.principal, bob.id);

/* -------------------------------------------------------------- tasks */

const asked = await call("POST", `/api/ops/${op}`, { as: bob.session, body: { task: bobRec.json?.id } });
const queued = asked.json?.queued ?? asked.json?.result?.queued;
ok("a person queues agent work", typeof queued === "string");
check("the task records who asked", (await call("GET", `/api/_a2app/tasks/${queued}`, { as: bob.session })).json?.request?.principal, bob.id);
check("a member cannot issue a task's credential", code(await call("POST", `/api/_a2app/tasks/${queued}/credential`, { as: bob.session })), "not_a_manager");
const taskCred = await call("POST", `/api/_a2app/tasks/${queued}/credential`, { as: admin, body: { agentName: "bridge:suite" } });
check("the admin credential issues it, for that person and that task", [taskCred.status, taskCred.json?.credential?.principal, taskCred.json?.credential?.task], [201, bob.id, queued]);
ok("…for an hour at most", Date.parse(taskCred.json?.credential?.expiresAt) <= Date.now() + 3_600_000 + 5_000);
const taskToken = taskCred.json?.token;
check("the task's agent acts as that person", (await call("GET", "/api/_a2app/whoami", { as: taskToken })).json?.principal, bob.id);
check("…sees what they see", mine(await call("GET", `/api/collections/${entity}/records`, { as: taskToken })), [`Bob's ${run}`]);
await call("POST", `/api/_a2app/tasks/${queued}/claim`, { as: admin });
check("…and closes the task", (await call("POST", `/api/_a2app/tasks/${queued}/complete`, { as: taskToken, body: { status: "completed", result: {} } })).status, 200);
check("then its credential is dead", code(await call("GET", "/api/_a2app/whoami", { as: taskToken })), "credential_revoked");
check("…and none is issued for the finished task", code(await call("POST", `/api/_a2app/tasks/${queued}/credential`, { as: admin })), "task_not_claimable");

/* -------------------------------------------------------------- report */

if (failures.length > 0) {
  console.log(`multi-user conformance against ${base}: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log(`multi-user conformance against ${base}: all ${passed} checks passed`);
