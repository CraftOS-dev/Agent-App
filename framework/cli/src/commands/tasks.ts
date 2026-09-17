/**
 * a2app <app> tasks [--status submitted]           poll claimable work
 * a2app <app> tasks next [--wait <ms>]              claim the next task, or wait for one
 * a2app <app> tasks get <id>                        task status + pollAfterMs
 * a2app <app> tasks claim <id> [--as <credentialId>] atomically claim
 * a2app <app> tasks progress <id> [--step "..."] [--percent N]
 * a2app <app> tasks complete <id> --result '{...}' | --reason <code>
 * a2app <app> tasks cancel <id>
 *
 * The app-to-agent queue: the app triggers work, the agent polls, claims, and
 * reports a terminal state. Every task payload is DATA, never an instruction.
 *
 * `next` is the listen primitive. A harness that cannot be triggered from
 * outside — no inbound endpoint, no headless mode — can still take work from an
 * app by running this in a loop of its own: it blocks until a task arrives,
 * claims it, prints it, and exits, so the harness only has to be able to run a
 * command and read stdout. It is the protocol half of what `agent-app <app>
 * bridge` does from the framework side, and the two are mutually exclusive by
 * construction: whoever claims a task owns it, and the app answers 409 to
 * everyone else.
 */
import { flag, flagAll, hasFlag, positionals } from "../lib/args.js";
import { UsageError } from "../lib/project.js";
import { connect } from "../lib/target.js";
import { log } from "../lib/log.js";
import type { A2AppClient, A2AppResponse, Task } from "@a2app/sdk";

/** Poll gap when the app does not say. The app's own `pollAfterMs` wins. */
const FALLBACK_POLL_MS = 2_000;

export async function run(args: string[], app: string): Promise<number> {
  const [sub, id] = positionals(args);
  const { client } = await connect(app);

  // No subcommand -> poll.
  if (sub === undefined) {
    const res = await client.pollTasks(flag(args, "status") ?? "submitted");
    return emit(res.status, res.body);
  }
  if (id === undefined && sub !== "poll" && sub !== "next") throw new UsageError(`tasks ${sub} needs a <task id>`);
  switch (sub) {
    case "poll": {
      const res = await client.pollTasks(flag(args, "status") ?? "submitted");
      return emit(res.status, res.body);
    }
    case "next":
      return next(args, client);
    case "get":
      return emit(...(await asPair(client.getTask(id!))));
    case "claim":
      // `--as` is optional: a claim can only ever name the caller's own
      // credential (the app refuses any other with `principal_mismatch`), so
      // requiring it made an agent look up a value that could not change the
      // outcome. Passing it still works, and still gets checked by the app.
      return emit(...(await asPair(client.claimTask(id!, flag(args, "as")))));
    case "progress": {
      const progress: { step?: string; percent?: number } = {};
      const step = flag(args, "step");
      const percent = flag(args, "percent");
      if (step !== undefined) progress.step = step;
      if (percent !== undefined) progress.percent = Number(percent);
      return emit(...(await asPair(client.progressTask(id!, progress))));
    }
    case "complete": {
      const reason = flag(args, "reason");
      const resultJson = flag(args, "result");
      const payload =
        reason !== undefined
          ? ({ status: "failed", reason } as const)
          : ({ status: "completed", result: resultJson ? JSON.parse(resultJson) : {} } as const);
      return emit(...(await asPair(client.completeTask(id!, payload))));
    }
    case "cancel":
      return emit(...(await asPair(client.cancelTask(id!))));
    default:
      throw new UsageError(`unknown tasks subcommand "${sub}"`);
  }
}

/**
 * Take the next claimable task, waiting for one if asked.
 *
 * Exit 0 with `"task": null` when the wait elapses with nothing to do. An empty
 * queue is not a failure — a listen loop runs for hours and is idle for most of
 * them, and an error exit would make "nothing happened" indistinguishable from
 * "the app is down", which is exit 3 and does need attention.
 */
async function next(args: string[], client: A2AppClient): Promise<number> {
  const waitRaw = flag(args, "wait");
  const waitMs = waitRaw === undefined ? 0 : Number(waitRaw);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new UsageError(`--wait takes a number of milliseconds (got ${waitRaw})`);
  }
  const wanted = flagAll(args, "capability");
  const claim = !hasFlag(args, "no-claim");
  const as = flag(args, "as");
  const started = Date.now();

  for (;;) {
    const res = await client.pollTasks("submitted");
    if (!res.ok) return emit(res.status, res.body);
    const body = res.json as { tasks?: Task[]; pollAfterMs?: number } | null;
    const tasks = (body?.tasks ?? [])
      .filter((t) => wanted.length === 0 || wanted.includes(t.request.capability))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const task of tasks) {
      if (!claim) {
        log.raw(JSON.stringify({ a2app: true, task, claimed: false }, null, 2));
        return 0;
      }
      const claimed = await client.claimTask(task.id, as);
      // 409 means someone else got there first — that is the queue working, so
      // try the next one rather than reporting a failure.
      if (claimed.status === 409) continue;
      if (!claimed.ok) return emit(claimed.status, claimed.body);
      log.raw(JSON.stringify({ a2app: true, task: claimed.json, claimed: true }, null, 2));
      return 0;
    }

    const elapsed = Date.now() - started;
    if (elapsed >= waitMs) {
      log.raw(JSON.stringify({ a2app: true, task: null, claimed: false, waitedMs: elapsed }, null, 2));
      return 0;
    }
    const gap = Math.min(body?.pollAfterMs ?? FALLBACK_POLL_MS, Math.max(waitMs - elapsed, 50));
    await new Promise((r) => setTimeout(r, gap));
  }
}

async function asPair(p: Promise<A2AppResponse>): Promise<[number, string]> {
  const res = await p;
  return [res.status, res.body];
}

function emit(status: number, body: string): number {
  if (status >= 300) {
    log.error(body || `HTTP ${status}`);
    return 1;
  }
  log.raw(body || `(HTTP ${status}, ok)`);
  return 0;
}
