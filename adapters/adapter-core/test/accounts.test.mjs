/**
 * Accounts, sessions, invites and record ownership on a multi-user app
 * (spec/v0_2/auth.md §4–5), driven through `handle` the way a host would.
 */
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const ORIGIN = "http://127.0.0.1:9941";
const ADMIN = "admin-token-for-tests";

function makeApp({ authMode = "multi-user", publicUrl } = {}) {
  return createA2App(
    new MemoryBinding({
      appId: "acct_test",
      appName: "Accounts Test",
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
      modules: [{ name: "desk", summary: "notes" }],
      allowedOrigins: [ORIGIN],
      credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"] }],
      ...(publicUrl ? { publicUrl } : {}),
    },
  );
}

const app = makeApp();

/** A tiny cookie jar per person. */
function person() {
  let cookie = "";
  return {
    async call(method, path, body, { origin = true, extra = {} } = {}) {
      const headers = { host: "127.0.0.1:9941", ...(cookie ? { cookie } : {}), ...(origin ? { origin: ORIGIN } : {}), ...extra };
      const reply = await app.handle({ method, path, query: {}, headers, body });
      const set = reply.headers?.["set-cookie"];
      if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
      return reply;
    },
    get cookie() {
      return cookie;
    },
  };
}
const admin = (method, path, body) =>
  app.handle({ method, path, query: {}, headers: { host: "127.0.0.1:9941", "x-a2app-token": ADMIN }, body });

/* ------------------------------------------------------------- identity */

const id = (await app.handle({ method: "GET", path: "/api/_a2app", query: {}, headers: {} })).json;
check("identity speaks protocol 0.2", id.protocol, "0.2");
check("…and reports the auth mode", id.authMode, "multi-user");
check("…and the account page", id.accountUrl, "/_a2app/account");

/* --------------------------------------------------- nobody signed in */

const program = await app.handle({ method: "GET", path: "/api/collections/notes/records", query: {}, headers: {} });
check("a program with nothing is asked for a credential", [program.status, program.json.code], [401, "agent_token_required"]);
const page = await app.handle({ method: "GET", path: "/api/collections/notes/records", query: {}, headers: { "sec-fetch-site": "same-origin" } });
check("the app's own page is asked to sign in", [page.status, page.json.code, page.json.signInUrl], [401, "sign_in_required", "/_a2app/account#sign-in"]);

/* ------------------------------------------------- the first owner */

const ownerInvite = await admin("POST", "/api/_a2app/invites", { role: "owner" });
check("the admin credential creates an owner invite", [ownerInvite.status, ownerInvite.json.role], [201, "owner"]);
ok("…with a setup link on the account page", ownerInvite.json.url.startsWith("http://127.0.0.1:9941/_a2app/account#setup/"));

const alice = person();
check("an invite can be read before accepting", (await alice.call("GET", `/api/_a2app/invites/${ownerInvite.json.code}`)).json.role, "owner");
check("a short password is refused", (await alice.call("POST", `/api/_a2app/invites/${ownerInvite.json.code}`, { name: "Alice", login: "alice@x.test", password: "short" })).status, 400);
const accepted = await alice.call("POST", `/api/_a2app/invites/${ownerInvite.json.code}`, { name: "Alice", login: " Alice@X.test ", password: "correct horse battery" });
check("accepting creates the account", [accepted.status, accepted.json.role, accepted.json.login], [201, "owner", "alice@x.test"]);
ok("…and signs the person in", alice.cookie.startsWith("a2app_session_acct_test="));
ok("…without ever serving the password hash", !JSON.stringify(accepted.json).includes("pbkdf2"));
const setCookie = accepted.headers["set-cookie"];
ok("the session cookie is HttpOnly, SameSite=Lax, on /", /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Path=\//.test(setCookie));
ok("…and not Secure on a loopback-only app", !/Secure/.test(setCookie));
check("an invite is single use", (await person().call("POST", `/api/_a2app/invites/${ownerInvite.json.code}`, { name: "Eve", login: "eve@x.test", password: "correct horse battery" })).json.code, "invite_invalid");

const me = await alice.call("GET", "/api/_a2app/session");
check("the session says who is signed in", [me.status, me.json.name, me.json.role], [200, "Alice", "owner"]);
const who = await alice.call("GET", "/api/_a2app/whoami");
check("whoami reports the account", [who.json.principal, who.json.principalName, who.json.role], [me.json.id, "Alice", "owner"]);

/* --------------------------------------------- a member, and CSRF */

const csrf = await alice.call("POST", "/api/_a2app/invites", { role: "member" }, { origin: false });
check("a signed-in change without this app's Origin is refused", [csrf.status, csrf.json.code], [403, "forbidden_origin"]);
const memberInvite = await alice.call("POST", "/api/_a2app/invites", { role: "member" });
check("an owner invites a member", [memberInvite.status, memberInvite.json.role], [201, "member"]);
const bob = person();
const bobAccount = (await bob.call("POST", `/api/_a2app/invites/${memberInvite.json.code}`, { name: "Bob", login: "bob", password: "another long password" })).json;
check("the member signs up", bobAccount.role, "member");
check("a member cannot invite", (await bob.call("POST", "/api/_a2app/invites", { role: "member" })).json.code, "not_a_manager");
check("…nor list people", (await bob.call("GET", "/api/_a2app/users")).status, 403);
const taken = await person().call("POST", `/api/_a2app/invites/${(await alice.call("POST", "/api/_a2app/invites", { role: "member" })).json.code}`, { name: "Bob 2", login: "BOB", password: "another long password" });
check("a login is unique, case-insensitively", [taken.status, taken.json.code], [409, "login_taken"]);

/* ------------------------------------------------------- ownership */

const aliceNote = (await alice.call("POST", "/api/collections/notes/records", { title: "Alice's" })).json;
check("a new record is owned by its creator", aliceNote.owner, me.json.id);
const forged = await bob.call("POST", "/api/collections/notes/records", { title: "forged", owner: me.json.id });
check("nobody writes the owner field themselves", [forged.status, forged.json.code], [400, "read_only_field"]);
const bobNote = (await bob.call("POST", "/api/collections/notes/records", { title: "Bob's" })).json;
check("the member's record is the member's", bobNote.owner, bobAccount.id);

const bobList = (await bob.call("GET", "/api/collections/notes/records")).json;
check("a member lists only its own records", bobList.items.map((n) => n.title), ["Bob's"]);
check("…and the count says so", bobList.totalItems, 1);
check("another member's record reads as missing", (await bob.call("GET", `/api/collections/notes/records/${aliceNote.id}`)).status, 404);
check("…cannot be changed", (await bob.call("PATCH", `/api/collections/notes/records/${aliceNote.id}`, { title: "mine now" })).status, 404);
check("…or deleted", (await bob.call("DELETE", `/api/collections/notes/records/${aliceNote.id}`)).status, 404);
check("…or described", (await bob.call("GET", `/api/_a2app/describe/desk/notes/${aliceNote.id}`)).status, 404);
check("the owner sees every record", (await alice.call("GET", "/api/collections/notes/records")).json.items.length, 2);
check("describe publishes ownedBy", (await alice.call("GET", "/api/_a2app/describe/desk/notes")).json.ownedBy, "owner");

/* ------------------------------------------------- sign in and out */

const out = await bob.call("DELETE", "/api/_a2app/session");
ok("signing out clears the cookie", /Max-Age=0/.test(out.headers["set-cookie"]) && bob.cookie === "");
check("…and the session is gone", (await bob.call("GET", "/api/_a2app/session")).status, 401);
check("a wrong password is refused", (await bob.call("POST", "/api/_a2app/session", { login: "bob", password: "wrong password!" })).json.code, "sign_in_failed");
check("an unknown login is refused the same way", (await bob.call("POST", "/api/_a2app/session", { login: "nobody", password: "wrong password!" })).json.code, "sign_in_failed");
const back = await bob.call("POST", "/api/_a2app/session", { login: "BOB", password: "another long password" });
check("signing in again works (login is case-insensitive)", [back.status, back.json.id], [200, bobAccount.id]);

/* ------------------------------------------- people: roles, active */

const users = (await alice.call("GET", "/api/_a2app/users")).json.users;
check("the owner lists everyone", users.map((u) => u.name), ["Alice", "Bob"]);
ok("…never with a password hash", !JSON.stringify(users).includes("passwordHash"));
check("the last owner cannot step down", (await alice.call("PATCH", `/api/_a2app/users/${me.json.id}`, { role: "member" })).json.code, "last_owner");
check("…or be deactivated", (await alice.call("PATCH", `/api/_a2app/users/${me.json.id}`, { active: false })).json.code, "last_owner");
check("deactivating a member", (await alice.call("PATCH", `/api/_a2app/users/${bobAccount.id}`, { active: false })).json.active, false);
check("…ends its session on the next request", (await bob.call("GET", "/api/collections/notes/records")).status, 401);
check("…and it cannot sign in", (await bob.call("POST", "/api/_a2app/session", { login: "bob", password: "another long password" })).json.code, "sign_in_failed");

/* --------------------------------------------- sign-in failure limit */

const mallory = person();
for (let i = 0; i < 10; i++) await mallory.call("POST", "/api/_a2app/session", { login: "alice@x.test", password: `guess number ${i}` });
const limited = await mallory.call("POST", "/api/_a2app/session", { login: "alice@x.test", password: "correct horse battery" });
check("ten failures lock that login for a while", [limited.status, limited.json.code], [429, "rate_limited"]);
ok("…saying when to try again", limited.json.retryAfterSeconds > 0);

/* ------------------------------------------------ other app shapes */

const single = makeApp({ authMode: "none" });
const none = await single.handle({ method: "GET", path: "/api/_a2app/session", query: {}, headers: {} });
check("a single-user app has no accounts", [none.status, none.json.code], [404, "not_multi_user"]);
const view = await single.handle({ method: "POST", path: "/api/collections/notes/records", query: {}, headers: { origin: ORIGIN }, body: { title: "x" } });
check("a single-user View still writes as the owner", [view.status, view.json.owner], [200, "owner"]);

const secure = makeApp({ publicUrl: "https://notes.example.com" });
const secureInvite = await secure.handle({ method: "POST", path: "/api/_a2app/invites", query: {}, headers: { "x-a2app-token": ADMIN }, body: { role: "owner" } });
ok("behind https the setup link uses the public URL", secureInvite.json.url.startsWith("https://notes.example.com/_a2app/account#setup/"));
const secureAccept = await secure.handle({
  method: "POST",
  path: `/api/_a2app/invites/${secureInvite.json.code}`,
  query: {},
  headers: { origin: "https://notes.example.com", host: "notes.example.com" },
  body: { name: "Owner", login: "o", password: "correct horse battery" },
});
ok("…and the session cookie is Secure", /Secure/.test(secureAccept.headers["set-cookie"]));

let refused = null;
try {
  createA2App(
    new MemoryBinding({
      appId: "bad",
      entities: { notes: { module: "desk", ownedBy: "owner", fields: [{ name: "owner", type: "string" }], seed: [] } },
    }),
    { modules: [{ name: "desk" }] },
  );
} catch (e) {
  refused = e.message;
}
ok("ownedBy must name a read-only string field", refused !== null && /readOnly string field/.test(refused));

if (failures.length) {
  console.log(`accounts: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("accounts: all checks passed");
