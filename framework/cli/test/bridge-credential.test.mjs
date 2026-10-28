/**
 * The bridge runs each task as the person who queued it (spec/v0_2/auth.md
 * §6.2), against a real adapter: the harness is handed the task's credential,
 * never the app's admin credential, sees only what that person sees, and the
 * credential is dead once the task is.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createA2App, createA2AppServer, MemoryBinding } from "@a2app/adapter-core";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_APP = resolve(here, "..", "dist", "agent-app.js");
const A2APP = resolve(here, "..", "dist", "a2app.js");
const ADMIN = "admin-token-bridge-credential";

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
    appId: "bridge_cred",
    appName: "Bridge Credential",
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
  }),
  {
    modules: [{ name: "desk" }],
    allowedOrigins: [base],
    events: [{ type: "note.ask" }],
    capabilities: { summarize: { scopes: ["data:notes:read"] } },
    credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
  },
);
const server = createA2AppServer(app);
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const call = (method, path, headers = {}, body) => app.handle({ method, path, query: {}, headers: { host: `127.0.0.1:${port}`, ...headers }, body });

async function account(name, role) {
  const invite = (await call("POST", "/api/_a2app/invites", { "x-a2app-token": ADMIN }, { role })).json;
  const accepted = await call("POST", `/api/_a2app/invites/${invite.code}`, { origin: base }, { name, login: name.toLowerCase(), password: "a long enough password" });
  return { id: accepted.json.id, session: { origin: base, cookie: accepted.headers["set-cookie"].split(";")[0] } };
}
const alice = await account("Alice", "owner");
const bob = await account("Bob", "member");
await call("POST", "/api/collections/notes/records", alice.session, { title: "Alice's note" });
await call("POST", "/api/collections/notes/records", bob.session, { title: "Bob's note" });

const dir = mkdtempSync(join(tmpdir(), "a2app-bridge-cred-"));
const home = mkdtempSync(join(tmpdir(), "a2app-bridge-cred-home-"));
writeFileSync(
  join(dir, "manifest.json"),
  JSON.stringify({ id: "bridge_cred", name: "Bridge Credential", agentAppVersion: "0.1.0", adapterVersion: "0.1.0", authMode: "multi-user", modules: [{ name: "desk" }], pipeline: { install: "", build: "", start: "", health: "/api/_a2app" }, port }),
);
writeFileSync(join(dir, ".agent-token"), ADMIN + "\n");
mkdirSync(join(dir, ".a2app"), { recursive: true });

// The harness does what an agent would: operate the app with the a2app CLI,
// from the app's directory, with whatever credential it was given.
const seenFile = join(dir, "harness-saw.json");
const harness = join(dir, "fake-harness.mjs");
writeFileSync(
  harness,
  [
    `import { execFileSync } from "node:child_process";`,
    `import { writeFileSync } from "node:fs";`,
    `const a2app = (...args) => { const out = execFileSync(process.execPath, [${JSON.stringify(A2APP)}, ".", ...args], { encoding: "utf8" }); return JSON.parse(out.slice(out.indexOf("{"))); };`,
    `writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ token: process.env.A2APP_TOKEN ?? null, whoami: a2app("whoami"), notes: a2app("data", "notes", "list") }));`,
  ].join("\n"),
);
writeFileSync(
  join(home, "harnesses.json"),
  JSON.stringify({ version: 1, default: "fake", harnesses: [{ id: "fake", routes: [{ mode: "headless", command: process.execPath, args: [harness, "{prompt}"] }] }] }),
);

function bridgeOnce() {
  return new Promise((done) => {
    const env = { ...process.env, A2APP_HOME: home };
    delete env.A2APP_TOKEN;
    const child = spawn(process.execPath, [AGENT_APP, dir, "bridge", "start", "--once"], { env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}
const taskOf = async (id) => (await call("GET", `/api/_a2app/tasks/${id}`, { "x-a2app-token": ADMIN })).json;

try {
  const asked = app.trigger({ type: "note.ask", payload: { note: "any" }, capability: "summarize", principal: bob.id });
  const run = await bridgeOnce();
  check("the bridge delivers the task", run.code, 0);
  ok("the harness ran", existsSync(seenFile));
  const saw = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : {};
  ok("…with a credential of its own", typeof saw.token === "string" && saw.token.startsWith("a2a_"));
  ok("…never the app's admin credential", saw.token !== ADMIN);
  check("…acting as the person who queued the task", [saw.whoami?.principal, saw.whoami?.scopes], [bob.id, ["data:notes:read"]]);
  check("…seeing only what that person sees", (saw.notes?.items ?? []).map((n) => n.title), ["Bob's note"]);
  check("the task is closed", (await taskOf(asked.taskId)).status, "completed");
  check("…and its credential no longer works", (await call("GET", "/api/_a2app/whoami", { "x-a2app-token": saw.token })).json.code, "credential_revoked");

  rmSync(seenFile, { force: true });
  const later = app.trigger({ type: "note.ask", payload: { note: "later" }, capability: "summarize", principal: bob.id });
  await call("PATCH", `/api/_a2app/users/${bob.id}`, { "x-a2app-token": ADMIN }, { active: false });
  const refused = await bridgeOnce();
  ok("a task whose person left is not run", !existsSync(seenFile));
  const failed = await taskOf(later.taskId);
  check("…it fails, saying why", [failed.status, failed.reason], ["failed", "task_credential_refused"]);
  check("…and the pass reports the failure", refused.code, 1);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`bridge credentials: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("bridge credentials: all checks passed");
