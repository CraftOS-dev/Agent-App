/**
 * Will queued agent work be picked up? The check `serve`, `list`, `bridge` and
 * `stop` share (#12): an app can queue work for an agent and look perfectly
 * healthy while nothing ever claims it.
 *
 * It reports only what it can observe:
 *  - the local bridge record (`.a2app/bridge.json`) and whether its process is
 *    alive: `running`, `stale` (recorded, process gone) or `none`;
 *  - the live app's own task queue, read with the app's agent credential once
 *    the port has answered as THIS app.
 *
 * "This app queues agent work" means its queue holds at least one task, in any
 * status. Neither the identity document nor describe publishes an app's event
 * types, so an app that can queue work but never has is not flagged until its
 * first task arrives — there is no source scan and no guessing. A harness that
 * polls the queue from elsewhere (`a2app <app> tasks next --wait`) is not
 * visible here either.
 *
 * A live pid is not proof of a bridge: after a reboot the pid can belong to
 * something else. So a "running" bridge that has left work it takes waiting
 * well past its poll interval, with nothing being worked on, is reported as
 * not picking work up.
 */
import { existsSync } from "node:fs";
import { bridgeRecordPath, readBridgeRecord, type BridgeRecord } from "./bridge.js";
import { readDevRecord } from "./instance.js";
import { isPidAlive } from "./proc.js";
import { readAgentToken } from "./project.js";
import { log } from "./log.js";

export type RunningBridge = Pick<
  BridgeRecord,
  "pid" | "harness" | "mode" | "intervalMs" | "startedAt" | "baseUrl" | "capabilities"
>;

export interface LocalBridge {
  /** running: recorded and alive · stale: recorded, but the process is gone · none */
  bridge: "running" | "stale" | "none";
  running: RunningBridge | null;
  /** the pid a stale record names, when it names a usable one */
  stalePid: number | null;
}

/** The local bridge for an app directory. File reads and a pid check only. */
export function inspectLocalBridge(dir: string): LocalBridge {
  if (!existsSync(bridgeRecordPath(dir))) return { bridge: "none", running: null, stalePid: null };
  const rec = readBridgeRecord(dir);
  if (rec === null) return { bridge: "stale", running: null, stalePid: null };
  if (!isPidAlive(rec.pid)) return { bridge: "stale", running: null, stalePid: rec.pid };
  return {
    bridge: "running",
    running: {
      pid: rec.pid,
      harness: rec.harness,
      mode: rec.mode,
      intervalMs: rec.intervalMs,
      startedAt: rec.startedAt,
      ...(rec.baseUrl !== undefined ? { baseUrl: rec.baseUrl } : {}),
      ...(rec.capabilities !== undefined ? { capabilities: rec.capabilities } : {}),
    },
    stalePid: null,
  };
}

export interface AgentWork extends LocalBridge {
  /** the live app that was inspected — never a dev instance */
  baseUrl: string;
  /** the dev instance's URL while one is recorded, else null */
  devUrl: string | null;
  /**
   * Where a running bridge takes work from: this app (`live`), somewhere else
   * such as a dev instance (`other`), or not recorded because an older
   * agent-app started it (`unknown`). null when no bridge is running.
   */
  bridgeTarget: "live" | "other" | "unknown" | null;
  /** submitted tasks in the queue; null when the queue could not be read */
  tasksWaiting: number | null;
  /**
   * The queue holds at least one task of any status. null when that was not
   * read: the queue was unreadable, or (in `list`) only waiting tasks were read
   * and none were waiting.
   */
  queuesAgentWork: boolean | null;
  /** waiting tasks whose capability the running bridge was told not to take */
  tasksNotTaken: number;
  /** a running bridge has left work it takes waiting far past its interval */
  notPickedUp: boolean;
  /** how long the oldest waiting task the bridge would take has waited, by the app's clock */
  oldestWaitingMs: number | null;
  /** why the queue could not be read, when it could not */
  queueError: string | null;
}

/** Each request, body included, must finish inside this. */
const PROBE_TIMEOUT_MS = 750;
/** A status read never buffers more than this. */
const PROBE_MAX_BYTES = 1024 * 1024;
/** Work a bridge takes counts as not picked up after this many of its poll
 *  intervals — and never sooner than the floor. */
const PICKUP_INTERVALS = 3;
const PICKUP_FLOOR_MS = 10_000;

interface Reply {
  status: number;
  json: unknown;
  /** the body passed {@link PROBE_MAX_BYTES} and was abandoned */
  tooLarge: boolean;
  /** the app's clock, from its Date header */
  date: number | null;
}

