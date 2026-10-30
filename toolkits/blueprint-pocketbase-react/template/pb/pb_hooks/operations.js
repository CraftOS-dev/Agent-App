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
 *   ctx    who is calling: { credentialId, agentName, principal, role }.
 *          `principal` is `owner` or an account id; `role` is "owner" (sees
 *          every record) or "member" (only its own).
 *   a2app  { app, trigger, task, error }:
 *          app      the PocketBase app to read and write through —
 *                   `a2app.app.findRecordById(...)`, `a2app.app.save(record)`.
 *                   It is a TRANSACTION: everything the runner writes, and every
 *                   task it queues, lands together or not at all. Use it, not
 *                   `$app`, and do not make slow outbound calls in here — the
 *                   transaction holds the database's write lock until you return.
 *                   It is not held to the collection rules, so a runner holds
 *                   itself to them: see `mine` below.
 *          trigger  (type, payload, capability) — emit a declared event and, when
 *                   a capability is named, queue a task for an agent. Returns
 *                   { eventId, taskId }. An event type missing from `events`
 *                   below is refused. The task records the caller, and the agent
 *                   that takes it acts as them.
 *          task     (id) — a queued task as the agent sees it ({ id, status,
 *                   … }), or null if there is no such task. Read in the same
 *                   transaction, so it is current.
 *          error    (status, code, message) — `throw a2app.error(409, "already_done",
 *                   "…")` refuses with your own status and code.
 *
 * Return a plain, JSON-able value; it is the `result` of the call. Anything a
 * runner throws becomes `operation_failed` and rolls back what it wrote.
 *
 * `readOnly` names the fields only runners write, and `ownedBy` the field that
 * records whose record it is; see the notes on them below.
 *
 * WHAT EACH PERSON MAY DO. On a multi-user app, an optional
 * `permissionsOf(principal)` returns the scopes a person may use
 * (`data:<collection>:read|write`, `op:<name>`, `*`); every agent acting for
 * them is limited to the same, on every request. `principal` is { id, name,
 * role, active }. Without it everyone active may use everything (their records
 * stay their own):
 *
 *     permissionsOf: (p) => (p.role === "owner" ? ["*"] : ["data:tasks:read", "data:tasks:write", "op:request-triage"]),
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

  // WHOSE RECORDS. The text field each collection records its owner in. The
  // adapter fills it on create with the caller's principal (an account id, or
  // `owner`), and it is read-only to every client. On a multi-user app the
  // collection's rules then let a member see and change only its own records
  // (`owner = @request.auth.id`, see the tasks migration) and an owner all of
  // them; on a single-user app every record is the owner's.
  ownedBy: { tasks: "owner" },

  // What the agent taking each capability's tasks may do, as scopes. The bridge
  // runs it with a credential that acts for the person who asked, holds only
  // these, and dies with the task — so an agent asked to triage cannot do more
  // than triage, nor more than that person could. A capability left out gets
  // `*`, still within the person's own reach.
  capabilities: { triage: { scopes: ["data:tasks:read", "data:tasks:write"] } },

  runners: {
    "clear-done": (_args, ctx, a2app) => {
      const done = a2app.app.findRecordsByFilter("tasks", "status = 'done'", "", 0, 0);
      let removed = 0;
      for (let i = 0; i < done.length; i++) {
        if (!mine(ctx, done[i])) continue;
        a2app.app.delete(done[i]);
        removed++;
      }
      return { removed: removed };
    },

    "count-tasks": (_args, ctx, a2app) => {
      const all = a2app.app.findAllRecords("tasks");
      let count = 0;
      for (let i = 0; i < all.length; i++) if (mine(ctx, all[i])) count++;
      return { count: count };
    },

    "complete-task": (args, ctx, a2app) => {
      const task = mine(ctx, findTask(a2app, args.task));
      if (!task) return { ok: false, reason: "no such task" };
      task.set("status", "done");
      a2app.app.save(task);
      return { ok: true, task: task.id, status: "done" };
    },

    // The app→agent direction, in full. `trigger` emits a DECLARED event and,
    // because a capability is named, queues a task on the app's own queue. From
    // there an agent takes it — either because a harness is polling
    // (`a2app <app> tasks next --wait`) or because `agent-app <app> bridge` is
    // running and starts one. The task records who asked (`ctx.principal`), and
    // that agent acts as them.
    //
    // Send IDS, not prose. The agent re-reads the record itself, so the payload
    // carries what it needs to find the work — never instructions, and never a
    // copy of the data, which would be stale by the time it is read. Nothing
    // here can widen what the agent may do: the payload is data on the other
    // side, and the capability names the kind of work, not a command.
    //
    // One open run per record. While the record's last task is unfinished,
    // asking again hands back that task instead of queuing a second run — a
    // double click, a retry, or the agent itself asking from inside the run
    // (#24) all land on the work already in progress. Once it has finished, or
    // is gone, a new ask is a new run: the same trigger joins its task only
    // while that task is open.
    //
    // The task id goes on the record (`agentTask`), so whoever looks at the
    // record — the View, or an agent — can follow the work with
    // GET /api/_a2app/tasks/{id}.
    "request-triage": (args, ctx, a2app) => {
      const task = mine(ctx, findTask(a2app, args.task));
      if (!task) return { ok: false, reason: "no such task" };
      const previous = task.getString("agentTask");
      const current = previous ? a2app.task(previous) : null;
      if (current && FINISHED.indexOf(current.status) === -1) {
        return { ok: true, task: task.id, queued: current.id, alreadyQueued: true };
      }
      const fired = a2app.trigger("task.needs_triage", { task: task.id }, "triage");
      task.set("agentTask", fired.taskId);
      a2app.app.save(task);
      return { ok: true, task: task.id, queued: fired.taskId };
    },
  },
};

/** A queue task in one of these states will not move again. */
const FINISHED = ["completed", "failed", "canceled"];

/** The record if `ctx` may touch it: an owner may touch any task, a member
 *  only its own — the same rule the collection's API rules apply to the View
 *  and to agents, held here because a runner's writes bypass them. */
function mine(ctx, record) {
  return record && (ctx.role === "owner" || record.getString("owner") === ctx.principal) ? record : null;
}

function findTask(a2app, id) {
  try {
    return a2app.app.findRecordById("tasks", String(id));
  } catch (_missing) {
    return null;
  }
}
