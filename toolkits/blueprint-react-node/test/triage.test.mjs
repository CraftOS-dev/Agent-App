import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triageFixture } from "./triage-fixture.mjs";

for (const status of ["submitted", "working", "input-required", "completed", "failed", "canceled"]) {
  const f = triageFixture();
  const first = await f.ask();
  assert.equal(first.status, 200);
  const id = first.json.result.queued;
  const task = f.app.store.getTask(id);
  task.status = status;
  f.app.store.saveTask(task);
  const before = JSON.stringify(f.binding.getRecord("tasks", "task_welcome"));
  const events = f.app.store.eventsSince(null).events.length;
  const second = await f.ask();
  if (["submitted", "working", "input-required"].includes(status)) {
    assert.equal(second.status, 409, status);
    assert.equal(second.json.code, "already_queued");
    assert.equal(second.json.taskId, id);
    assert.equal(f.app.store.listTasks().length, 1);
    assert.equal(f.app.store.eventsSince(null).events.length, events);
    assert.equal(JSON.stringify(f.binding.getRecord("tasks", "task_welcome")), before);
  } else {
    assert.equal(second.status, 200, status);
    assert.notEqual(second.json.result.queued, id);
    assert.equal(f.app.store.getTask(second.json.result.queued).request.payload.previous, id);
  }
}
{
  const f = triageFixture();
  const results = await Promise.all([f.ask(), f.ask()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.app.store.listTasks().length, 1);
}
{
  const f = triageFixture();
  f.binding.getRecord("tasks", "task_welcome").agentTask = "missing";
  assert.equal((await f.ask()).json.code, "agent_task_unavailable");
  assert.equal(f.app.store.listTasks().length, 0);
  assert.equal(f.app.store.eventsSince(null).events.length, 0);
  f.toolbox.getTask = () => { throw new Error("queue read failed"); };
  const failed = await f.ask();
  assert.equal(failed.status, 500);
  assert.equal(failed.json.code, "operation_failed");
  assert.equal(f.app.store.listTasks().length, 0);
}
// Pin the system-owned wiring too: unit fixtures must not mask a missing seam.
const server = readFileSync(new URL("../template/server.mjs", import.meta.url), "utf8");
assert.match(server, /getTask:\s*\(id\)\s*=>\s*a2app\.store\.getTask\(id\)/);
assert.match(server, /new OperationError\(code, message, status, extra\)/);
console.log("✓ triage: HTTP refusal, terminal retries, no side effects, concurrent requests");
