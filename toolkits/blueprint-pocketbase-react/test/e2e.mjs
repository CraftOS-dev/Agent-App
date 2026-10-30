/**
 * End to end, against a real PocketBase.
 *
 * The hooks only run inside `pocketbase serve` (Goja, not Node), so `node
 * --check` and the rules self-test cannot tell whether they work. This scaffolds
 * a fresh app with the real CLI, checks that the pipeline's install finds the
 * binary in place, boots the app with the launcher the pipeline uses, and
 * drives it over HTTP and through the `a2app` CLI: access from foreign
 * origins and programs, who is calling (protocol 0.2: the admin credential,
 * delegated credentials held to their scopes, device sign-in approved by the
 * View and confirmed by the agent, whose records), operations and approval,
 * idempotency, the task queue (claim contention, progress, completion, who
 * asked, the task's own credential and the one task it reaches, asking again
 * once a task is done), one open run per record, a runner that
 * throws, writes paused while operations.js cannot load, a restart, and a
 * rotated .agent-token.
 * The multi-user side is conformance/multi-user/run.mjs.
 *
 *   POCKETBASE_BIN=/path/to/pocketbase node test/e2e.mjs
 *
 * Needs the PocketBase binary the blueprint pins (v0.39.7, what `node
 * pb-serve.mjs --fetch` downloads) and a built CLI (`pnpm -r build`). Without
 * POCKETBASE_BIN it says so and exits 0, so the workspace test run stays green
 * on machines that do not have one. E2E_SLOW=1 also waits out a claim (60 s) to
 * check that an abandoned task goes back to the queue. Nothing here uses the
 * network.
 *
 * Standard library only, run directly — no test runner.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.POCKETBASE_BIN;
if (!binary) {
  console.log("pocketbase e2e: skipped (set POCKETBASE_BIN to a PocketBase 0.39.7 binary to run it)");
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

  console.log("install");
  {
    // The pipeline's install starts with `node pb-serve.mjs --fetch`. With the
    // pinned binary already in place it must download nothing, so the network
    // is switched off for this run: an attempt to download fails the check.
    const offline = `data:text/javascript,${encodeURIComponent("globalThis.fetch = () => Promise.reject(new Error('the network is off in this test'));")}`;
    const fetched = await cli(join(dir, "pb-serve.mjs"), ["--fetch"], env, ["--import", offline]);
    check("with the pinned PocketBase in place, install's fetch downloads nothing", [fetched.code, fetched.stderr.trim()], [0, ""]);

    // Anything else at that path is replaced, judged by its SHA-256 and never
    // run: a binary that came inside a package must not be executed to ask its
    // version. Offline, the replacement fails instead of downloading.
    const bin = join(dir, "pb", process.platform === "win32" ? "pocketbase.exe" : "pocketbase");
    const pinned = readFileSync(bin);
    writeFileSync(bin, "not the pinned binary");
    const planted = await cli(join(dir, "pb-serve.mjs"), ["--fetch"], env, ["--import", offline]);
    ok("a binary that is not the pinned one is not kept", planted.code !== 0 && /could not download/.test(planted.stderr));
    writeFileSync(bin, pinned);
  }

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

  console.log("who is calling");
  {
    const id = (await http("GET", `${base}/api/_a2app`)).json;
    check("identity speaks 0.2 and names its mode and account page", [id?.protocol, id?.authMode, id?.accountUrl], ["0.2", "none", "/_a2app/account"]);
    const page = await http("GET", `${base}/_a2app/account`);
    check("the account page is served", [page.status, page.headers.get("content-type")?.split(";")[0]], [200, "text/html"]);
    const asAgent = (await http("GET", `${base}/api/_a2app/whoami`, { headers: agent })).json;
    check(
      "the agent token is the admin credential, acting as the owner",
      [asAgent?.credentialId, asAgent?.principal, asAgent?.principalName, asAgent?.role, asAgent?.expiresAt, asAgent?.scopes],
      ["cred_local", "owner", "Owner", "owner", null, ["data:tasks:read", "data:tasks:write", "op:clear-done", "op:complete-task", "op:count-tasks", "op:explode", "op:request-triage"]],
    );
    const asView = (await http("GET", `${base}/api/_a2app/whoami`, { headers: { "Sec-Fetch-Site": "same-origin" } })).json;
    check("the View is the owner", [asView?.credentialId, asView?.principal, asView?.role], ["ui", "owner", "owner"]);
    check("an anonymous program may read and run read-only operations", (await http("GET", `${base}/api/_a2app/whoami`)).json?.scopes, ["data:tasks:read", "op:count-tasks"]);
    check("a wrong token is told it is not this app's", (await http("GET", records, { headers: { "X-A2App-Token": "nope" } })).json?.code, "credential_invalid");
    check("a single-user app has no accounts", (await http("GET", `${base}/api/_a2app/session`)).json?.code, "not_multi_user");
    check("…nor invites", (await http("POST", `${base}/api/_a2app/invites`, { headers: agent, json: { role: "member" } })).json?.code, "not_multi_user");

    const someId = (await http("GET", records)).json.items[0].id;
    const issued = await http("POST", `${base}/api/_a2app/credentials`, { headers: own, json: { agentName: "e2e reader", scopes: ["data:tasks:read"], expiresIn: 3600 } });
    check("the View issues a credential", [issued.status, issued.json?.credential?.principal, /^a2a_[A-Za-z0-9_-]{43}$/.test(issued.json?.token ?? "")], [201, "owner", true]);
    const reader = { "X-A2App-Token": issued.json?.token };
    check("it reads", (await http("GET", records, { headers: reader })).status, 200);
    check("…writes nothing it was not given", (await http("POST", records, { headers: reader, json: { title: "x", status: "todo" } })).json?.code, "insufficient_scope");
    check("…runs no operation it was not given", (await http("POST", `${base}/api/ops/complete-task`, { headers: reader, json: { task: someId } })).json?.code, "insufficient_scope");
    check("…and opens no realtime stream", (await http("GET", `${base}/api/realtime`, { headers: reader, timeoutMs: 1500 })).status, 403);
    check("an agent's credential manages nothing", (await http("GET", `${base}/api/_a2app/credentials`, { headers: reader })).json?.code, "not_a_manager");
    const listed = (await http("GET", `${base}/api/_a2app/credentials`, { headers: { "Sec-Fetch-Site": "same-origin" } })).json?.credentials ?? [];
    ok("the View lists it, never its token", listed.some((c) => c.credentialId === issued.json?.credential?.credentialId) && !JSON.stringify(listed).includes(issued.json?.token));
    ok("…and never the admin credential", !listed.some((c) => c.credentialId === "cred_local"));
    check("the View revokes it", (await http("DELETE", `${base}/api/_a2app/credentials/${issued.json?.credential?.credentialId}`, { headers: own })).status, 200);
    check("…and it stops working", (await http("GET", records, { headers: reader })).json?.code, "credential_revoked");

    const view = { "Sec-Fetch-Site": "same-origin" };
    const poll = (deviceCode, confirmation) => http("POST", `${base}/api/_a2app/auth/token`, { json: confirmation === undefined ? { deviceCode } : { deviceCode, confirmation } });
    const started = (await http("POST", `${base}/api/_a2app/auth/device`, { json: { agentName: "e2e device", scopes: ["data:tasks:read"] } })).json;
    ok("an agent asks to sign in", /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(started?.userCode ?? ""));
    ok("…with a link to approve it", started?.verificationUriComplete === `${base}/_a2app/account#approve/${started?.userCode}`);
    check("…and is told to wait", (await poll(started?.deviceCode)).json?.code, "authorization_pending");
    const review = (await http("GET", `${base}/api/_a2app/auth/device/${started?.userCode}`, { headers: view })).json;
    ok("the View sees when it was asked, and that no agent waits on this computer", Date.parse(review?.requestedAt) <= Date.now() && review?.loopback === false);
    const approval = (await http("POST", `${base}/api/_a2app/auth/device/${started?.userCode}`, { headers: own, json: { approve: true } })).json;
    check("the View approves it", approval?.status, "approved");
    ok("…and is given a confirmation code, with nowhere to send it", /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(approval?.confirmation ?? "") && approval?.redirect === null);
    check("approval alone hands nothing over, at once", (await poll(started?.deviceCode)).json?.code, "confirmation_required");
    check("…nor does a wrong code", (await poll(started?.deviceCode, "BBBB-BBBB")).json?.code, "confirmation_invalid");
    const got = await poll(started?.deviceCode, approval?.confirmation?.replace("-", "").toLowerCase());
    check("the agent with the code (any case, any dash) receives a credential for the owner", [got.status, got.json?.credential?.principal, got.json?.credential?.scopes], [200, "owner", ["data:tasks:read"]]);
    check("…once", (await poll(started?.deviceCode, approval?.confirmation)).json?.code, "expired_token");

    const guessed = (await http("POST", `${base}/api/_a2app/auth/device`, { json: {} })).json;
    await http("POST", `${base}/api/_a2app/auth/device/${guessed?.userCode}`, { headers: own, json: { approve: true } });
    for (let i = 0; i < 4; i++) await poll(guessed?.deviceCode, "BBBB-BBBB");
    check("five wrong confirmation codes void the request", (await poll(guessed?.deviceCode, "BBBB-BBBB")).json?.code, "access_denied");
    check("…for good", (await poll(guessed?.deviceCode)).json?.code, "expired_token");

    check("a loopback port must be a real one", (await http("POST", `${base}/api/_a2app/auth/device`, { json: { loopbackPort: 80 } })).json?.code, "usage");
    const local = (await http("POST", `${base}/api/_a2app/auth/device`, { json: { agentName: "e2e local", loopbackPort: 53682 } })).json;
    check("an agent on this computer is shown as such", (await http("GET", `${base}/api/_a2app/auth/device/${local?.userCode}`, { headers: view })).json?.loopback, true);
    const sent = (await http("POST", `${base}/api/_a2app/auth/device/${local?.userCode}`, { headers: own, json: { approve: true } })).json;
    check("approval sends the browser back to the agent's port, with the code", sent?.redirect, `http://127.0.0.1:53682/a2app/callback?confirmation=${sent?.confirmation}`);
    check("…which completes the sign-in", (await poll(local?.deviceCode, sent?.confirmation)).status, 200);

    const created = await http("POST", records, { headers: agent, json: { title: "owned", status: "todo" } });
    check("a record is its creator's: here, the owner's", created.json?.owner, "owner");
    const reowned = await http("PATCH", `${records}/${created.json?.id}`, { headers: own, json: { owner: "someone" } });
    ok("…and whose it is is not a client's to write", reowned.status === 400 && /read_only_field/.test(reowned.json?.message ?? ""));
    const described = (await http("GET", `${base}/api/_a2app/describe/planning/tasks`)).json;
    check("describe says so", [described?.ownedBy, described?.fields?.owner?.readOnly], ["owner", true]);
    // A fresh database names itself "Acme" in PocketBase's settings; the app's
    // name is the manifest's, on the root screen as in its identity.
    const root = (await http("GET", `${base}/api/_a2app/describe`)).json;
    const identity = (await http("GET", `${base}/api/_a2app`)).json;
    check("the root screen names the app as its identity does", root?.app, identity?.app);
    await http("DELETE", `${records}/${created.json?.id}`, { headers: agent });
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
    check("the task records who asked", (await tasks()).find((t) => t.id === queued)?.request?.principal, "owner");

    const taskCred = await http("POST", `${base}/api/_a2app/tasks/${queued}/credential`, { headers: agent, json: { agentName: "bridge:e2e" } });
    check(
      "the admin credential issues the task's own credential",
      [taskCred.status, taskCred.json?.credential?.principal, taskCred.json?.credential?.task, taskCred.json?.credential?.scopes],
      [201, "owner", queued, ["data:tasks:read", "data:tasks:write"]],
    );
    ok("…for an hour at most", Date.parse(taskCred.json?.credential?.expiresAt) <= Date.now() + 3_600_000 + 5_000);
    const taskAgent = { "X-A2App-Token": taskCred.json?.token };
    check("…which reads the records", (await http("GET", records, { headers: taskAgent })).status, 200);
    check("…and holds only what its capability declares", (await http("POST", `${base}/api/ops/complete-task`, { headers: taskAgent, json: { task: welcome.id } })).json?.code, "insufficient_scope");
    // Every caller of a single-user app is the owner and reaches every task; a
    // task credential reaches its own task only (spec/v0_2/auth.md §6.3).
    const other = (await tasks()).find((t) => t.request?.payload?.task === second.id)?.id;
    ok("another task is queued (by the idempotency check)", typeof other === "string" && other !== queued);
    check("…which the task's credential cannot read", (await http("GET", `${base}/api/_a2app/tasks/${other}`, { headers: taskAgent })).json?.code, "task_not_found");
    check("…nor claim", (await http("POST", `${base}/api/_a2app/tasks/${other}/claim`, { headers: taskAgent, json: {} })).json?.code, "task_not_found");
    check("…nor list", (await http("GET", `${base}/api/_a2app/tasks`, { headers: taskAgent })).json?.tasks?.map((t) => t.id), [queued]);
    check("…while it reads its own", (await http("GET", `${base}/api/_a2app/tasks/${queued}`, { headers: taskAgent })).json?.id, queued);

    const events = await http("GET", `${base}/api/_a2app/events`);
    ok("the trigger is in the event log", events.json?.events?.some((ev) => ev.type === "task.needs_triage" && ev.payload?.task === welcome.id));

    const claims = await Promise.all([0, 1].map(() => http("POST", `${base}/api/_a2app/tasks/${queued}/claim`, { headers: agent, json: {} })));
    check("two simultaneous claims: one wins, one is refused", claims.map((c) => c.status).sort(), [200, 409]);
    const progress = await a2app("tasks", "progress", queued, "--step", "Reading the record");
    check("progress through the CLI", firstJson(progress.stdout)?.progress?.step, "Reading the record");
    const done = await a2app("tasks", "complete", queued, "--result", JSON.stringify({ summary: "Split it into three steps." }));
    check("completion through the CLI", firstJson(done.stdout)?.status, "completed");
    check("the task's credential dies with it", (await http("GET", records, { headers: taskAgent })).json?.code, "credential_revoked");
    check("…and none is issued for a finished task", (await http("POST", `${base}/api/_a2app/tasks/${queued}/credential`, { headers: agent })).json?.code, "task_not_claimable");
    const fresh = await http("POST", `${base}/api/ops/request-triage`, { headers: agent, json: { task: welcome.id } });
    ok("once it is done, asking again queues a new run", fresh.json?.result?.queued && fresh.json.result.queued !== queued);
    const successor = (await tasks()).find((t) => t.id === fresh.json?.result?.queued);
    check("…for the same request, waiting to be taken", [successor?.request?.payload, successor?.status], [{ task: welcome.id }, "submitted"]);
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

    // The admin credential is the .agent-token file: a rotated file replaces it
    // at the next boot. (The next section restarts on the original again.)
    const rotated = "a2app_" + randomBytes(24).toString("hex");
    writeFileSync(join(dir, ".agent-token"), rotated + "\n");
    await restart();
    check("a rotated .agent-token retires the old one", (await http("GET", `${base}/api/_a2app/whoami`, { headers: agent })).json?.code, "credential_invalid");
    check("…and is the admin credential from the next boot", (await http("GET", `${base}/api/_a2app/whoami`, { headers: { "X-A2App-Token": rotated } })).json?.credentialId, "cred_local");
    writeFileSync(join(dir, ".agent-token"), token + "\n");
  }

  console.log("reached at a public URL");
  {
    await stop();
    const exposed = await launchOnce({ A2APP_HOST: "0.0.0.0" });
    ok("a network bind without an https public URL refuses to start", exposed.code !== 0 && /A2APP_PUBLIC_URL/.test(exposed.output));
    const clear = await launchOnce({ A2APP_PUBLIC_URL: "http://crm.example.com" });
    ok("a plain-http public name refuses to start", clear.code !== 0 && /https/.test(clear.output));

    await start({ A2APP_PUBLIC_URL: "https://crm.example.com" });
    const pub = { Host: "crm.example.com" };
    check("the public host is answered", (await rawRequest("GET", "/api/_a2app", pub)).status, 200);
    check("…and its records read", (await rawRequest("GET", "/api/collections/tasks/records", pub)).status, 200);
    const viewWrite = await rawRequest("POST", "/api/collections/tasks/records", { ...pub, Origin: "https://crm.example.com" }, { title: "from the public View", status: "todo" });
    check("the View at the public origin can write", viewWrite.status, 200);
    const cors = await http("GET", records, { headers: { Origin: "https://crm.example.com" } });
    check("CORS answers the public origin", cors.headers.get("access-control-allow-origin"), "https://crm.example.com");
    check("another host is still refused", (await rawRequest("GET", "/api/_a2app", { Host: "evil.example" })).status, 403);
    check("an http origin on the public name is not the app's", (await rawRequest("POST", "/api/collections/tasks/records", { ...pub, Origin: "http://crm.example.com" }, { title: "x", status: "todo" })).status, 403);
    await stop();
    await start();
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

function launchEnv(extra = {}) {
  const env = { ...process.env, PORT: String(port), A2APP_DATA_DIR: join(dir, "pb", "pb_data"), ...extra };
  for (const key of ["A2APP_HOST", "A2APP_PUBLIC_URL"]) if (!(key in extra)) delete env[key];
  return env;
}

/** Run the launcher with `extra` env and wait for it to exit (for a launch that must refuse). */
function launchOnce(extra) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["pb-serve.mjs"], { cwd: dir, env: launchEnv(extra), windowsHide: true });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

async function start(extra = {}) {
  server = spawn(process.execPath, ["pb-serve.mjs"], {
    cwd: dir,
    env: launchEnv(extra),
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

/** fetch() drops a Host header (a forbidden header name), so the host checks
 *  go through node:http, which sends what it is given. */
function rawGet(path, headers) {
  return rawRequest("GET", path, headers);
}

function rawRequest(method, path, headers, json) {
  return new Promise((done, fail) => {
    const body = json === undefined ? null : JSON.stringify(json);
    const all = body === null ? headers : { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    const req = request({ host: "127.0.0.1", port, path, method, headers: all }, (res) => {
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
    req.end(body ?? undefined);
  });
}

function cli(entry, args, childEnv, nodeArgs = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...nodeArgs, entry, ...args], { env: childEnv, windowsHide: true });
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
