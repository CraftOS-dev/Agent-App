/** #12: an app that queues agent work must not be handed off with nothing to
 * pick that work up, while looking healthy. Drives the real CLIs and real
 * detached processes against a wire-level app (delivery-fixture.mjs). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freeEphemeralPort } from "../dist/lib/net.js";
import { inspectAgentWork, inspectLocalBridge } from "../dist/lib/delivery.js";
import { isPidAlive, killTreeForce } from "../dist/lib/proc.js";
import { writeSystemHashes } from "../dist/lib/canon.js";
import { register } from "../dist/lib/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/agent-app.js");
const base = mkdtempSync(join(tmpdir(), "a2app-delivery-"));
const dir = join(base, "app with spaces");
const home = join(base, "home");
mkdirSync(join(dir, ".a2app"), { recursive: true });
mkdirSync(home);
const env = { ...process.env, A2APP_HOME: home };
const port = await freeEphemeralPort();
const baseUrl = `http://127.0.0.1:${port}`;
writeFileSync(
  join(dir, "manifest.json"),
  JSON.stringify({
    id: "delivery_test", name: "Delivery Test", agentAppVersion: "0.1.0", adapterVersion: "0.1.0",
    authMode: "none", modules: [{ name: "work" }], port,
    pipeline: { install: "", build: "", start: `"${process.execPath}" server.mjs`, health: "/api/_a2app" },
  }),
);
writeFileSync(join(dir, ".agent-token"), "delivery_test_credential\n");
copyFileSync(join(here, "delivery-fixture.mjs"), join(dir, "server.mjs"));
writeSystemHashes(dir, ["manifest.json"]);

// The fixture reads this file on every request; replace it whole, never in place.
const statePath = join(dir, "state.json");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= 40) throw err;
      await pause(10);
    }
  }
}
const readState = () => retry(() => JSON.parse(readFileSync(statePath, "utf8")));
async function writeState(state) {
  const tmp = `${statePath}.test.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  await retry(() => renameSync(tmp, statePath));
}
await writeState({ tasks: [] });

const mock = join(base, "harness.mjs");
writeFileSync(mock, 'console.log("summary: delivered");\n');
const profiles = (routes) =>
  writeFileSync(join(home, "harnesses.json"), JSON.stringify({ version: 1, default: "delivery", harnesses: [{ id: "delivery", routes }] }));
profiles([{ mode: "headless", command: process.execPath, args: [mock, "{prompt}"] }]);
const task = (id) => ({
  id, app: "delivery_test", event: null, status: "submitted",
  request: { capability: "summarize", payload: { text: "deliver me" } },
  claim: null, progress: {}, result: null, reason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
const statusOf = async (id) => (await readState()).tasks.find((t) => t.id === id)?.status;
const addTask = async (id) => {
  const state = await readState();
  await writeState({ ...state, tasks: [...state.tasks, task(id)] });
};

function cli(args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killTreeForce(child.pid);
      reject(new Error(`CLI timed out: ${args.join(" ")}\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}
async function run(args, want = 0) {
  const r = await cli(args);
  assert.equal(r.code, want, `${args.join(" ")} exited ${r.code}\n${r.stderr}\n${r.stdout}`);
  return r;
}
const json = (r) => JSON.parse(r.stdout);
async function until(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error("condition did not become true in time");
}
const rowOf = (stdout, name) => stdout.split("\n").find((l) => l.includes(` ${name} `)) ?? "";
const bridgePath = join(dir, ".a2app", "bridge.json");

let bridgePid = null;
let servePid = null;
try {
  // ---- launch with nothing queued: quiet -------------------------------------
  const first = await run([dir, "serve"]);
  servePid = json(first).pid;
  const fresh = json(first).agentWork;
  assert.equal(fresh.bridge, "none");
  assert.equal(fresh.tasksWaiting, 0);
  assert.equal(fresh.queuesAgentWork, false);
  assert.doesNotMatch(first.stderr, /bridge/);
  assert.equal(existsSync(bridgePath), false, "serve never starts a bridge");

  // ---- work waits, nothing will take it: one warning with the command --------
  await writeState({ tasks: [task("waiting_1")] });
  const warned = await run([dir, "serve"]);
  assert.equal(json(warned).alreadyRunning, true);
  assert.equal(json(warned).agentWork.tasksWaiting, 1);
  assert.equal(json(warned).agentWork.queuesAgentWork, true);
  const warnLines = warned.stderr.split("\n").filter((l) => l.startsWith("⚠"));
  assert.equal(warnLines.length, 1, warned.stderr);
  // The ref the caller typed, double-quoted for every shell; never single quotes.
  assert.ok(warnLines[0].includes(`agent-app "${dir}" bridge start`), warnLines[0]);
  assert.doesNotMatch(warned.stderr, /'/);

  // A second, stopped app: registered, never served — even with a stale record.
  const quietDir = join(base, "quiet");
  mkdirSync(join(quietDir, ".a2app"), { recursive: true });
  writeFileSync(join(quietDir, "manifest.json"), JSON.stringify({
    id: "quiet_app", name: "Quiet App", agentAppVersion: "0.1.0", adapterVersion: "0.1.0", authMode: "none",
    modules: [{ name: "work" }], port: await freeEphemeralPort(),
    pipeline: { install: "", build: "", start: "node nothing.mjs", health: "/api/_a2app" },
  }));
  writeFileSync(join(quietDir, ".a2app", "bridge.json"), JSON.stringify({ pid: 999999, harness: "x", mode: "headless" }));
  process.env.A2APP_HOME = home;
  await register({ id: "quiet_app", name: "Quiet App", path: quietDir });

  const listed = await run(["list"]);
  assert.match(rowOf(listed.stdout, "Delivery Test"), /bridge:none {2}waiting:1/);
  assert.doesNotMatch(rowOf(listed.stdout, "Quiet App"), /bridge:|waiting:/, "a stopped app shows no agent-work markers");
  assert.doesNotMatch(listed.stderr, /Quiet App|quiet_app/, "a stopped app gets no warning");
  assert.match(listed.stderr, /⚠ "Delivery Test": 1 agent task waiting and no bridge is running\. Start one: agent-app "Delivery Test" bridge start/);
  assert.equal(listed.stderr.split("\n").filter((l) => l.includes("bridge:running|stale|none")).length, 1, "one legend line");
  const rows = json(await run(["list", "--json"])).apps;
  const row = rows.find((a) => a.id === "delivery_test");
  assert.equal(row.status, "running");
  assert.equal(row.agentWork.tasksWaiting, 1);
  assert.equal(rows.find((a) => a.id === "quiet_app").agentWork, null, "stopped apps are not inspected");

  const status = json(await run([dir, "bridge"]));
  assert.equal(status.running, null);
  assert.equal(status.tasksWaiting, 1);
  assert.equal(status.agentWork.baseUrl, baseUrl);

  // A one-shot pass delivers what is there now — and leaves nothing running.
  await run([dir, "bridge", "start", "--once"]);
  assert.equal(await statusOf("waiting_1"), "completed");
  assert.equal(existsSync(bridgePath), false);

  // Subscribe-only routes do not manufacture a local process or claim work.
  await writeState({ tasks: [task("later")] });
  profiles([{ mode: "subscribe", hint: "Keep the harness's own polling loop running" }]);
  const subscribed = json(await run([dir, "bridge", "start"]));
  assert.equal(subscribed.started, false);
  assert.equal(subscribed.mode, "subscribe");
  assert.equal(json(await run([dir, "bridge"])).running, null);
  assert.equal(await statusOf("later"), "submitted");
  profiles([{ mode: "headless", command: process.execPath, args: [mock, "{prompt}"] }]);

  // ---- stale records ----------------------------------------------------------
  for (const record of [{ pid: 0 }, { pid: -1 }, { pid: 1 }, { pid: 1.5 }, { pid: "123" }, null]) {
    writeFileSync(bridgePath, JSON.stringify(record));
    assert.equal(inspectLocalBridge(dir).bridge, "stale");
    assert.equal(inspectLocalBridge(dir).running, null);
  }
  const dead = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  const deadPid = dead.pid;
  await new Promise((r) => dead.on("close", r));
  writeFileSync(bridgePath, JSON.stringify({ pid: deadPid, harness: "delivery", mode: "headless", baseUrl }));

  // ...on an app with work waiting: a warning that names the restart.
  const staleList = await run(["list"]);
  assert.match(rowOf(staleList.stdout, "Delivery Test"), /bridge:stale {2}waiting:1/);
  assert.match(staleList.stderr, /"Delivery Test": 1 agent task waiting; its bridge is no longer running\. Restart it: agent-app "Delivery Test" bridge start/);

  // ...on an app that has never queued anything: one info line, no warning.
  await writeState({ tasks: [] });
  const staleQuiet = await run([dir, "serve"]);
  assert.equal(json(staleQuiet).agentWork.bridge, "stale");
  assert.equal(json(staleQuiet).agentWork.queuesAgentWork, false);
  assert.doesNotMatch(staleQuiet.stderr, /⚠/);
  const info = staleQuiet.stderr.split("\n").filter((l) => /bridge/.test(l));
  assert.deepEqual(info, [`ℹ stale bridge record (pid ${deadPid}); agent-app "${dir}" bridge stop clears it`]);
  const staleQuietList = await run(["list"]);
  assert.match(rowOf(staleQuietList.stdout, "Delivery Test"), /bridge:stale {2}waiting:0/);
  assert.doesNotMatch(staleQuietList.stderr, /⚠/);
  // ...and `bridge stop` is what clears it, including an unreadable one.
  assert.equal(json(await run([dir, "bridge", "stop"])).cleared, true);
  writeFileSync(bridgePath, "{not json");
  assert.equal(json(await run([dir, "bridge", "stop"])).cleared, true);
  assert.equal(existsSync(bridgePath), false);

  // ---- an unreadable queue is never an empty one -----------------------------
  for (const queueMode of ["forbidden", "malformed", "bad-task", "hang", "hang-body"]) {
    await writeState({ tasks: [], queueMode });
    const started = Date.now();
    const work = await inspectAgentWork(dir, "delivery_test", baseUrl, { identityVerified: true, timeoutMs: 200 });
    assert.equal(work.tasksWaiting, null, queueMode);
    assert.equal(work.queuesAgentWork, null, queueMode);
    assert.ok(Date.now() - started < 1500, `${queueMode} probe is bounded`);
  }
  // A history too big to read still holds tasks; the waiting ones are counted.
  await writeState({ tasks: [task("big_1"), { ...task("big_2"), status: "completed" }], queueMode: "huge" });
  const huge = await inspectAgentWork(dir, "delivery_test", baseUrl);
  assert.equal(huge.queuesAgentWork, true);
  assert.equal(huge.tasksWaiting, 1);

  // A stranger on the port never receives the app's credential.
  await writeState({ tasks: [task("stranger")], appId: "different_app" });
  const before = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").length;
  assert.equal((await inspectAgentWork(dir, "delivery_test", baseUrl)).tasksWaiting, null);
  const seen = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").slice(before).map((l) => JSON.parse(l));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/api/_a2app");
  assert.equal(seen[0].credential, false);
  await writeState({ tasks: [task("live_only")] });

  // ---- dev pin ------------------------------------------------------------------
  let devTaskReads = 0;
  const devServer = createServer((req, res) => {
    if (req.url.includes("tasks")) devTaskReads++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ a2app: true, protocol: "0.1", app: { id: "delivery_test" }, tasks: [] }));
  });
  await new Promise((r) => devServer.listen(0, "127.0.0.1", r));
  const devUrl = `http://127.0.0.1:${devServer.address().port}`;
  const devRecord = join(dir, ".a2app", "dev.json");
  try {
    writeFileSync(devRecord, JSON.stringify({ pid: process.pid, port: devServer.address().port, url: devUrl, bootDir: join(dir, ".a2app/dev/t"), startedAt: new Date().toISOString(), healthy: true }));
    // Status reads the live app, never dev.
    for (const args of [[dir, "serve"], [dir, "bridge"]]) assert.equal(json(await run(args)).agentWork.tasksWaiting, 1);
    assert.equal(devTaskReads, 0);
    // A background bridge started now would watch dev: refused, with the way out.
    const refused = await run([dir, "bridge", "start"], 1);
    assert.equal(json(refused).reason, "dev_instance_up");
    assert.match(refused.stderr, /bridge start --once/);
    assert.equal(existsSync(bridgePath), false);
    // Trying the change on dev stays allowed.
    const once = json(await run([dir, "bridge", "start", "--once"]));
    assert.equal(once.once, true);
    assert.ok(devTaskReads > 0, "the one-shot pass read dev's queue");
    assert.equal(await statusOf("live_only"), "submitted", "and left live alone");

    // A live bridge recorded against dev: alive, and not serving this app.
    writeFileSync(bridgePath, JSON.stringify({ pid: process.pid, harness: "delivery", mode: "headless", intervalMs: 250, startedAt: "", baseUrl: devUrl }));
    const wrong = await run([dir, "serve"]);
    assert.equal(json(wrong).agentWork.bridgeTarget, "other");
    assert.match(wrong.stderr, /⚠ the bridge \(pid \d+\) takes work from http:\/\/127\.0\.0\.1:\d+, not from this app/);
    assert.match(rowOf((await run(["list"])).stdout, "Delivery Test"), /bridge:wrong-target {2}waiting:1/);
    rmSync(devRecord);
    const mismatch = await run([dir, "bridge", "start"], 1);
    assert.equal(json(mismatch).alreadyRunning, true);
    assert.equal(json(mismatch).ok, false);
    assert.match(mismatch.stderr, /already running .* but it takes work from/);
    assert.doesNotMatch(mismatch.stderr, /✓/);

    // A record from an older agent-app (no target): one hint, not a warning.
    writeFileSync(bridgePath, JSON.stringify({ pid: process.pid, harness: "delivery", mode: "headless", intervalMs: 250, startedAt: "" }));
    const legacy = await run([dir, "bridge"]);
    assert.equal(json(legacy).agentWork.bridgeTarget, "unknown");
    assert.match(legacy.stderr, /restart it to record its target/);
    assert.doesNotMatch(legacy.stderr, /⚠/);
    assert.equal(json(await run([dir, "bridge", "start"])).alreadyRunning, true);
  } finally {
    // Never `bridge stop` these records: their pid is this test process.
    rmSync(bridgePath, { force: true });
    rmSync(devRecord, { force: true });
    await new Promise((r) => devServer.close(r));
  }

  // ---- the hand-off: a detached bridge outlives the command that started it ----
  const started = json(await run([dir, "bridge", "start", "--interval", "250"]));
  bridgePid = started.pid;
  assert.equal(started.baseUrl, baseUrl);
  assert.ok(isPidAlive(bridgePid));
  const reused = json(await run([dir, "bridge", "start"]));
  assert.equal(reused.alreadyRunning, true);
  assert.equal(reused.pid, bridgePid);
  await until(async () => (await statusOf("live_only")) === "completed");
  await addTask("after_session");
  await until(async () => (await statusOf("after_session")) === "completed");
  const happy = await run([dir, "serve"]);
  assert.equal(json(happy).agentWork.bridgeTarget, "live");
  assert.match(happy.stderr, new RegExp(`✓ bridge running \\(pid ${bridgePid}, delivery via headless\\) · 0 waiting`));
  assert.doesNotMatch(happy.stderr, /⚠|verif/i);
  assert.match(rowOf((await run(["list"])).stdout, "Delivery Test"), /bridge:running {2}waiting:0/);

  // Stopping the app leaves the bridge up, says so, and it resumes after.
  const stopped = await run([dir, "stop"]);
  servePid = null;
  assert.match(stopped.stderr, new RegExp(`the bridge \\(pid ${bridgePid}\\) keeps running`));
  assert.ok(stopped.stderr.includes(`agent-app "${dir}" bridge stop`));
  assert.equal(json(stopped).bridge.running.pid, bridgePid);
  assert.ok(isPidAlive(bridgePid));
  await addTask("after_restart");
  servePid = json(await run([dir, "serve"])).pid;
  await until(async () => (await statusOf("after_restart")) === "completed");

  const bridgeStopped = await run([dir, "bridge", "stop"]);
  assert.equal(json(bridgeStopped).stopped, bridgePid);
  bridgePid = null;
  assert.match(rowOf((await run(["list"])).stdout, "Delivery Test"), /bridge:none {2}waiting:0/);

  // A bridge that dies without `bridge stop`, on an app that queues work.
  bridgePid = json(await run([dir, "bridge", "start", "--interval", "250"])).pid;
  killTreeForce(bridgePid);
  await until(() => !isPidAlive(bridgePid));
  bridgePid = null;
  const crashed = await run([dir, "serve"]);
  assert.equal(json(crashed).agentWork.bridge, "stale");
  assert.match(crashed.stderr, /⚠ the bridge \(pid \d+\) is no longer running, so new agent tasks will wait\. Restart it: agent-app ".*" bridge start/);
  await run([dir, "bridge", "stop"]);

  console.log("✓ delivery: quiet launch, waiting-work warnings, stopped apps quiet, stale records, dev pin, detached hand-off");
} finally {
  if (bridgePid && isPidAlive(bridgePid)) killTreeForce(bridgePid);
  if (servePid && isPidAlive(servePid)) killTreeForce(servePid);
  // Only ever the temp tree this test made; a failed guard skips cleanup rather
  // than throwing over the error that got us here.
  if (dirname(base) === resolve(tmpdir())) {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* a just-exited process may still hold a log handle on Windows */
    }
  }
}
