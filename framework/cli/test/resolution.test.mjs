/**
 * Which credential an `a2app` command presents (spec/v0_2/auth.md §11) — the
 * same for a directory as for a URL: A2APP_TOKEN, then the credential stored
 * for the app (`a2app <app> login`), then a local app's own .agent-token.
 *
 * And what is no longer sent at all: the 0.1 `.principal` password sign-in and
 * the A2APP_AUTH_TOKEN / authToken second token are gone, so no password and no
 * Authorization header ever leaves this machine, whatever a 0.1 setup left
 * behind.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { a2appMiddleware, createA2App, MemoryBinding } from "@a2app/adapter-core";

const here = dirname(fileURLToPath(import.meta.url));
const A2APP = resolve(here, "..", "dist", "a2app.js");
const ADMIN = "admin-token-resolution";

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
  new MemoryBinding({ appId: "resolve_app", appName: "Resolve", authMode: "multi-user", entities: { notes: { module: "desk", fields: [{ name: "title", type: "string" }], seed: [] } } }),
  {
    modules: [{ name: "desk" }],
    allowedOrigins: [base],
    credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
  },
);
// Every request is recorded, so the test can say what was NOT sent.
const seen = [];
const mw = a2appMiddleware(app);
const server = createServer((req, res) => {
  seen.push({ path: req.url, authorization: req.headers.authorization ?? null, body: "" });
  mw(req, res, () => {
    res.writeHead(404);
    res.end("{}");
  });
});
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const call = (method, path, headers = {}, body) => app.handle({ method, path, query: {}, headers: { host: `127.0.0.1:${port}`, ...headers }, body });

// Bob, and a credential that acts for him.
const invite = (await call("POST", "/api/_a2app/invites", { "x-a2app-token": ADMIN }, { role: "member" })).json;
const signup = await call("POST", `/api/_a2app/invites/${invite.code}`, { origin: base }, { name: "Bob", login: "bob", password: "a long enough password" });
const bobToken = (await call("POST", "/api/_a2app/credentials", { origin: base, cookie: signup.headers["set-cookie"].split(";")[0] }, { agentName: "stored" })).json.token;

const dir = mkdtempSync(join(tmpdir(), "a2app-resolution-"));
const home = mkdtempSync(join(tmpdir(), "a2app-resolution-home-"));
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "resolve_app", name: "Resolve", agentAppVersion: "0.1.0", adapterVersion: "0.1.0", authMode: "multi-user", modules: [{ name: "desk" }], pipeline: { install: "", build: "", start: "", health: "/api/_a2app" }, port }));
writeFileSync(join(dir, ".agent-token"), ADMIN + "\n");

function whoami(extraEnv = {}) {
  return new Promise((done) => {
    const env = { ...process.env, A2APP_HOME: home, ...extraEnv };
    for (const k of ["A2APP_TOKEN", "A2APP_AUTH_TOKEN"]) if (!(k in extraEnv)) delete env[k];
    const child = spawn(process.execPath, [A2APP, dir, "whoami"], { env, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => done({ who: JSON.parse(out.slice(out.indexOf("{"))), err }));
  });
}

try {
  check("a local app with nothing stored: its own .agent-token (the owner)", (await whoami()).who.principal, "owner");

  writeFileSync(join(home, "credentials.json"), JSON.stringify({ version: 1, credentials: [{ origin: base, appId: "resolve_app", token: bobToken }] }));
  check("a credential stored for the app wins (as for a URL)", (await whoami()).who.principal, signup.json.id);
  check("A2APP_TOKEN wins over both", (await whoami({ A2APP_TOKEN: ADMIN })).who.principal, "owner");

  writeFileSync(join(dir, ".principal"), JSON.stringify({ authUrl: "/api/collections/users/auth-with-password", identity: "bob", password: "hunter2-hunter2" }));
  seen.length = 0;
  const legacy = await whoami({ A2APP_AUTH_TOKEN: "legacy-user-token" });
  ok("a leftover .principal file is never used to sign in", !seen.some((r) => r.path.includes("auth-with-password")));
  check("A2APP_AUTH_TOKEN sends no Authorization header", seen.map((r) => r.authorization).filter((a) => a !== null), []);
  check("the command acts on the stored credential", legacy.who.principal, signup.json.id);

  writeFileSync(join(home, "credentials.json"), JSON.stringify({ version: 1, credentials: [{ origin: base, appId: "resolve_app", token: bobToken, authToken: "old-user-token" }] }));
  seen.length = 0;
  const entry = await whoami();
  check("an authToken left in credentials.json is not sent", seen.map((r) => r.authorization).filter((a) => a !== null), []);
  check("…and the entry's own token is used", entry.who.principal, signup.json.id);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`credential resolution: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("credential resolution: all checks passed");
