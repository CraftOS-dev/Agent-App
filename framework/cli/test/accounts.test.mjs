/**
 * `agent-app <dir> owner` / `invite`: one-time setup links made with the app's
 * admin credential, against a real adapter on the port the manifest names.
 *
 * The admin token must reach only the app it belongs to, so the cases that
 * matter most are the refusals: an app that is not running, and a port held by
 * a different app (which must never see the token).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createA2App, createA2AppServer, MemoryBinding } from "@a2app/adapter-core";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_APP = resolve(here, "..", "dist", "agent-app.js");

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const TOKEN = "admin-token-cli-accounts";

function freePort() {
  return new Promise((done) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

function cli(args, home) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [AGENT_APP, ...args], { env: { ...process.env, A2APP_HOME: home }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, out: stdout + stderr }));
  });
}

function project(port, id) {
  const dir = mkdtempSync(join(tmpdir(), "a2app-accounts-cli-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ id, name: "CLI Accounts", agentAppVersion: "0.1.0", adapterVersion: "0.1.0", authMode: "multi-user", modules: [{ name: "desk" }], pipeline: { install: "", build: "", start: "", health: "/api/_a2app" }, port }),
  );
  writeFileSync(join(dir, ".agent-token"), TOKEN + "\n");
  return dir;
}

async function serveApp(port, { id, authMode }) {
  const app = createA2App(
    new MemoryBinding({
      appId: id,
      appName: "CLI Accounts",
      authMode,
      entities: { notes: { module: "desk", fields: [{ name: "title", type: "string", required: true }], seed: [] } },
    }),
    {
    modules: [{ name: "desk" }],
    allowedOrigins: [`http://127.0.0.1:${port}`],
    credentials: [{ token: TOKEN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
    },
  );
  const server = createA2AppServer(app);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return server;
}

const home = mkdtempSync(join(tmpdir(), "a2app-accounts-home-"));
try {
  /* -------------------------------------------- a multi-user app answers */
  {
    const port = await freePort();
    const dir = project(port, "cli_accounts");
    const server = await serveApp(port, { id: "cli_accounts", authMode: "multi-user" });
    try {
      const owner = await cli([dir, "owner"], home);
      check("owner prints a link and succeeds", owner.code, 0);
      ok("…a one-time setup link on the account page", new RegExp(`http://127\\.0\\.0\\.1:${port}/_a2app/account#setup/[A-Za-z0-9_-]{43}`).test(owner.out));
      const member = await cli([dir, "invite"], home);
      ok("invite makes a member link by default", member.code === 0 && /new member/.test(member.out));
      const bad = await cli([dir, "invite", "--role", "admin"], home);
      check("an unknown role is a usage error", bad.code, 2);

      // credential mint / list / revoke, for a person who signed up through the link.
      const code = owner.out.match(/#setup\/([A-Za-z0-9_-]{43})/)[1];
      const signup = await fetch(`http://127.0.0.1:${port}/api/_a2app/invites/${code}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ name: "Alice", login: "alice@example.com", password: "correct horse battery" }),
      });
      const alice = await signup.json();
      const minted = await cli([dir, "credential", "mint", "--for", "Alice@Example.com", "--scopes", "data:notes:read", "--expires", "1d", "--name", "CI"], home);
      const token = minted.out.split(/\r?\n/).find((l) => /^a2a_[A-Za-z0-9_-]{43}$/.test(l));
      ok("credential mint prints the token once, on a line of its own", minted.code === 0 && token !== undefined);
      const whoami = await (await fetch(`http://127.0.0.1:${port}/api/_a2app/whoami`, { headers: { "x-a2app-token": token } })).json();
      check("…a token that acts for the person it was minted for", [whoami.principal, whoami.scopes], [alice.id, ["data:notes:read"]]);
      const listed = await cli([dir, "credential", "list"], home);
      ok("credential list shows it", listed.code === 0 && /for Alice/.test(listed.out) && /agent "CI"/.test(listed.out));
      ok("…without the token", !listed.out.includes(token));
      const id = listed.out.match(/cred_[0-9a-f]{16}/)[0];
      check("credential revoke succeeds", (await cli([dir, "credential", "revoke", id], home)).code, 0);
      const after = await (await fetch(`http://127.0.0.1:${port}/api/_a2app/whoami`, { headers: { "x-a2app-token": token } })).json();
      check("…and the token is refused from the next request", after.code, "credential_revoked");
      check("a lifetime that is not one is a usage error", (await cli([dir, "credential", "mint", "--expires", "soon"], home)).code, 2);
      check("an unknown person is a usage error", (await cli([dir, "credential", "mint", "--for", "nobody"], home)).code, 2);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------- a single-user app */
  {
    const port = await freePort();
    const dir = project(port, "cli_single");
    const server = await serveApp(port, { id: "cli_single", authMode: "none" });
    try {
      const res = await cli([dir, "owner"], home);
      ok("a single-user app is told it has no accounts", res.code === 1 && /has no accounts/.test(res.out));
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ---------------------------------- the token goes to no one else */
  {
    const port = await freePort();
    const dir = project(port, "cli_mine");
    const seen = [];
    const impostor = createServer((req, res) => {
      seen.push(req.headers["x-a2app-token"] ?? null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ a2app: true, protocol: "0.2", app: { id: "someone_else" } }));
    });
    await new Promise((r) => impostor.listen(port, "127.0.0.1", r));
    try {
      const res = await cli([dir, "owner"], home);
      ok("another app on the port is refused", res.code === 2 && /another app holds this port/.test(res.out));
      check("…and never receives the admin token", seen.filter((t) => t !== null), []);
    } finally {
      impostor.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ----------------------------------------------- nothing is running */
  {
    const port = await freePort();
    const dir = project(port, "cli_down");
    try {
      const res = await cli([dir, "owner"], home);
      ok("an app that is not running is named as such", res.code === 2 && /is not running/.test(res.out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`accounts (cli): ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("accounts (cli): all checks passed");
