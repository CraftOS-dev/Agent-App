/**
 * Device-code sign-in (spec/v0_2/auth.md §7): an agent asks, the person
 * approves on the account page as themselves, the agent's poll receives a
 * credential acting for that person with the scopes they approved. Driven on
 * an injected clock, so the 5 s interval and the 10 minute lifetime are exact.
 */
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const ORIGIN = "http://127.0.0.1:9971";
const ADMIN = "admin-token-device";
let clock = Date.parse("2026-10-28T10:00:00.000Z");
const tick = (seconds) => (clock += seconds * 1000);

function makeApp(authMode) {
  return createA2App(
    new MemoryBinding({
      appId: "device",
      appName: "Device",
      authMode,
      entities: {
        notes: {
          module: "desk",
          fields: [{ name: "title", type: "string", required: true }],
          seed: [],
        },
      },
    }),
    {
      modules: [{ name: "desk" }],
      allowedOrigins: [ORIGIN],
      now: () => new Date(clock),
      credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
    },
  );
}

const app = makeApp("multi-user");
const call = (method, path, headers = {}, body) => app.handle({ method, path, query: {}, headers: { host: "127.0.0.1:9971", ...headers }, body });

const invite = (await call("POST", "/api/_a2app/invites", { "x-a2app-token": ADMIN }, { role: "member" })).json;
const signup = await call("POST", `/api/_a2app/invites/${invite.code}`, { origin: ORIGIN }, { name: "Bob", login: "bob", password: "a long enough password" });
const bob = { id: signup.json.id, headers: { origin: ORIGIN, cookie: signup.headers["set-cookie"].split(";")[0] } };
const poll = (deviceCode, confirmation) => call("POST", "/api/_a2app/auth/token", {}, confirmation === undefined ? { deviceCode } : { deviceCode, confirmation });

/* ------------------------------------------------------------- the ask */

const ask = await call("POST", "/api/_a2app/auth/device", {}, { agentName: "Claude Code on Bob's laptop", scopes: ["data:notes:read", "data:notes:write"], expiresIn: 7 * 86400 });
const askedAt = new Date(clock).toISOString();
check("an agent with no credential may ask", ask.status, 200);
ok("…and gets a user code to show", /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(ask.json.userCode));
check("…the account page to send the person to", ask.json.verificationUri, "http://127.0.0.1:9971/_a2app/account#approve");
check("…with the code filled in", ask.json.verificationUriComplete, `http://127.0.0.1:9971/_a2app/account#approve/${ask.json.userCode}`);
check("…and the RFC 8628 timings", [ask.json.expiresIn, ask.json.interval], [600, 5]);
check("an unknown scope cannot be asked for", (await call("POST", "/api/_a2app/auth/device", {}, { scopes: ["data:secrets:read"] })).status, 400);

/* ------------------------------------------------------------- polling */

check("the first poll waits", (await poll(ask.json.deviceCode)).json.code, "authorization_pending");
const fast = await poll(ask.json.deviceCode);
check("polling sooner than the interval is told to slow down", [fast.json.code, fast.json.interval], ["slow_down", 10]);
tick(10);
check("at the new interval it waits again", (await poll(ask.json.deviceCode)).json.code, "authorization_pending");
check("a device code nobody issued is expired_token", (await poll("not-a-code")).json.code, "expired_token");

/* ------------------------------------------------------------- review */

check("an agent cannot approve itself", (await call("GET", `/api/_a2app/auth/device/${ask.json.userCode}`)).status, 401);
const lower = ask.json.userCode.replace("-", "").toLowerCase();
const review = await call("GET", `/api/_a2app/auth/device/${lower}`, bob.headers);
check("the person sees what is asked (code typed any case, any dash)", [review.status, review.json.agentName, review.json.scopes], [200, "Claude Code on Bob's laptop", ["data:notes:read", "data:notes:write"]]);
check("…and for how long", review.json.expiresIn, 7 * 86400);
check("…when, and that no agent waits on this computer", [review.json.requestedAt, review.json.loopback], [askedAt, false]);
check("an unknown code is device_code_invalid", (await call("GET", "/api/_a2app/auth/device/BCDF-GHJK", bob.headers)).json.code, "device_code_invalid");

/* ------------------------------------------------------------ decide */

check("deciding needs this app's Origin", (await call("POST", `/api/_a2app/auth/device/${ask.json.userCode}`, { cookie: bob.headers.cookie }, { approve: true })).json.code, "forbidden_origin");
check("approval cannot widen what was asked", (await call("POST", `/api/_a2app/auth/device/${ask.json.userCode}`, bob.headers, { approve: true, scopes: ["*"] })).status, 400);
const approved = (await call("POST", `/api/_a2app/auth/device/${ask.json.userCode}`, bob.headers, { approve: true, scopes: ["data:notes:read"] })).json;
check("the person approves, narrowed to reading", approved.status, "approved");
ok("…and is given a confirmation code for their agent", /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(approved.confirmation));
check("…with nowhere to send it on its own", approved.redirect, null);

