/**
 * Connected agents: issuing, listing and revoking delegated credentials
 * (spec/v0_2/auth.md §2, §8). The token is in the issuing reply and nowhere
 * else; a credential works as X-A2App-Token within its person's reach; a
 * revocation takes effect on the next request.
 */
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const ORIGIN = "http://127.0.0.1:9961";
const ADMIN = "admin-token-credentials";

function makeApp(authMode) {
  return createA2App(
    new MemoryBinding({
      appId: "creds",
      appName: "Credentials",
      authMode,
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
    }),
    {
      modules: [{ name: "desk" }],
      allowedOrigins: [ORIGIN],
      credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
    },
  );
}

const app = makeApp("multi-user");
const call = (method, path, headers = {}, body) => app.handle({ method, path, query: {}, headers, body });
const as = (token) => ({ "x-a2app-token": token });

async function account(name, role) {
  const invite = (await call("POST", "/api/_a2app/invites", as(ADMIN), { role })).json;
  const r = await call("POST", `/api/_a2app/invites/${invite.code}`, { origin: ORIGIN }, { name, login: name.toLowerCase(), password: "a long enough password" });
  return { id: r.json.id, headers: { origin: ORIGIN, cookie: r.headers["set-cookie"].split(";")[0] } };
}
const alice = await account("Alice", "owner");
const bob = await account("Bob", "member");

/* ----------------------------------------------------------------- mint */

const mine = await call("POST", "/api/_a2app/credentials", bob.headers, { agentName: "Bob's laptop agent", scopes: ["data:notes:read", "data:notes:write"], expiresIn: 7 * 86400 });
check("a person issues a credential for themselves", [mine.status, mine.json.credential.principal], [201, bob.id]);
ok("…the token is in this reply", /^a2a_[A-Za-z0-9_-]{43}$/.test(mine.json.token));
ok("…and expires when asked", Math.abs(Date.parse(mine.json.credential.expiresAt) - Date.now() - 7 * 86400_000) < 60_000);
const defaulted = await call("POST", "/api/_a2app/credentials", bob.headers, { agentName: "default" });
ok("a credential expires in 30 days unless asked", Math.abs(Date.parse(defaulted.json.credential.expiresAt) - Date.now() - 30 * 86400_000) < 60_000);
check("…and holds `*` unless narrowed", defaulted.json.credential.scopes, ["*"]);

check("a member cannot issue one for someone else", (await call("POST", "/api/_a2app/credentials", bob.headers, { principal: alice.id })).json.code, "not_a_manager");
const forBob = await call("POST", "/api/_a2app/credentials", alice.headers, { principal: bob.id, agentName: "CI for Bob", scopes: ["data:notes:read"] });
check("an owner issues one for someone else", [forBob.status, forBob.json.credential.principal, forBob.json.credential.principalName], [201, bob.id, "Bob"]);
check("the admin credential issues one too (headless)", (await call("POST", "/api/_a2app/credentials", as(ADMIN), { principal: alice.id, agentName: "CI" })).status, 201);
check("an unknown scope is refused", (await call("POST", "/api/_a2app/credentials", bob.headers, { scopes: ["data:secrets:read"] })).status, 400);
check("an empty scope list is refused", (await call("POST", "/api/_a2app/credentials", bob.headers, { scopes: [] })).status, 400);
check("a lifetime over a year is refused", (await call("POST", "/api/_a2app/credentials", bob.headers, { expiresIn: 400 * 86400 })).status, 400);
check("…as is one under a minute", (await call("POST", "/api/_a2app/credentials", bob.headers, { expiresIn: 5 })).status, 400);
check("a credential for no one is refused", (await call("POST", "/api/_a2app/credentials", alice.headers, { principal: "usr_nobody" })).status, 400);
check("an agent's credential cannot issue more", (await call("POST", "/api/_a2app/credentials", as(mine.json.token), {})).json.code, "not_a_manager");
check("nor can a signed-in page from another site", (await call("POST", "/api/_a2app/credentials", { ...bob.headers, origin: undefined }, {})).json.code, "forbidden_origin");