/**
 * GET with a deadline that covers the whole body, not just the headers, and a
 * size cap. No redirects: the credential must reach this URL and nowhere else.
 */
async function getJson(url: string, timeoutMs: number, token: string | null): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { "X-A2App-Agent": "agent-app-status", ...(token !== null ? { "X-A2App-Token": token } : {}) },
    });
    const dateHeader = Date.parse(res.headers.get("date") ?? "");
    const date = Number.isFinite(dateHeader) ? dateHeader : null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = res.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > PROBE_MAX_BYTES) {
            controller.abort();
            return { status: res.status, json: null, tooLarge: true, date };
          }
          chunks.push(value);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released by the abort */
        }
      }
    }
    let json: unknown = null;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json = null;
    }
    return { status: res.status, json, tooLarge: false, date };
  } finally {
    clearTimeout(timer);
  }
}

interface TaskLite {
  status: string;
  capability: string | null;
  /** when it last became what it is — a task swept back to the queue is re-stamped */
  since: number | null;
}

/** The tasks in a task-list reply, or null when it is not one. A malformed
 *  reply is not evidence of an empty queue. */
function taskList(reply: Reply): TaskLite[] | null {
  if (reply.status !== 200 || reply.tooLarge) return null;
  const tasks = (reply.json as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return null;
  const out: TaskLite[] = [];
  for (const t of tasks) {
    const task = t as { id?: unknown; status?: unknown; request?: { capability?: unknown }; createdAt?: unknown; updatedAt?: unknown } | null;
    if (task === null || typeof task !== "object" || typeof task.id !== "string" || typeof task.status !== "string") {
      return null;
    }
    const stamp = typeof task.updatedAt === "string" ? task.updatedAt : typeof task.createdAt === "string" ? task.createdAt : "";
    const since = Date.parse(stamp);
    out.push({
      status: task.status,
      capability: typeof task.request?.capability === "string" ? task.request.capability : null,
      since: Number.isFinite(since) ? since : null,
    });
  }
  return out;
}

interface QueueRead {
  /** the submitted tasks; null when the queue could not be read */
  waiting: TaskLite[] | null;
  /** some task is being worked on; null when that was not read */
  anyWorking: boolean | null;
  queuesAgentWork: boolean | null;
  /** the app's clock at the read */
  serverNow: number | null;
  queueError: string | null;
}

function failure(err: unknown): string {
  return (err as Error)?.name === "AbortError" ? "the app did not answer in time" : "the app is not answering";
}

interface ReadOpts {
  identityVerified: boolean;
  timeoutMs: number;
  /** read every task, not only the waiting ones */
  history: boolean;
}

async function readQueue(dir: string, appId: string, baseUrl: string, opts: ReadOpts): Promise<QueueRead & { token: string | null }> {
  const token = readAgentToken(dir);
  const unread = (why: string): QueueRead & { token: string | null } => ({
    waiting: null, anyWorking: null, queuesAgentWork: null, serverNow: null, queueError: why, token,
  });
  let identityNow: number | null = null;
  // Who is answering comes first: the app's own credential goes only to the app.
  if (!opts.identityVerified) {
    try {
      const id = await getJson(`${baseUrl}/api/_a2app`, opts.timeoutMs, null);
      const body = id.json as { a2app?: unknown; app?: { id?: unknown }; serverNow?: unknown } | null;
      if (id.status !== 200 || body?.a2app !== true) return unread("the app is not answering");
      if (body.app?.id !== appId) return unread(`another app is answering at ${baseUrl}`);
      const now = typeof body.serverNow === "string" ? Date.parse(body.serverNow) : NaN;
      identityNow = Number.isFinite(now) ? now : null;
    } catch (err) {
      return unread(failure(err));
    }
  }
  const refused = (r: Reply): string =>
    r.status === 401 || r.status === 403 ? "the app refused its agent credential" : "the queue reply was not a task list";
  try {
    if (opts.history) {
      // One read gives every answer: all tasks, of which the submitted ones wait.
      const all = await getJson(`${baseUrl}/api/_a2app/tasks`, opts.timeoutMs, token);
      if (!all.tooLarge) {
        const tasks = taskList(all);
        if (tasks === null) return unread(refused(all));
        return {
          waiting: tasks.filter((t) => t.status === "submitted"),
          anyWorking: tasks.some((t) => t.status === "working"),
          queuesAgentWork: tasks.length > 0,
          serverNow: all.date ?? identityNow,
          queueError: null,
          token,
        };
      }
      // A history too large to read certainly holds tasks; read the waiting ones.
    }
    const sub = await getJson(`${baseUrl}/api/_a2app/tasks?status=submitted`, opts.timeoutMs, token);
    if (sub.tooLarge) return { ...unread("too many tasks to count"), queuesAgentWork: true };
    const waiting = taskList(sub);
    if (waiting === null) return unread(refused(sub));
    const submitted = waiting.filter((t) => t.status === "submitted");
    return {
      waiting: submitted,
      anyWorking: null,
      queuesAgentWork: opts.history || submitted.length > 0 ? true : null,
      serverNow: sub.date ?? identityNow,
      queueError: null,
      token,
    };
  } catch (err) {
    return unread(failure(err));
  }
}

/** Is anything being worked on right now? null when that cannot be read. */
async function anyWorking(baseUrl: string, timeoutMs: number, token: string | null): Promise<boolean | null> {
  try {
    const tasks = taskList(await getJson(`${baseUrl}/api/_a2app/tasks?status=working`, timeoutMs, token));
    return tasks === null ? null : tasks.some((t) => t.status === "working");
  } catch {
    return null;
  }
}

/**
 * Inspect an app's agent work: its local bridge and its live queue.
 *
 * Bounded: identity (unless the caller has just verified it), one queue read,
 * a second only when the full history is too large, and a third — tasks being
 * worked on — only when a running bridge seems to have left work waiting. Each
 * finishes or is abandoned within {@link PROBE_TIMEOUT_MS}. It claims and
 * starts nothing. Reading the queue does let the app run its own sweep, which
 * returns expired claims to the queue — the same as any queue read.
 *
 * `history: false` reads only the waiting tasks — what `list`, which a
 * dashboard may poll every few seconds, needs. Then `queuesAgentWork` is known
 * only when something is waiting.
 */
export async function inspectAgentWork(
  dir: string,
  appId: string,
  baseUrl: string,
  opts: { identityVerified?: boolean; timeoutMs?: number; history?: boolean } = {},
): Promise<AgentWork> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const local = inspectLocalBridge(dir);
  const devUrl = readDevRecord(dir)?.url ?? null;
  const recorded = local.running?.baseUrl;
  const bridgeTarget =
    local.running === null ? null : recorded === undefined ? "unknown" : recorded === baseUrl ? "live" : "other";
  const queue = await readQueue(dir, appId, baseUrl, {
    identityVerified: opts.identityVerified === true,
    timeoutMs,
    history: opts.history !== false,
  });

  let tasksNotTaken = 0;
  let notPickedUp = false;
  let oldestWaitingMs: number | null = null;
  const r = local.running;
  if (r !== null && bridgeTarget !== "other" && queue.waiting !== null) {
    const takes = r.capabilities;
    const taken = takes === undefined ? queue.waiting : queue.waiting.filter((t) => t.capability !== null && takes.includes(t.capability));
    tasksNotTaken = queue.waiting.length - taken.length;
    const now = queue.serverNow;
    const stamps = taken.map((t) => t.since).filter((s): s is number => s !== null);
    if (now !== null && stamps.length > 0) {
      oldestWaitingMs = Math.max(0, now - Math.min(...stamps));
      // A busy bridge leaves later tasks waiting while it works on one; only a
      // bridge with nothing in hand and old work waiting is not picking up.
      if (oldestWaitingMs > Math.max(PICKUP_INTERVALS * r.intervalMs, PICKUP_FLOOR_MS)) {
        const working = queue.anyWorking ?? (await anyWorking(baseUrl, timeoutMs, queue.token));
        notPickedUp = working === false;
      }
    }
  }

  return {
    ...local,
    baseUrl,
    devUrl,
    bridgeTarget,
    tasksWaiting: queue.waiting?.length ?? null,
    queuesAgentWork: queue.queuesAgentWork,
    tasksNotTaken,
    notPickedUp,
    oldestWaitingMs,
    queueError: queue.queueError,
  };
}

