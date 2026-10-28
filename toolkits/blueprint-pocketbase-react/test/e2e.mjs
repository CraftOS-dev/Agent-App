/**
 * End to end, against a real PocketBase.
 *
 * The hooks only run inside `pocketbase serve` (Goja, not Node), so `node
 * --check` and the rules self-test cannot tell whether they work. This scaffolds
 * a fresh app with the real CLI, boots it with the launcher the pipeline uses,
 * and drives it over HTTP and through the `a2app` CLI: access from foreign
 * origins and programs, operations and approval, idempotency, the task queue
 * (claim contention, progress, completion), one open run per record, a runner
 * that throws, writes paused while operations.js cannot load, and a restart.
 *
 *   POCKETBASE_BIN=/path/to/pocketbase node test/e2e.mjs
 *
 * Needs a PocketBase 0.26.x binary and a built CLI (`pnpm -r build`). Without
 * POCKETBASE_BIN it says so and exits 0, so the workspace test run stays green
 * on machines that do not have one. E2E_SLOW=1 also waits out a claim (60 s) to
 * check that an abandoned task goes back to the queue.
 *
 * Standard library only, run directly — no test runner.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.POCKETBASE_BIN;
if (!binary) {
  console.log("pocketbase e2e: skipped (set POCKETBASE_BIN to a PocketBase 0.26.x binary to run it)");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const AGENT_APP = join(repo, "framework", "cli", "dist", "agent-app.js");
const A2APP = join(repo, "framework", "cli", "dist", "a2app.js");
if (!existsSync(AGENT_APP)) {
  console.error("pocketbase e2e: build the CLI first (pnpm -r build)");
  process.exit(1);
}

const failures = [];
let passed = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}\n         expected: ${w}\n         actual:   ${g}`);
  }
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const work = mkdtempSync(join(tmpdir(), "a2app-pb-e2e-"));
const home = join(work, "home");
const dir = join(work, "app");
const env = { ...process.env, A2APP_HOME: home };
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const own = { Origin: base };
let server = null;

try {
  execFileSync(process.execPath, [AGENT_APP, dir, "scaffold", "--blueprint", "blueprint-pocketbase-react"], { env, stdio: "pipe" });
  copyFileSync(binary, join(dir, "pb", process.platform === "win32" ? "pocketbase.exe" : "pocketbase"));
  const token = readFileSync(join(dir, ".agent-token"), "utf8").trim();
  const agent = { "X-A2App-Token": token };
  // A URL operates the app as a remote one, with the credential from the
  // environment: the port here is not the manifest's.
  const a2app = (...args) => cli(A2APP, [base, ...args], { ...env, A2APP_TOKEN: token });
  const records = `${base}/api/collections/tasks/records`;

  // App-owned additions for the rollback check: an operation that writes a
  // record, queues a task, then throws.
  const ops = JSON.parse(readFileSync(join(dir, "operations.json"), "utf8"));
  ops.operations.push({ name: "explode", description: "Write, queue, then throw.", destructive: false, module: "planning", params: {} });
  writeFileSync(join(dir, "operations.json"), JSON.stringify(ops, null, 2));
  const opsJs = join(dir, "pb", "pb_hooks", "operations.js");
  const opsSource = readFileSync(opsJs, "utf8").replace(
    "  runners: {",
    `  runners: {
    explode: (_args, _ctx, a2app) => {
      const col = a2app.app.findCollectionByNameOrId("tasks");
      const rec = new Record(col);
      rec.set("title", "should be rolled back");
      rec.set("status", "todo");
      a2app.app.save(rec);
      a2app.trigger("task.needs_triage", { task: rec.id }, "triage");
      throw new Error("boom");
    },`,
  );
  writeFileSync(opsJs, opsSource);

  await start();

  console.log("access");
  {
    const foreign = await http("GET", records, { headers: { Origin: "http://evil.example" } });
    check("a foreign origin cannot list records", [foreign.status, foreign.json?.code], [403, "forbidden_origin"]);
    ok("…and gets no CORS grant", !foreign.headers.get("access-control-allow-origin"));
    const planted = await http("POST", records, { headers: { Origin: "http://evil.example" }, json: { title: "planted", status: "todo" } });
    check("a foreign origin cannot create one", planted.status, 403);
    const rebound = await rawGet(`/api/collections/tasks/records`, { Host: `evil.example:${port}` });
    check("a rebound Host is refused", [rebound.status, rebound.json?.code], [403, "forbidden_host"]);
    const anon = await http("POST", records, { json: { title: "anon", status: "todo" } });
    check("a program cannot write without the agent token", [anon.status, anon.json?.code], [401, "agent_token_required"]);
    const wrong = await http("POST", records, { headers: { "X-A2App-Token": "nope" }, json: { title: "x", status: "todo" } });
    check("…or with a wrong one", wrong.status, 401);
    const realtime = await http("GET", `${base}/api/realtime`, { headers: { Origin: "http://evil.example" }, timeoutMs: 1500 });
    check("a foreign origin cannot open realtime", realtime.status, 403);
    const firstId = (await http("GET", records)).json.items[0].id;
    check("a program cannot PATCH without the token", (await http("PATCH", `${records}/${firstId}`, { json: { title: "x" } })).status, 401);
    check("…or DELETE", (await http("DELETE", `${records}/${firstId}`)).status, 401);
    check("a wrong token is refused even for a read", (await http("GET", records, { headers: { "X-A2App-Token": "nope" } })).status, 401);
    check("a foreign origin cannot fetch files", (await http("GET", `${base}/api/files/tasks/${firstId}/x.png`, { headers: { Origin: "http://evil.example" } })).status, 403);
    check("batch writes need the token", (await http("POST", `${base}/api/batch`, { json: { requests: [] } })).status, 401);
    check("identity answers no rebound Host", (await rawGet("/api/_a2app", { Host: `evil.example:${port}` })).status, 403);
    check("…nor does describe", (await rawGet("/api/_a2app/describe", { Host: `evil.example:${port}` })).status, 403);
    const su = JSON.parse(readFileSync(join(dir, ".superuser"), "utf8"));
    const login = await http("POST", `${base}/api/collections/_superusers/auth-with-password`, { json: { identity: su.email, password: su.password } });
    check("the superuser can sign in (an auth route)", login.status, 200);
    const asOwner = await http("POST", records, { headers: { Authorization: login.json?.token }, json: { title: "by the owner", status: "todo" } });
    check("…and write without the agent token (the dashboard)", asOwner.status, 200);
    await http("DELETE", `${records}/${asOwner.json?.id}`, { headers: { Authorization: login.json?.token } });
    check("a program can read", (await http("GET", records)).status, 200);
    check("the View (own origin) can write", (await http("POST", records, { headers: own, json: { title: "from the view", status: "todo" } })).status, 200);
    check("the agent token can write", (await http("POST", records, { headers: agent, json: { title: "from the agent", status: "todo" } })).status, 200);
  }

  const welcome = (await http("GET", `${records}?filter=${encodeURIComponent('title ~ "Welcome"')}`)).json.items[0];
  const second = (await http("GET", `${records}?filter=${encodeURIComponent('title = "from the agent"')}`)).json.items[0];

  console.log("operations");
  {
    const count = await http("POST", `${base}/api/ops/count-tasks`, { json: {} });
    check("a read-only operation answers without a credential", [count.status, count.json?.result?.count], [200, 3]);
    const anonWrite = await http("POST", `${base}/api/ops/complete-task`, { json: { task: welcome.id } });
    check("a writing operation needs a credential", anonWrite.status, 401);
    const badArgs = await http("POST", `${base}/api/ops/complete-task`, { headers: agent, json: {} });
    check("missing arguments are refused before anything runs", badArgs.status, 400);
    const explode = await http("POST", `${base}/api/ops/explode`, { headers: agent, json: {} });
    check("a runner that throws is operation_failed", [explode.status, explode.json?.code], [500, "operation_failed"]);
    const after = await http("GET", `${records}?filter=${encodeURIComponent('title = "should be rolled back"')}`);
    check("…and what it wrote is rolled back", after.json.items.length, 0);
    check("…including the task it queued", (await tasks()).length, 0);
  }

  console.log("approval");
  {
    const first = await http("POST", `${base}/api/ops/clear-done`, { headers: agent, json: {} });
    check("a destructive operation asks for approval", [first.status, first.json?.code], [428, "approval_required"]);
    const key = first.json?.approvalKey;
    const approved = await http("POST", `${base}/api/ops/clear-done`, { headers: { ...agent, "X-A2App-Approval": key }, json: {} });
    check("…and runs with the key", approved.status, 200);
    const reused = await http("POST", `${base}/api/ops/clear-done`, { headers: { ...agent, "X-A2App-Approval": key }, json: {} });
    check("…which is good once", reused.status, 428);
  }

  console.log("idempotency");
  {
    const headers = { ...agent, "Idempotency-Key": "e2e-key-1" };
    const once = await http("POST", `${base}/api/ops/request-triage`, { headers, json: { task: second.id } });
    check("a keyed call runs", once.status, 200);
    const again = await http("POST", `${base}/api/ops/request-triage`, { headers, json: { task: second.id } });
    check("…and its replay is refused", [again.status, again.json?.code], [409, "duplicate_request"]);
    const boom = { ...agent, "Idempotency-Key": "e2e-key-2" };
    const thrown = [];
    for (let i = 0; i < 2; i++) thrown.push((await http("POST", `${base}/api/ops/explode`, { headers: boom, json: {} })).status);
    check("a call that threw does not use up its key", thrown, [500, 500]);
  }

  console.log("queue");
  let firstRun;
  {
    const asked = await a2app("planning", "tasks", welcome.id, "request-triage");
    const queued = firstJson(asked.stdout)?.result?.queued;
    ok("request-triage through the a2app CLI queues a task", typeof queued === "string" && queued.startsWith("tsk_"));
    firstRun = queued;
    const record = (await http("GET", `${records}/${welcome.id}`)).json;
    check("…and the record points at it", record.agentTask, queued);
    const repeat = await http("POST", `${base}/api/ops/request-triage`, { headers: agent, json: { task: welcome.id } });
    check("asking again while it is open hands back the same task", [repeat.json?.result?.queued, repeat.json?.result?.alreadyQueued], [queued, true]);
    const fromView = await http("POST", `${base}/api/ops/request-triage`, { headers: own, json: { task: welcome.id } });
    check("…from the View too", fromView.json?.result?.queued, queued);
    check("…so there is one task per record", (await tasks()).filter((t) => t.request?.payload?.task === welcome.id).length, 1);

    const events = await http("GET", `${base}/api/_a2app/events`);
    ok("the trigger is in the event log", events.json?.events?.some((ev) => ev.type === "task.needs_triage" && ev.payload?.task === welcome.id));

    const claims = await Promise.all([0, 1].map(() => http("POST", `${base}/api/_a2app/tasks/${queued}/claim`, { headers: agent, json: {} })));
    check("two simultaneous claims: one wins, one is refused", claims.map((c) => c.status).sort(), [200, 409]);
    const progress = await a2app("tasks", "progress", queued, "--step", "Reading the record");
    check("progress through the CLI", firstJson(progress.stdout)?.progress?.step, "Reading the record");
    const done = await a2app("tasks", "complete", queued, "--result", JSON.stringify({ summary: "Split it into three steps." }));
    check("completion through the CLI", firstJson(done.stdout)?.status, "completed");
    const fresh = await http("POST", `${base}/api/ops/request-triage`, { headers: agent, json: { task: welcome.id } });
    ok("once it is done, asking again queues a new run", fresh.json?.result?.queued && fresh.json.result.queued !== queued);
    const successor = (await tasks()).find((t) => t.id === fresh.json?.result?.queued);
    check("…naming the previous one", successor?.request?.payload?.previous, queued);
  }

  console.log("app code that cannot load");
  {
    writeFileSync(opsJs, "module.exports = {{ broken");
    await restart();
    const write = await http("PATCH", `${records}/${welcome.id}`, { headers: own, json: { title: "edited" } });
    check("client writes are paused, not unguarded", write.status, 503);
    ok("…with the code", /app_code_unavailable/.test(write.json?.message ?? ""));
    ok("…saying why", /operations\.js could not be loaded/.test(write.json?.message ?? ""));
    check("reads still work", (await http("GET", records)).status, 200);
    writeFileSync(opsJs, opsSource);
    await restart();
    check("writes resume once it loads", (await http("PATCH", `${records}/${welcome.id}`, { headers: own, json: { title: "edited" } })).status, 200);
  }

  console.log("restart");
  {
    const all = await tasks();
    ok("the queue survived the restarts", all.some((t) => t.id === firstRun && t.status === "completed"));
    const open = all.find((t) => t.request?.payload?.task === welcome.id && t.status === "submitted");
    const repeat = await http("POST", `${base}/api/ops/request-triage`, { headers: agent, json: { task: welcome.id } });
    check("an open run is still recognised after a restart", repeat.json?.result?.queued, open?.id);
  }

  if (process.env.E2E_SLOW === "1") {
    console.log("abandoned claim (waits 65 s)");
    const open = (await tasks()).find((t) => t.status === "submitted");
    await http("POST", `${base}/api/_a2app/tasks/${open.id}/claim`, { headers: agent, json: {} });
    await new Promise((r) => setTimeout(r, 65_000));
    const back = (await tasks()).find((t) => t.id === open.id);
    check("a claim with no heartbeat for 60 s goes back to the queue", back?.status, "submitted");
  }
} finally {
  await stop();
  // data.db can stay locked for a moment after the process is killed (Windows).
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`\npocketbase e2e: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);

/* ----------------------------------------------------------------- helpers */

