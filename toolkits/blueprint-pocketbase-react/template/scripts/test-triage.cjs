const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const loaded = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../pb/pb_hooks/operations.js"), "utf8"), { module: loaded });
const { runners } = loaded.exports;

for (const state of ["submitted", "working", "input-required", "completed", "failed", "canceled", null]) {
  const record = { id: "record", agentTask: "old", getString(key) { return this[key]; }, set(key, value) { this[key] = value; } };
  let triggers = 0, saves = 0;
  const toolbox = {
    app: { findRecordById: () => record, save: () => saves++ },
    getTask: () => state === null ? null : { status: state },
    error: (status, code, message, extra) => ({ a2appOperationError: true, status, code, message, extra }),
    trigger: (type, payload) => { triggers++; assert.equal(payload.previous, "old"); return { taskId: "new" }; },
  };
  if (["completed", "failed", "canceled"].includes(state)) {
    assert.equal(runners["request-triage"]({ task: "record" }, {}, toolbox).queued, "new");
    assert.equal(record.agentTask, "new");
    assert.equal(triggers, 1);
    assert.equal(saves, 1);
  } else {
    assert.throws(() => runners["request-triage"]({ task: "record" }, {}, toolbox),
      (e) => e.status === 409 && e.code === (state === null ? "agent_task_unavailable" : "already_queued") && e.extra.taskId === "old");
    assert.equal(triggers, 0);
    assert.equal(saves, 0);
    assert.equal(record.agentTask, "old");
  }
}
const source = fs.readFileSync(path.join(__dirname, "../pb/pb_hooks/_a2app_impl.js"), "utf8");
assert.match(source, /getTask:\s*\(id\)\s*=>\s*loadTask\(tx\.db\(\), id\)/);
console.log("triage test: refusal, terminal retries, no side effects, transaction task read pass");