/* ---------------------------------------------------------------- use */

const note = await call("POST", "/api/collections/notes/records", as(mine.json.token), { title: "written by Bob's agent" });
check("the token works as X-A2App-Token, as its person", [note.status, note.json.owner], [200, bob.id]);
check("a read-only credential cannot write", (await call("POST", "/api/collections/notes/records", as(forBob.json.token), { title: "x" })).json.code, "insufficient_scope");

/* --------------------------------------------------------------- list */

const bobList = (await call("GET", "/api/_a2app/credentials", bob.headers)).json.credentials;
check("a member lists only their own", [...new Set(bobList.map((c) => c.principal))], [bob.id]);
check("…all of them", bobList.length, 3);
const all = (await call("GET", "/api/_a2app/credentials", alice.headers)).json.credentials;
check("an owner lists everyone's", all.length, 4);
ok("a listing never carries a token or its hash", !JSON.stringify(all).includes("a2a_") && !JSON.stringify(all).includes("tokenHash"));
ok("…nor the admin credential", !all.some((c) => c.credentialId === "cred_local"));
ok("…and says when each was last used", all.some((c) => c.lastUsedAt !== null));

/* ------------------------------------------------------------- revoke */

check("a member cannot revoke someone else's", (await call("DELETE", `/api/_a2app/credentials/${all.find((c) => c.principal === alice.id).credentialId}`, bob.headers)).status, 404);
check("a person revokes their own", (await call("DELETE", `/api/_a2app/credentials/${mine.json.credential.credentialId}`, bob.headers)).json.revoked, mine.json.credential.credentialId);
check("…and it stops on the next request", (await call("GET", "/api/collections/notes/records", as(mine.json.token))).json.code, "credential_revoked");
check("…and leaves the listing", (await call("GET", "/api/_a2app/credentials", bob.headers)).json.credentials.length, 2);
check("a credential may revoke itself", (await call("DELETE", `/api/_a2app/credentials/${defaulted.json.credential.credentialId}`, as(defaulted.json.token))).status, 200);
check("an owner revokes anyone's", (await call("DELETE", `/api/_a2app/credentials/${forBob.json.credential.credentialId}`, alice.headers)).status, 200);
check("the admin credential is not revoked through the API", (await call("DELETE", "/api/_a2app/credentials/cred_local", alice.headers)).status, 403);
check("revoking twice is fine", (await call("DELETE", `/api/_a2app/credentials/${forBob.json.credential.credentialId}`, alice.headers)).status, 200);

/* --------------------------------------------------- single-user app */

const single = makeApp("none");
const view = await single.handle({ method: "POST", path: "/api/_a2app/credentials", query: {}, headers: { origin: ORIGIN }, body: { agentName: "remote agent", scopes: ["data:notes:read"] } });
check("on a single-user app the View issues credentials as the owner", [view.status, view.json.credential.principal], [201, "owner"]);
const remote = await single.handle({ method: "POST", path: "/api/collections/notes/records", query: {}, headers: as(view.json.token), body: { title: "x" } });
check("…held to their scopes", remote.json.code, "insufficient_scope");
check("an anonymous program cannot list them", (await single.handle({ method: "GET", path: "/api/_a2app/credentials", query: {}, headers: {} })).status, 401);
check("…but the app's own page can (a browser marks it Sec-Fetch-Site)", (await single.handle({ method: "GET", path: "/api/_a2app/credentials", query: {}, headers: { "sec-fetch-site": "same-origin" } })).json.credentials.length, 1);
check("…and still cannot change one without its Origin", (await single.handle({ method: "POST", path: "/api/_a2app/credentials", query: {}, headers: { "sec-fetch-site": "same-origin" }, body: {} })).status, 401);

if (failures.length) {
  console.log(`credentials: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("credentials: all checks passed");