/**
 * How to write an app reference in a command someone will paste: a bare word
 * stays bare; anything else is double-quoted, which cmd.exe, PowerShell and
 * POSIX shells all read the same way (single quotes are not quotes to cmd.exe).
 *
 * A trailing slash or backslash is dropped: `".\my-app\"` reads as an escaped
 * quote to node, bash and PowerShell alike. A ref no quoting keeps intact in
 * every shell — one holding `"`, or `$`, a backtick, `%` or `!`, which some
 * shell expands even inside double quotes — is shown as `<app>` rather than
 * as a command that would address something else. `list` never gets here with
 * one: it prefers a registered name without them, then the id, which is hex.
 */
export function shellRef(ref: string): string {
  let r = ref;
  while (r.length > 1 && /[\\/]$/.test(r) && !/^[A-Za-z]:[\\/]$/.test(r)) r = r.slice(0, -1);
  // A drive root keeps its separator, as `/` so it needs no quotes at all.
  if (/^[A-Za-z]:\\$/.test(r)) r = `${r.slice(0, 2)}/`;
  if (/^[A-Za-z0-9._/:@+=-]+$/.test(r)) return r;
  if (/["$`%!]/.test(r)) return "<app>";
  return `"${r}"`;
}

/** `agent-app <ref> <rest>`, ready to paste. */
export function appCommand(ref: string, rest: string): string {
  return `agent-app ${shellRef(ref)} ${rest}`;
}

export function tasksPhrase(n: number): string {
  return `${n} agent task${n === 1 ? "" : "s"}`;
}

export interface Line {
  level: "ok" | "info" | "warn";
  text: string;
  /** the line already says how many tasks are waiting */
  counted: boolean;
}

/**
 * The one thing to tell someone about an app's agent work, addressed the way
 * they addressed the app. null when there is nothing to say: no bridge, no
 * record, and no sign that the app queues work. A problem line always names
 * the command that fixes it.
 */
export function agentWorkLine(work: AgentWork, ref: string): Line | null {
  const cmd = (rest: string): string => appCommand(ref, rest);
  const restart = `${cmd("bridge stop")}, then ${cmd("bridge start")}`;
  const n = work.tasksWaiting;
  const waiting = n === null ? "" : ` · ${n} waiting`;

  if (work.running !== null) {
    const r = work.running;
    if (work.bridgeTarget === "other") {
      const stuck = n !== null && n > 0;
      // While dev is up, a restart would land on dev again: finish dev first.
      const fix = work.devUrl !== null
        ? `Promote or abandon the dev change (${cmd("promote")} or ${cmd("stop --dev")}), then restart it: ${restart}`
        : `Restart it: ${restart}`;
      return {
        level: "warn",
        text:
          `the bridge (pid ${r.pid}) takes work from ${r.baseUrl}, not from this app at ${work.baseUrl}` +
          `${stuck ? `, so the ${tasksPhrase(n)} waiting here ${n === 1 ? "is" : "are"} not picked up` : ""}. ${fix}`,
        counted: stuck,
      };
    }
    if (work.notPickedUp && work.oldestWaitingMs !== null) {
      return {
        level: "warn",
        text:
          `the bridge (pid ${r.pid}) has not picked up work waiting ${Math.round(work.oldestWaitingMs / 1000)}s; ` +
          `pid ${r.pid} may no longer be the bridge. Restart it: ${restart}`,
        counted: false,
      };
    }
    if (work.tasksNotTaken > 0) {
      return {
        level: "warn",
        text:
          `${tasksPhrase(work.tasksNotTaken)} waiting for a capability the bridge (pid ${r.pid}) does not take ` +
          `(it takes only ${(r.capabilities ?? []).join(", ")}). Restart it for all of them: ${restart}`,
        counted: false,
      };
    }
    if (work.bridgeTarget === "unknown") {
      return { level: "info", text: `bridge running (pid ${r.pid})${waiting}; restart it to record its target: ${restart}`, counted: n !== null };
    }
    return { level: "ok", text: `bridge running (pid ${r.pid}, ${r.harness} via ${r.mode})${waiting}`, counted: n !== null };
  }

  if (work.bridge === "stale") {
    const pid = work.stalePid !== null ? ` (pid ${work.stalePid})` : "";
    if (n !== null && n > 0) {
      return { level: "warn", text: `${tasksPhrase(n)} waiting, but the bridge${pid} is no longer running. Restart it: ${cmd("bridge start")}`, counted: true };
    }
    if (work.queuesAgentWork === true) {
      return { level: "warn", text: `the bridge${pid} is no longer running, so new agent tasks will wait. Restart it: ${cmd("bridge start")}`, counted: false };
    }
    return { level: "info", text: `stale bridge record${pid}; ${cmd("bridge stop")} clears it`, counted: false };
  }

  if (n !== null && n > 0) {
    return { level: "warn", text: `${tasksPhrase(n)} waiting and no bridge is running to start them. Start one: ${cmd("bridge start")}`, counted: true };
  }
  if (work.queuesAgentWork === true) {
    return { level: "info", text: `no bridge is running, so new agent tasks will wait. Start one: ${cmd("bridge start")}`, counted: false };
  }
  return null;
}

export function printLine(line: Line | null): void {
  if (line !== null) log[line.level](line.text);
}
