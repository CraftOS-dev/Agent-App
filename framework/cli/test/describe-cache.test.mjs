/**
 * The describe cache is held per credential.
 *
 * Describe answers for the caller: a module lists the operations THIS
 * credential may run. The cache used to be keyed by the app's version markers
 * alone, so a walk made with the app's admin token cached a module screen that
 * a person's delegated agent was then shown — offering it operations its own
 * credential cannot run. The server still refused the call; the walk should
 * never have offered it. These checks pin the cache to the credential, and the
 * cache file to a hash of it, never the token.
 *
 * Standard library only, run directly. No network: the app is a local server.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialKey, DescribeCache, MAX_CREDENTIALS } from "../dist/lib/describeCache.js";

const here = dirname(fileURLToPath(import.meta.url));
const a2app = resolve(here, "../dist/a2app.js");
const base = mkdtempSync(join(tmpdir(), "a2app-describe-cache-"));

const ADMIN = "a2app_admin_token_for_the_cache_test";
const DELEGATED = "a2app_delegated_token_for_the_cache_test";

/* ----------------------------------------------------------------- units */

{
  const dir = join(base, "unit");
  const level = (ops) => ({ level: "module", path: "work", entities: [], operations: ops.map((name) => ({ name, destructive: false })), next: [] });
  const admin = DescribeCache.open(dir, "app1", "s1", "v1", credentialKey(ADMIN));
  admin.put("work", level(["count", "export-all"]));
  admin.flush();

  const agent = DescribeCache.open(dir, "app1", "s1", "v1", credentialKey(DELEGATED));
  assert.equal(agent.get("work"), undefined, "another credential's levels are not this credential's");
  agent.put("work", level(["count"]));
  agent.flush();

  assert.deepEqual(DescribeCache.open(dir, "app1", "s1", "v1", credentialKey(ADMIN)).get("work").operations.map((o) => o.name), ["count", "export-all"], "the admin's levels survive the agent's write");
  assert.deepEqual(DescribeCache.open(dir, "app1", "s1", "v1", credentialKey(DELEGATED)).get("work").operations.map((o) => o.name), ["count"]);
  assert.equal(DescribeCache.open(dir, "app1", "s1", "v1", credentialKey(null)).get("work"), undefined, "no credential is a reach of its own");

  const file = readFileSync(join(dir, ".a2app", "describe-cache.json"), "utf8");
  assert.ok(!file.includes(ADMIN) && !file.includes(DELEGATED), "the cache file never holds a token");
  assert.match(credentialKey(ADMIN), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(credentialKey(ADMIN), credentialKey(DELEGATED));

  // A version change discards every credential's levels at once.
  assert.equal(DescribeCache.open(dir, "app1", "s2", "v1", credentialKey(ADMIN)).get("work"), undefined);

  // A cache written before levels were held per credential is discarded, not read.
  writeFileSync(join(dir, ".a2app", "describe-cache.json"), JSON.stringify({ appId: "app1", schemaVersion: "s1", appVersion: "v1", levels: { work: level(["x"]) } }));
  assert.equal(DescribeCache.open(dir, "app1", "s1", "v1", credentialKey(ADMIN)).get("work"), undefined);

  // Short-lived task credentials do not accumulate: the least recently used go first.
  for (let i = 0; i < MAX_CREDENTIALS + 3; i++) {
    const c = DescribeCache.open(dir, "app1", "s1", "v1", credentialKey(`task-${i}`));
    c.put("", { level: "root", app: { id: "app1" }, modules: [], conventions: {}, next: [] });
    c.flush();
  }
  const kept = Object.keys(JSON.parse(readFileSync(join(dir, ".a2app", "describe-cache.json"), "utf8")).credentials);
  assert.equal(kept.length, MAX_CREDENTIALS);
  assert.ok(kept.includes(credentialKey(`task-${MAX_CREDENTIALS + 2}`)) && !kept.includes(credentialKey("task-0")));
}

/* ------------------------------------------------------------ end to end */

let describes = 0;
const server = createServer((req, res) => {
  const token = req.headers["x-a2app-token"] ?? null;
  const send = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/.well-known/a2app.json" || url.pathname === "/api/_a2app") {
    return send({ a2app: true, protocol: "0.2", adapterVersion: "0.1.0", app: { id: "cache_app", name: "Cache App" }, schemaVersion: "s1", appVersion: "v1", serverNow: new Date().toISOString(), serverTzOffsetMinutes: 0 });
  }
  if (url.pathname === "/api/_a2app/describe") {
    describes += 1;
    return send({ level: "root", app: { id: "cache_app", name: "Cache App" }, modules: [{ name: "work", entities: 0, operations: 2, access: "full" }], conventions: {}, next: ["a2app <app> work"] });
  }
  if (url.pathname === "/api/_a2app/describe/work") {
    describes += 1;
    // The app's reach depends on who asks: only the admin may export everything.
    const operations = [{ name: "count", summary: "count things", destructive: false }];
    if (token === ADMIN) operations.push({ name: "export-all", summary: "export every record", destructive: false });
    return send({ level: "module", path: "work", entities: [], operations, next: [] });
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "not_found" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const app = join(base, "app");
const home = join(base, "home");
mkdirSync(app, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(
  join(app, "manifest.json"),
  JSON.stringify({ id: "cache_app", name: "Cache App", agentAppVersion: "0.1.0", adapterVersion: "0.1.0", authMode: "none", modules: [{ name: "work" }], port, pipeline: { install: "", build: "", start: "", health: "/api/_a2app" } }),
);
writeFileSync(join(app, ".agent-token"), `${ADMIN}\n`);

function walk(token) {
  const env = { ...process.env, A2APP_HOME: home };
  delete env.A2APP_TOKEN;
  if (token !== null) env.A2APP_TOKEN = token;
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [a2app, app, "work"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? done(stdout) : reject(new Error(`a2app exited ${code}\n${stderr}\n${stdout}`))));
  });
}

try {
  const asAdmin = await walk(null);
  assert.match(asAdmin, /export-all/, "the admin token reaches export-all");
  const asAgent = await walk(DELEGATED);
  assert.match(asAgent, /count/);
  assert.doesNotMatch(asAgent, /export-all/, "a delegated agent is never offered what only the admin cached");
  const before = describes;
  assert.match(await walk(null), /export-all/);
  assert.equal(describes, before, "the admin's walk is still served from its own cached levels");
  const file = readFileSync(join(app, ".a2app", "describe-cache.json"), "utf8");
  assert.ok(!file.includes(ADMIN) && !file.includes(DELEGATED), "the cache file never holds a token");
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(base, { recursive: true, force: true });
}

console.log("✓ describe cache: held per credential, under a hash of it");