async function start() {
  server = spawn(process.execPath, ["pb-serve.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), A2APP_DATA_DIR: join(dir, "pb", "pb_data") },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    const res = await http("GET", `${base}/api/_a2app`, { timeoutMs: 500 });
    if (res.status === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`PocketBase did not come up on ${base}:\n${log}`);
}

async function stop() {
  if (!server) return;
  const pid = server.pid;
  server = null;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 40; i++) {
    const res = await http("GET", `${base}/api/_a2app`, { timeoutMs: 250 });
    if (res.status === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`PocketBase on ${base} did not stop`);
}

async function restart() {
  await stop();
  await start();
}

async function tasks() {
  return (await http("GET", `${base}/api/_a2app/tasks`)).json?.tasks ?? [];
}

/** A request that never answers (an open realtime stream, a server that is
 *  down) comes back as status 0 rather than throwing, so it fails a check
 *  instead of ending the run. */
async function http(method, url, { headers = {}, json, timeoutMs = 5000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, json: parsed };
  } catch {
    return { status: 0, headers: new Headers(), json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** fetch() drops a Host header (a forbidden header name), so the DNS-rebinding
 *  check goes through node:http, which sends what it is given. */
function rawGet(path, headers) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        done({ status: res.statusCode, json: parsed });
      });
    });
    req.on("error", fail);
    req.end();
  });
}

function cli(entry, args, childEnv) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, ...args], { env: childEnv, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function firstJson(text) {
  const at = text.indexOf("{");
  if (at === -1) return null;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}
