/**
 * The app→agent seam, as this blueprint hands it to an app author.
 *
 * `server.mjs` is system-owned, so the adapter handle that can enqueue agent
 * work lives somewhere the author may not edit. What they get instead is
 * `trigger` in an operation runner's toolbox, and a declared `events` list. This
 * test pins both, plus the rule that keeps the two honest:
 *
 *   EVERY TYPE A RUNNER FIRES IS DECLARED. `trigger` refuses an undeclared
 *   event type, and that refusal happens at runtime, inside an operation, in
 *   front of a user. Catching it here is the difference between a build-time
 *   failure and a feature that works until the one day it is used.
 *
 * Standard library only, run directly — no test runner.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(here, "..", "template");

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => {
  if (!cond) failures.push(label);
};

const { schema } = await import(pathToFileURL(join(templateDir, "a2app.schema.mjs")).href);

/* ------------------------------------- the declaration the adapter enforces */

const declared = new Set((schema.events ?? []).map((e) => e.type));
ok("the starter declares its event types", declared.size > 0);

// What `server.mjs` passes as the runner toolbox is the contract this file is
// really testing, so read it there rather than assuming.
const server = readFileSync(join(templateDir, "server.mjs"), "utf8");
ok("server.mjs hands runners a trigger", /runner\(args, ctx, \{[\s\S]*?trigger:/.test(server));
ok("…and declares the app's event types to the adapter", /events:\s*schema\.events/.test(server));

/* ------------------------------------------- every fired type is declared */

// Cheap and exact: the runners are source, and a literal first argument is how
// the documented shape fires. A computed type would slip past this, which is
// itself a reason for an author not to compute one.
const source = readFileSync(join(templateDir, "a2app.schema.mjs"), "utf8");
const fired = [...source.matchAll(/\btrigger\(\s*"([^"]+)"/g)].map((m) => m[1]);
ok("the starter actually demonstrates a trigger", fired.length > 0);
for (const type of fired) {
  ok(`the fired event type "${type}" is declared in schema.events`, declared.has(type));
}

/* --------------------------------------------- the worked example's shape */

const runner = schema.operationRunners?.["request-triage"];
ok("request-triage has a runner", typeof runner === "function");

if (typeof runner === "function") {
  const calls = [];
  const db = { tasks: { task_welcome: { id: "task_welcome", title: "Welcome", status: "todo" } } };
  const toolbox = {
    db,
    persist: () => {},
    trigger: (type, payload, capability) => {
      calls.push({ type, payload, capability });
      return { eventId: "ev_1", taskId: "tsk_1" };
    },
  };

  const result = runner({ task: "task_welcome" }, {}, toolbox);
  check("it enqueues exactly one task", calls.length, 1);
  check("…under a declared event type", calls[0]?.type, "task.needs_triage");
  // A capability is what turns an event into WORK. Without one the app has only
  // announced something, and no agent will ever be handed it.
  ok("…naming a capability, or nothing is queued at all", Boolean(calls[0]?.capability));
  // Ids, not prose and not a copy of the record: the agent re-reads the record
  // itself, so an embedded copy would be stale by the time it is read, and
  // embedded prose would be an instruction the app does not get to give.
  check("…sending the record's id", calls[0]?.payload, { task: "task_welcome" });
  ok(
    "…and nothing that reads as an instruction",
    !JSON.stringify(calls[0]?.payload ?? {}).match(/\b(please|you should|must|instruction|prompt)\b/i),
  );
  ok("the caller is told which task was queued", result?.queued === "tsk_1");

  // An operation acting on a record it cannot find must refuse rather than
  // queue work that names nothing.
  const missing = runner({ task: "no_such_task" }, {}, toolbox);
  check("an unknown record queues nothing", calls.length, 1);
  check("…and says so", missing?.ok, false);
}

/* ----------------------------------- the mirror an agent is told to keep */

const operations = JSON.parse(readFileSync(join(templateDir, "operations.json"), "utf8")).operations ?? [];
const mirrored = new Set(operations.map((o) => o.name));
for (const op of schema.operations ?? []) {
  ok(`operations.json mirrors "${op.name}"`, mirrored.has(op.name));
}
for (const op of operations) {
  ok(`every mirrored operation has a runner: "${op.name}"`, typeof schema.operationRunners?.[op.name] === "function");
}

if (failures.length > 0) {
  console.error(`\n✗ app→agent seam: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✓ app→agent seam: declared events, trigger in the toolbox, ids not prose, mirror in step");