// Approval alone does not hand over the credential: whoever started the
// request (perhaps someone who sent the person its link) must also present
// the code the person was given.
const unconfirmed = await poll(ask.json.deviceCode);
check("approved but unconfirmed is confirmation_required", [unconfirmed.status, unconfirmed.json.code], [400, "confirmation_required"]);
check("a wrong code is confirmation_invalid", (await poll(ask.json.deviceCode, "BBBB-BBBB")).json.code, "confirmation_invalid");
const issued = await poll(ask.json.deviceCode, approved.confirmation.replace("-", "").toLowerCase());
check("the right code (any case, any dash) receives the credential", issued.status, 200);
ok("…its token", /^a2a_[A-Za-z0-9_-]{43}$/.test(issued.json.token));
check("…acting for the person who approved", [issued.json.credential.principal, issued.json.credential.principalName], [bob.id, "Bob"]);
check("…with what they approved", issued.json.credential.scopes, ["data:notes:read"]);
check("…for as long as was asked", issued.json.credential.expiresAt, new Date(clock + 7 * 86400_000).toISOString());
const who = (await call("GET", "/api/_a2app/whoami", { "x-a2app-token": issued.json.token })).json;
check("the token works, as the person", [who.principal, who.scopes], [bob.id, ["data:notes:read"]]);
check("a code is single use", (await poll(ask.json.deviceCode)).json.code, "expired_token");
ok("the approval lists under the person's agents", (await call("GET", "/api/_a2app/credentials", bob.headers)).json.credentials.some((c) => c.agentName === "Claude Code on Bob's laptop"));

/* ------------------------------------------------------ deny, expire */

const denied = (await call("POST", "/api/_a2app/auth/device", {}, {})).json;
await call("POST", `/api/_a2app/auth/device/${denied.userCode}`, bob.headers, { approve: false });
check("a declined request is access_denied", (await poll(denied.deviceCode)).json.code, "access_denied");
const stale = (await call("POST", "/api/_a2app/auth/device", {}, {})).json;
tick(601);
check("after ten minutes the request is gone", (await poll(stale.deviceCode)).json.code, "expired_token");
check("…for the person too", (await call("GET", `/api/_a2app/auth/device/${stale.userCode}`, bob.headers)).json.code, "device_code_invalid");

const guessed = (await call("POST", "/api/_a2app/auth/device", {}, {})).json;
await call("POST", `/api/_a2app/auth/device/${guessed.userCode}`, bob.headers, { approve: true });
for (let i = 0; i < 4; i++) await poll(guessed.deviceCode, "BBBB-BBBB");
check("five wrong confirmation codes void the request", (await poll(guessed.deviceCode, "BBBB-BBBB")).json.code, "access_denied");
check("…for good", (await poll(guessed.deviceCode)).json.code, "expired_token");

/* ------------------------------------- an agent on the person's computer */

check("a loopback port must be a real one", (await call("POST", "/api/_a2app/auth/device", {}, { loopbackPort: 80 })).json.code, "usage");
const local = (await call("POST", "/api/_a2app/auth/device", {}, { agentName: "local agent", loopbackPort: 53682 })).json;
check("the person is told the agent waits on this computer", (await call("GET", `/api/_a2app/auth/device/${local.userCode}`, bob.headers)).json.loopback, true);
const sent = (await call("POST", `/api/_a2app/auth/device/${local.userCode}`, bob.headers, { approve: true })).json;
check("approval sends the browser back to the agent's port, with the code", sent.redirect, `http://127.0.0.1:53682/a2app/callback?confirmation=${sent.confirmation}`);
check("…which completes the sign-in", (await poll(local.deviceCode, sent.confirmation)).status, 200);

/* --------------------------------------------------- single-user app */

const single = makeApp("none");
const s = (method, path, headers = {}, body) => single.handle({ method, path, query: {}, headers: { host: "127.0.0.1:9971", ...headers }, body });
const soloAsk = (await s("POST", "/api/_a2app/auth/device", {}, { agentName: "remote agent" })).json;
const soloApproved = (await s("POST", `/api/_a2app/auth/device/${soloAsk.userCode}`, { origin: ORIGIN }, { approve: true })).json;
const soloIssued = await s("POST", "/api/_a2app/auth/token", {}, { deviceCode: soloAsk.deviceCode, confirmation: soloApproved.confirmation });
check("on a single-user app the View approves as the owner", [soloIssued.status, soloIssued.json.credential.principal], [200, "owner"]);

if (failures.length) {
  console.log(`device sign-in: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("device sign-in: all checks passed");
