/// <reference path="../pb_data/types.d.ts" />
/**
 * Operation runners and the events this app may emit (AGENT-OWNED — edit this
 * to evolve the app).
 *
 * TWO FILES, ONE TRUTH: every operation is DECLARED in `operations.json` (name,
 * module, typed params, entity, appliesWhen, flags; describe and approval read
 * that) and RUN here, by a function of the same name. The gate fails a declared
 * operation with no runner here.
 *
 * The adapter serves `POST /api/ops/{name}`: it guards the arguments against the
 * declared params, asks for approval on a destructive operation (428 + an
 * approval key), and only then calls `runners[name](args, ctx, a2app)`:
 *
 *   args   the guarded arguments, as plain JS.
 *   ctx    who is calling: { credentialId, agentName, principal }.
 *   a2app  { app, trigger, error }:
 *          app      the PocketBase app to read and write through —
 *                   `a2app.app.findRecordById(...)`, `a2app.app.save(record)`.
 *                   It is a TRANSACTION: everything the runner writes, and every
 *                   task it queues, lands together or not at all. Use it, not
 *                   `$app`, and do not make slow outbound calls in here — the
 *                   transaction holds the database's write lock until you return.
 *          trigger  (type, payload, capability) — emit a declared event and, when
 *                   a capability is named, queue a task for an agent. Returns
 *                   { eventId, taskId }. An event type missing from `events`
 *                   below is refused.
 *          error    (status, code, message) — `throw a2app.error(409, "already_done",
 *                   "…")` refuses with your own status and code.
 *
 * Return a plain, JSON-able value; it is the `result` of the call. Anything a
 * runner throws becomes `operation_failed` and rolls back what it wrote.
 *
 * `readOnly` names the fields only runners write; see the note on it below.
 *
 * This file is loaded with `require()`, never as a hook file (only `*.pb.js`
 * files are), so it may declare whatever it likes at its own scope — but touch
 * PocketBase only inside a runner: at load time there is no request to serve.
 */

module.exports = {
  // The event types this app may emit (the app→agent direction). Declaring a
  // type is what lets `trigger` fire it, so this list is the fixed set of
  // things the app can ever ask an agent to react to — decided here by its
  // author, not at the moment of firing.
  //
  // Leave it empty until a feature genuinely needs agent judgment. Plain events
  // want plain code; a task is for work a person would otherwise have to think
  // about.
  events: [{ type: "task.needs_triage" }],

  // Fields only this app's runners write, by collection. PocketBase has no
  // read-only flag for a field, so it is declared here: describe publishes it
  // as readOnly, and a client write to it (the View, an agent, the records API)
  // is refused with `read_only_field`. A runner still sets it with
  // `a2app.app.save()`, and so can the owner in the PocketBase dashboard.
  //
  // `agentTask` is the reason this exists. An agent that saves a record it
  // read a minute ago would otherwise write back the old task id, and the View
  // would stop showing the run that is actually in progress.
  readOnly: { tasks: ["agentTask"] },

  runners: {
    "clear-done": (_args, _ctx, a2app) => {
      const done = a2app.app.findRecordsByFilter("tasks", "status = 'done'", "", 0, 0);
      for (let i = 0; i < done.length; i++) a2app.app.delete(done[i]);
      return { removed: done.length };
    },

    "count-tasks": (_args, _ctx, a2app) => ({ count: a2app.app.countRecords("tasks") }),

    "complete-task": (args, _ctx, a2app) => {
      const task = findTask(a2app, args.task);
      if (!task) return { ok: false, reason: "no such task" };
      task.set("status", "done");
      a2app.app.save(task);
      return { ok: true, task: task.id, status: "done" };
    },

    // The app→agent direction, in full. `trigger` emits a DECLARED event and,
    // because a capability is named, queues a task on the app's own queue. From
    // there an agent takes it — either because a harness is polling
    // (`a2app <app> tasks next --wait`) or because `agent-app <app> bridge` is
    // running and starts one.
    //
    // Send IDS, not prose. The agent re-reads the record itself, so the payload
    // carries what it needs to find the work — never instructions, and never a
    // copy of the data, which would be stale by the time it is read. Nothing
    // here can widen what the agent may do: the payload is data on the other
    // side, and the capability names the kind of work, not a command.
    //
    // Identical triggers dedupe to ONE task, even after it has finished, so
    // asking again with the same payload would hand back the old failure.
    // Naming the previous task makes each request a new occurrence. The View
    // disables the control while a run is open, so a double click cannot queue
    // two.
    //
    // The task id goes on the record so the View can show the work until it is
    // done (ui/src/AgentTask.jsx). The validate gate checks that it does.
    "request-triage": (args, _ctx, a2app) => {
      const task = findTask(a2app, args.task);
      if (!task) return { ok: false, reason: "no such task" };
      const payload = { task: task.id };
      const previous = task.getString("agentTask");
      if (previous) payload.previous = previous;
      const fired = a2app.trigger("task.needs_triage", payload, "triage");
      task.set("agentTask", fired.taskId);
      a2app.app.save(task);
      return { ok: true, task: task.id, queued: fired.taskId };
    },
  },
};

function findTask(a2app, id) {
  try {
    return a2app.app.findRecordById("tasks", String(id));
  } catch (_missing) {
    return null;
  }
}
