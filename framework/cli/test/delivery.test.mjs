/** #12: launch and handoff must not silently strand later work. These tests
 * drive the actual CLIs and detached processes against a wire-level app. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freeEphemeralPort } from "../dist/lib/net.js";
import { inspectDelivery, inspectLocalBridge } from "../dist/lib/delivery.js";
import { isPidAlive, killTreeForce } from "../dist/lib/proc.js";
import { writeSystemHashes } from "../dist/lib/canon.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/agent-app.js");
const base = mkdtempSync(join(tmpdir(), "a2app-delivery-"));
const dir = join(base, "app with spaces");
const home = join(base, "home");
mkdirSync(join(dir, ".a2app"), { recursive: true }); mkdirSync(home);
// Pi's own shell tool must reach the CLI built from this checkout, not a
// globally installed older framework. The shim lives only in this temp tree.
const bin = join(base, "bin"); mkdirSync(bin);
const operate = resolve(here, "../dist/a2app.js");
const shQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
writeFileSync(join(bin, "a2app"), `#!/bin/sh\nexec ${shQuote(process.execPath.replace(/\\/g, "/"))} ${shQuote(operate.replace(/\\/g, "/"))} "$@"\n`, { mode: 0o755 });
writeFileSync(join(bin, "a2app.cmd"), `@echo off\r\n"${process.execPath}" "${operate}" %*\r\n`);
const env = { ...process.env, A2APP_HOME: home };
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
const port = await freeEphemeralPort();
const baseUrl = `http://127.0.0.1:${port}`;
const manifest = {
  id: "delivery_test", name: "Delivery Test", agentAppVersion: "0.1.0", adapterVersion: "0.1.0",
  authMode: "none", modules: [{ name: "work" }], port,
  pipeline: { install: "", build: "", start: `"${process.execPath}" server.mjs`, health: "/api/_a2app" },
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
writeFileSync(join(dir, ".agent-token"), "delivery_test_credential\n");
copyFileSync(join(here, "delivery-fixture.mjs"), join(dir, "server.mjs"));
writeSystemHashes(dir, ["manifest.json"]);
const schema = join(dir, "schema.py");
writeFileSync(schema, 'trigger("review.requested", {}, capability="summarize")\n'); // no human View
const statePath = join(dir, "state.json");
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state));
writeState({ tasks: [] });
const profiles = (routes) => writeFileSync(join(home, "harnesses.json"), JSON.stringify({ version: 1, default: "delivery", harnesses: [{ id: "delivery", routes }] }));
const mock = join(base, "harness.mjs");
writeFileSync(mock, 'console.log("The requested summary is: Later work was delivered.");\n');
profiles([{ mode: "headless", command: process.execPath, args: [mock, "{prompt}"] }]);
const task = (id) => ({
  id, app: "delivery_test", event: null, status: "submitted", request: { capability: "summarize", payload: { text: "A detached bridge should deliver work queued after its launching session ends." } },
  claim: null, progress: {}, result: null, reason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
function cli(args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { killTreeForce(child.pid); reject(new Error(`CLI timed out: ${args.join(" ")}\n${stderr}`)); }, 25_000);
    child.stdout.on("data", (d) => stdout += d); child.stderr.on("data", (d) => stderr += d);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
async function run(args) {
  const r = await cli(args); assert.equal(r.code, 0, `${args.join(" ")}\n${r.stderr}`); return r;
}
const json = (r) => JSON.parse(r.stdout);
async function until(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("condition did not become true in time");
}
const waiting = (id) => readState().tasks.find((t) => t.id === id);
let bridgePid = null, servePid = null;
try {
  const first = await run([dir, "serve"]); servePid = json(first).pid;
  assert.equal(json(first).ok, true); assert.equal(json(first).agentWork.queuesAgentWork, true);
  assert.equal(json(first).agentWork.state, "absent"); assert.equal(json(first).agentWork.tasksWaiting, 0);
  assert.match(first.stderr, /AGENT WORK DELIVERY NOT VERIFIED/); assert.match(first.stderr, /app with spaces.*bridge start/);
  assert.match(first.stderr, /external listener/); assert.equal(existsSync(join(dir, ".a2app/bridge.json")), false);
  const again = await run([dir, "serve"]);
  assert.equal(json(again).alreadyRunning, true); assert.deepEqual(json(again).agentWork, json(first).agentWork);
  assert.match(again.stderr, /AGENT WORK DELIVERY NOT VERIFIED/);

  // Exactly the original failure: a one-shot test works, later work is stranded.
  writeState({ tasks: [task("one_shot")] });
  await run([dir, "bridge", "start", "--once"]);
  assert.equal(waiting("one_shot").status, "completed");
  writeState({ tasks: [task("later")] });
  const warned = await run([dir, "serve"]);
  assert.equal(json(warned).agentWork.tasksWaiting, 1); assert.match(warned.stderr, /DELIVERY NOT VERIFIED/);
  const list = await run(["list"]);
  assert.match(list.stdout, /bridge:missing.*waiting:1/); assert.match(list.stderr, /external harness may be polling/);
  const listed = json(await run(["list", "--json"])).apps[0];
  assert.equal(listed.status, "running"); assert.equal(listed.bridge, null); assert.equal(listed.agentWork.tasksWaiting, 1);
  const status = json(await run([dir, "bridge"]));
  assert.equal(status.running, null); assert.equal(status.tasksWaiting, 1); assert.equal(status.agentWork.baseUrl, baseUrl);

  // Subscribe-only routes do not manufacture a local process or claim work.
  profiles([{ mode: "subscribe", hint: "Keep the harness's own polling loop running" }]);
  const subscribed = json(await run([dir, "bridge", "start"]));
  assert.equal(subscribed.started, false); assert.equal(subscribed.mode, "subscribe");
  assert.equal(json(await run([dir, "bridge"])).running, null); assert.equal(waiting("later").status, "submitted");
  profiles([{ mode: "headless", command: process.execPath, args: [mock, "{prompt}"] }]);

  // Stale/malformed records stay on disk and are never presented as live.
  const stalePath = join(dir, ".a2app/bridge.json");
  for (const record of [{ pid: 0 }, { pid: -1 }, { pid: 1 }, { pid: 1.5 }, { pid: "123" }, null]) {
    writeFileSync(stalePath, JSON.stringify(record));
    assert.equal(inspectLocalBridge(dir).state, "stale"); assert.equal(inspectLocalBridge(dir).running, null);
  }
  const dead = spawn(process.execPath, ["-e", ""], { windowsHide: true }); const deadPid = dead.pid;
  await new Promise((r) => dead.on("close", r));
  writeFileSync(stalePath, JSON.stringify({ pid: deadPid }));
  assert.equal(inspectLocalBridge(dir).state, "stale");
  assert.match((await run(["list"])).stdout, /bridge:stale.*waiting:1/);
  assert.equal(existsSync(stalePath), true); rmSync(stalePath);

  // A failed/malformed/unresponsive queue never looks like zero waiting work.
  for (const queueMode of ["forbidden", "malformed", "bad-task", "hang", "hang-body"]) {
    writeState({ tasks: [], queueMode });
    const started = Date.now();
    const info = await inspectDelivery(dir, "delivery_test", baseUrl, 80);
    assert.equal(info.tasksWaiting, null, queueMode); assert.ok(Date.now() - started < 1200, queueMode);
  }
  const unknown = json(await run(["list", "--json"])).apps[0].agentWork;
  assert.equal(unknown.tasksWaiting, null); assert.match((await run(["list"])).stdout, /waiting:unknown/);

  // A stranger on the live port must never receive the app's credential/queue read.
  writeState({ tasks: [task("stranger")], appId: "different_app" });
  const before = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").length;
  assert.equal((await inspectDelivery(dir, "delivery_test", baseUrl)).tasksWaiting, null);
  const seen = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").slice(before).map(JSON.parse);
  assert.equal(seen.length, 1); assert.equal(seen[0].path, "/api/_a2app"); assert.equal(seen[0].credential, false);
  writeState({ tasks: [task("live_only")] });

  // Status inspects live, even though operate traffic would target dev.
  let devReads = 0;
  let devTasks = [task("dev_1"), task("dev_2")];
  const dev = createServer((req, res) => {
    if (req.url.includes("tasks")) devReads++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ a2app: true, app: { id: "delivery_test" }, tasks: devTasks }));
  });
  await new Promise((r) => dev.listen(0, "127.0.0.1", r));
  try {
    const devPort = dev.address().port;
    writeFileSync(join(dir, ".a2app/dev.json"), JSON.stringify({ pid: process.pid, port: devPort, url: `http://127.0.0.1:${devPort}`, bootDir: join(dir, ".a2app/dev/test"), startedAt: new Date().toISOString(), healthy: true }));
    for (const args of [[dir, "serve"], [dir, "bridge"]]) {
      assert.equal(json(await run(args)).agentWork.tasksWaiting, 1);
    }
    const row = json(await run(["list", "--json"])).apps[0];
    assert.equal(row.agentWork.tasksWaiting, 1); assert.equal(row.dev.answering, true); assert.equal(devReads, 0);
    // A bridge started against dev is genuinely alive, yet cannot deliver
    // live work. Persist its actual endpoint so handoff can catch this case.
    devTasks = [];
    bridgePid = json(await run([dir, "bridge", "start", "--interval", "250"])).pid;
    const wrongTarget = await run([dir, "serve"]);
    assert.equal(json(wrongTarget).agentWork.state, "running");
    assert.equal(json(wrongTarget).agentWork.bridgeTargetsLive, false);
    assert.equal(json(wrongTarget).agentWork.running.baseUrl, `http://127.0.0.1:${devPort}`);
    assert.match(wrongTarget.stderr, /rather than live/);
    assert.match((await run(["list"])).stdout, /bridge-target:other/);
    await run([dir, "bridge", "stop"]); bridgePid = null;
  } finally { rmSync(join(dir, ".a2app/dev.json")); await new Promise((r) => dev.close(r)); }

  // Queue support and capability-free events alone must stay quiet. Waiting
  // work still counts if custom/dynamic enqueue code eludes the static scanner.
  writeFileSync(schema, 'trigger("changed", {}, None)\n# trigger("comment", {}, "summarize")\n');
  writeState({ tasks: [] });
  const quiet = await run([dir, "serve"]);
  assert.equal(json(quiet).agentWork.queuesAgentWork, false); assert.doesNotMatch(quiet.stderr, /DELIVERY NOT VERIFIED/);
  assert.doesNotMatch((await run(["list"])).stdout, /bridge:missing/);
  writeState({ tasks: [task("dynamic")] });
  assert.equal(json(await run([dir, "serve"])).agentWork.queuesAgentWork, true);
  assert.match((await run(["list"])).stdout, /bridge:missing.*waiting:1/);

  // The launching CLI exits; then new work is delivered by the detached bridge.
  writeState({ tasks: [] });
  const started = json(await run([dir, "bridge", "start", "--interval", "250"])); bridgePid = started.pid;
  assert.ok(isPidAlive(bridgePid));
  const reused = json(await run([dir, "bridge", "start"]));
  assert.equal(reused.alreadyRunning, true); assert.equal(reused.pid, bridgePid);
  assert.equal(reused.baseUrl, baseUrl);
  const bridgePath = join(dir, ".a2app/bridge.json");
  const currentRecord = readFileSync(bridgePath, "utf8");
  const legacy = JSON.parse(currentRecord); delete legacy.baseUrl;
  writeFileSync(bridgePath, JSON.stringify(legacy));
  const legacyStatus = json(await run([dir, "bridge"]));
  assert.equal(legacyStatus.agentWork.state, "running");
  assert.equal(legacyStatus.agentWork.bridgeTargetsLive, null);
  assert.match((await run(["list"])).stdout, /bridge-target:unknown/);
  writeFileSync(bridgePath, currentRecord);
  writeState({ tasks: [task("after_session")] });
  await until(() => waiting("after_session")?.status === "completed");
  assert.equal(json(await run([dir, "serve"])).agentWork.running.pid, bridgePid);
  assert.equal(json(await run([dir, "serve"])).agentWork.bridgeTargetsLive, true);
  const stopped = await run([dir, "stop"]);
  assert.match(stopped.stderr, /bridge remains running/); assert.match(stopped.stderr, /bridge stop/);
  assert.equal(json(stopped).bridge.running.pid, bridgePid); assert.ok(isPidAlive(bridgePid)); servePid = null;
  writeState({ tasks: [task("after_restart")] });
  const restarted = json(await run([dir, "serve"])); servePid = restarted.pid;
  assert.equal(restarted.agentWork.state, "running");
  await until(() => waiting("after_restart")?.status === "completed");
  assert.equal(json(await run([dir, "bridge"])).running.pid, bridgePid);
  await run([dir, "bridge", "stop"]); bridgePid = null;

  // Optional real Pi check: credentials and executable belong to the local
  // operator. Never required by CI. The bridge starts Pi after its caller exits.
  const piLauncher = process.env.A2APP_TEST_PI_LAUNCHER;
  if (piLauncher) {
    profiles([{ mode: "headless", command: process.execPath, args: [piLauncher, "-p", "{prompt}"] }]);
    writeState({ tasks: [] });
    bridgePid = json(await run([dir, "bridge", "start", "--interval", "250", "--task-timeout", "180000"])).pid;
    writeState({ tasks: [task("real_pi_after_session")] });
    await until(() => waiting("real_pi_after_session")?.status === "completed", 200_000);
    const result = waiting("real_pi_after_session");
    assert.equal(typeof result.result?.summary, "string"); assert.ok(result.result.summary.length > 0);
    console.log(`Real Pi handoff passed: ${result.result.summary}`);
    await run([dir, "bridge", "stop"]); bridgePid = null;
  }
  console.log("✓ delivery: launch warnings, truthful queue/bridge state, live/dev isolation, detached handoff and restart");
} finally {
  if (bridgePid && isPidAlive(bridgePid)) killTreeForce(bridgePid);
  if (servePid && isPidAlive(servePid)) killTreeForce(servePid);
  // Cleanup only the temp tree this test created, after managed processes exit.
  assert.equal(dirname(base), tmpdir());
  try { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows log handles may close later. */ }
}
