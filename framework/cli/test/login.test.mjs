/**
 * `a2app <app> login` / `logout` against a real adapter: the person approves
 * the code as themselves, the credential reaches only the agent holding the
 * approval's confirmation code, the CLI stores it without ever printing it,
 * later commands act as that person, and logout revokes it.
 *
 * Both ways the confirmation travels are covered: back to a loopback port when
 * the CLI opened the person's browser on this computer, and by hand
 * (`login --confirm <code>`) for an agent anywhere else.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createA2App, createA2AppServer, MemoryBinding } from "@a2app/adapter-core";

const here = dirname(fileURLToPath(import.meta.url));
const A2APP = resolve(here, "..", "dist", "a2app.js");
const ADMIN = "admin-token-login";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const port = await new Promise((done) => {
  const s = createNetServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const app = createA2App(
  new MemoryBinding({
    appId: "login_app",
    appName: "Login App",
    authMode: "multi-user",
    entities: { notes: { module: "desk", fields: [{ name: "title", type: "string", required: true }], seed: [] } },
  }),
  {
    modules: [{ name: "desk" }],
    allowedOrigins: [base],
    credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
  },
);
const server = createA2AppServer(app);
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const call = (method, path, headers = {}, body) => app.handle({ method, path, query: {}, headers: { host: `127.0.0.1:${port}`, ...headers }, body });

const invite = (await call("POST", "/api/_a2app/invites", { "x-a2app-token": ADMIN }, { role: "member" })).json;
const signup = await call("POST", `/api/_a2app/invites/${invite.code}`, { origin: base }, { name: "Bob", login: "bob", password: "a long enough password" });
const bob = { id: signup.json.id, headers: { origin: base, cookie: signup.headers["set-cookie"].split(";")[0] } };

const home = mkdtempSync(join(tmpdir(), "a2app-login-home-"));

/** Run the CLI from this folder, where the fake browser lives; `opener` is
 *  AGENT_APP_OPEN_CMD ("" never opens). */
function cli(args, opener = "") {
  return new Promise((done) => {
    const env = { ...process.env, A2APP_HOME: home, AGENT_APP_OPEN_CMD: opener, FAKE_BROWSER_COOKIE: bob.headers.cookie };
    delete env.A2APP_TOKEN;
    const child = spawn(process.execPath, [A2APP, ...args], { env, cwd: here, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}
const userCodeIn = (out) => out.match(/approves code ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})/)?.[1];
const decide = async (userCode, body) => (await call("POST", `/api/_a2app/auth/device/${userCode}`, bob.headers, body)).json;
const file = join(home, "credentials.json");
const storedFor = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).credentials.find((c) => c.origin === base) : undefined);
const pendingFile = join(home, "pending-logins.json");
const pending = () => (existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, "utf8")).logins : []);

try {
  /* --------------------------------------------- an agent anywhere else */

  const started = await cli([base, "login", "--name", "Test agent", "--scopes", "data:notes:read", "--expires", "2d"]);
  check("login starts the sign-in", started.code, 0);
  ok("…saying it is not signed in yet", /Not signed in yet/.test(started.out));
  ok("…printing the approval link", started.out.includes(`${base}/_a2app/account#approve/`));
  const userCode = userCodeIn(started.out);
  check("…and remembering the request until the confirmation comes", pending().map((p) => p.origin), [base]);
  if (process.platform !== "win32") check("…in a file only its owner can read", statSync(pendingFile).mode & 0o777, 0o600);

  check("--confirm before the person approves does not sign in", (await cli([base, "login", "--confirm", "BBBB-BBBB"])).code, 1);
  const approval = await decide(userCode, { approve: true });
  check("the person approves, and is given a confirmation code", approval.status, "approved");
  const wrong = await cli([base, "login", "--confirm", "BBBB-BBBB"]);
  ok("a wrong confirmation code does not sign in", wrong.code === 1 && /not the confirmation code/.test(wrong.out));
  const confirmed = await cli([base, "login", "--confirm", approval.confirmation]);
  check("the right one does", confirmed.code, 0);
  ok("…saying who the agent acts for", /acts as Bob/.test(confirmed.out));
  check("…and the request is no longer pending", pending(), []);

  const stored = storedFor();
  ok("the credential is stored for this app", stored && stored.appId === "login_app" && stored.principal === bob.id);
  ok("…with its token", /^a2a_[A-Za-z0-9_-]{43}$/.test(stored.token));
  ok("…which never appeared in the output", !confirmed.out.includes(stored.token));
  if (process.platform !== "win32") check("…in a file only its owner can read", statSync(file).mode & 0o777, 0o600);

  const who = await cli([base, "whoami"]);
  const whoJson = JSON.parse(who.out.slice(who.out.indexOf("{")));
  check("later commands act as the person", [whoJson.principal, whoJson.scopes], [bob.id, ["data:notes:read"]]);

  const logout = await cli([base, "logout"]);
  check("logout succeeds", logout.code, 0);
  ok("…and forgets the credential", storedFor() === undefined);
  check("…after revoking it", (await call("GET", "/api/_a2app/whoami", { "x-a2app-token": stored.token })).json.code, "credential_revoked");
  check("logging out twice is harmless", (await cli([base, "logout"])).code, 0);

  const declining = await cli([base, "login"]);
  await decide(userCodeIn(declining.out), { approve: false });
  const declined = await cli([base, "login", "--confirm", "BBBB-BBBB"]);
  ok("a declined request ends with no access", declined.code === 1 && /no access/.test(declined.out));
  ok("…nothing stored, nothing pending", storedFor() === undefined && pending().length === 0);
  check("--confirm with no sign-in waiting is a usage error", (await cli([base, "login", "--confirm", "BBBB-BBBB"])).code, 2);

  /* ------------------------------------- an agent on the person's computer */

  const sameComputer = await cli([base, "login", "--name", "Local agent"], "node fixtures/fake-browser.mjs");
  check("on the person's computer the sign-in finishes by itself", sameComputer.code, 0);
  ok("…acting as the person who approved", /acts as Bob/.test(sameComputer.out));
  ok("…with nothing to type and nothing left pending", !/--confirm/.test(sameComputer.out) && pending().length === 0);
  ok("…and the credential stored", storedFor()?.principal === bob.id);
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`login: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("login: all checks passed");
