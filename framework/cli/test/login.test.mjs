/**
 * `a2app <app> login` / `logout` against a real adapter: the person approves
 * the code as themselves, the CLI stores the credential it is given without
 * ever printing it, later commands act as that person, and logout revokes it.
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
const env = { ...process.env, A2APP_HOME: home, AGENT_APP_OPEN_CMD: "" };

/** Run the CLI; `onOutput` sees output as it arrives (to approve mid-run). */
function cli(args, onOutput) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [A2APP, ...args], { env, windowsHide: true });
    let out = "";
    const take = (d) => {
      out += d;
      onOutput?.(out);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => done({ code, out }));
  });
}

/** Approve (or decline) the code the CLI printed, once, as Bob. */
function decideOnce(approve, scopes) {
  let done = false;
  return (out) => {
    const code = out.match(/approves code ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})/)?.[1];
    if (!code || done) return;
    done = true;
    call("POST", `/api/_a2app/auth/device/${code}`, bob.headers, scopes ? { approve, scopes } : { approve });
  };
}

try {
  const login = await cli([base, "login", "--name", "Test agent", "--scopes", "data:notes:read", "--expires", "2d"], decideOnce(true));
  check("login succeeds once the person approves", login.code, 0);
  ok("…saying who the agent acts for", /acts as Bob/.test(login.out));
  ok("…printing the approval link", login.out.includes(`${base}/_a2app/account#approve/`));

  const file = join(home, "credentials.json");
  const stored = JSON.parse(readFileSync(file, "utf8")).credentials.find((c) => c.origin === base);
  ok("the credential is stored for this app", stored && stored.appId === "login_app" && stored.principal === bob.id);
  ok("…with its token", /^a2a_[A-Za-z0-9_-]{43}$/.test(stored.token));
  ok("…which never appeared in the output", !login.out.includes(stored.token));
  if (process.platform !== "win32") check("…in a file only its owner can read", statSync(file).mode & 0o777, 0o600);

  const who = await cli([base, "whoami"]);
  const whoJson = JSON.parse(who.out.slice(who.out.indexOf("{")));
  check("later commands act as the person", [whoJson.principal, whoJson.scopes], [bob.id, ["data:notes:read"]]);

  const logout = await cli([base, "logout"]);
  check("logout succeeds", logout.code, 0);
  ok("…and forgets the credential", !JSON.parse(readFileSync(file, "utf8")).credentials.some((c) => c.origin === base));
  check("…after revoking it", (await call("GET", "/api/_a2app/whoami", { "x-a2app-token": stored.token })).json.code, "credential_revoked");
  check("logging out twice is harmless", (await cli([base, "logout"])).code, 0);

  const declined = await cli([base, "login"], decideOnce(false));
  ok("a declined request ends with no access", declined.code === 1 && /declined/.test(declined.out));
  ok("…and nothing stored", !existsSync(file) || !JSON.parse(readFileSync(file, "utf8")).credentials.some((c) => c.origin === base));
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
