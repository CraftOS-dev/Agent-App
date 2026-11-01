/**
 * Connect from a harness: the routes a manager tab serves (`ConnectApi`) to sign
 * the agent in to an app on another machine, checked against the fake CLI —
 * what they ask of it and how they read its answers.
 *
 * Runs against the compiled engine (`dist/`), standard library only.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "a2app-starter-connect-"));
const bin = join(base, "bin");
mkdirSync(bin);
for (const name of ["agent-app", "a2app"]) copyFileSync(join(here, "fake-cli.mjs"), join(bin, `${name}.mjs`));
const AGENT_APP = join(bin, "agent-app.mjs");
const A2APP = join(bin, "a2app.mjs");
process.env.FAKE_CALLS = join(base, "calls.jsonl");
process.env.FAKE_REGISTRY = join(base, "registry.json");

const { appOrigin, appSessionName, ConnectApi, connectedSessionPreamble, listApps, loginArgv, parseLoginEvent } = await import("../dist/index.js");

const calls = () => readFileSync(process.env.FAKE_CALLS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const logins = () => calls().filter((c) => c.bin === "a2app" && c.argv[1] === "login").map((c) => c.argv);
async function settle(api, id) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const reply = api.job(id);
    assert.equal(reply.status, 200);
    if (reply.body.job.done) return reply.body.job;
    assert.ok(Date.now() < deadline, "the sign-in did not end");
    await new Promise((r) => setTimeout(r, 30));
  }
}

try {
  /* ── An address, or nothing ── */
  assert.equal(appOrigin("crm.example.com"), "https://crm.example.com", "a bare domain is https");
  assert.equal(appOrigin(" https://CRM.example.com:443/board?x=1 "), "https://crm.example.com");
  assert.equal(appOrigin("http://127.0.0.1:8090/"), "http://127.0.0.1:8090");
  for (const v of ["", "./my-folder", "not an address", "ftp://crm.example.com", "https://bob:pw@crm.example.com", null, 42]) {
    assert.equal(appOrigin(v), null, String(v));
  }
  assert.deepEqual(loginArgv("https://crm.example.com", true, "OpenClaw on box").slice(-2), ["--events", "--print-only"]);
  assert.equal(loginArgv("https://crm.example.com", false, "x").at(-1), "--no-browser");
  assert.equal(parseLoginEvent('{"event":"approve","url":"https://x/a","userCode":"BCDF-GHJK"}').userCode, "BCDF-GHJK");
  for (const line of ["", "ℹ To let this agent…", '{"event":"approve","url":"x"}', '{"event":"result"}', "[]"]) assert.equal(parseLoginEvent(line), null, line);

  /* ── An app the page can embed: approved in its own tab ── */
  const api = new ConnectApi(A2APP, AGENT_APP, { agentName: "OpenClaw on box" });
  let reply = api.connect({ url: "crm.example.com", here: true });
  assert.equal(reply.status, 200);
  let job = await settle(api, reply.body.job.id);
  assert.deepEqual([job.ok, job.pending, job.embedded, job.embedHint], [true, true, true, null], "pending the code the embedded page hands back");
  assert.equal(job.approve.userCode, "BCDF-GHJK");
  assert.deepEqual(logins().at(-1), ["https://crm.example.com", "login", "--name", "OpenClaw on box", "--events", "--no-browser"], "nothing opens a browser");
  reply = await api.confirm({ url: "https://crm.example.com", code: "BAD-CODE" });
  assert.equal(reply.status, 400);
  assert.match(reply.body.message, /not the confirmation code/);
  reply = await api.confirm({ url: "https://crm.example.com", code: "GOOD-CODE" });
  assert.deepEqual([reply.status, reply.body.result.principalName], [200, "Bob"]);
  assert.deepEqual(logins().at(-1).slice(2), ["--confirm", "GOOD-CODE", "--events"]);

  /* ── An app it cannot embed: approved in the browser ── */
  const strict = new ConnectApi(A2APP, AGENT_APP, { agentName: "x", framePolicy: (o) => `add ${o} to the frame list` });
  job = await settle(strict, strict.connect({ url: "https://crm.example.com", here: true }).body.job.id);
  assert.deepEqual([job.embedded, job.embedHint, job.ok, job.pending], [false, "add https://crm.example.com to the frame list", true, false]);
  assert.equal(logins().at(-1).at(-1), "--print-only", "a browser on this machine comes back to the CLI by itself");
  job = await settle(strict, strict.connect({ url: "https://crm.example.com", here: false }).body.job.id);
  assert.equal(job.pending, true, "a browser elsewhere: the person pastes the code");
  job = await settle(api, api.connect({ url: "https://crm.example.com", here: true, embed: false }).body.job.id);
  assert.deepEqual([job.embedded, job.embedHint, job.pending], [false, null, false], "a page that can embed nothing says so");
  assert.equal(logins().at(-1).at(-1), "--print-only");

  /* ── Refusals ── */
  assert.equal(api.connect({ url: "./my-folder" }).status, 400, "never handed to the CLI");
  job = await settle(api, api.connect({ url: "https://stranger.example.com" }).body.job.id);
  assert.equal(job.ok, false);
  assert.match(job.error, /not an Agent App/);
  assert.equal(api.job("nope").status, 404);
  assert.equal((await api.confirm({ url: "crm.example.com" })).status, 400, "a code is needed");

  /* ── Connected apps: rows, and disconnect ── */
  writeFileSync(process.env.FAKE_REGISTRY, JSON.stringify({ ok: true, apps: [], connected: [
    { origin: "https://crm.example.com", appId: "crm", name: "Team CRM", principal: "usr_bob", principalName: "Bob", expiresAt: null, status: "online" },
    { origin: "not an origin", name: "junk", status: "online" },
  ] }));
  const { connected } = await listApps(AGENT_APP);
  assert.deepEqual(connected.map((c) => c.origin), ["https://crm.example.com"], "a row that is not an origin is dropped");
  const [row] = api.remoteRows(connected);
  assert.deepEqual([row.path, row.url, row.remote, row.status, row.principalName, row.embeddable], ["https://crm.example.com", "https://crm.example.com", true, "online", "Bob", true]);
  assert.equal(strict.remoteRows(connected)[0].embedHint, "add https://crm.example.com to the frame list");
  assert.equal((await api.disconnect("https://other.example.com")).status, 404, "only a connected app");
  assert.equal((await api.disconnect("https://crm.example.com")).status, 200);
  assert.ok(calls().some((c) => c.bin === "a2app" && c.argv.join(" ") === "https://crm.example.com logout"));

  assert.equal(appSessionName("/home/me/apps/team-crm"), "team-crm");
  assert.equal(appSessionName("https://crm.example.com"), "crm.example.com");
  assert.equal(appSessionName("http://127.0.0.1:8191"), "127.0.0.1-8191", "no colon inside a key's last part");

  const preamble = connectedSessionPreamble("Team CRM", "https://crm.example.com");
  assert.match(preamble, /`a2app https:\/\/crm\.example\.com`/);
  assert.doesNotMatch(preamble, /modify/, "another machine's app is never modified from here");

  console.log("connect: all checks passed");
} finally {
  rmSync(base, { recursive: true, force: true });
}
