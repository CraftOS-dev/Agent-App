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
 */
import { existsSync } from "node:fs";
import { bridgeRecordPath, readBridgeRecord, type BridgeRecord } from "./bridge.js";
import { isPidAlive } from "./proc.js";
import { readAgentToken } from "./project.js";
import { log } from "./log.js";

export type RunningBridge = Pick<BridgeRecord, "pid" | "harness" | "mode" | "startedAt" | "baseUrl">;

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
      startedAt: rec.startedAt,
      ...(rec.baseUrl !== undefined ? { baseUrl: rec.baseUrl } : {}),
    },
    stalePid: null,
  };
}

export interface AgentWork extends LocalBridge {
  /** the live app that was inspected — never a dev instance */
  baseUrl: string;
  /**
   * Where a running bridge takes work from: this app (`live`), somewhere else
   * such as a dev instance (`other`), or not recorded because an older
   * agent-app started it (`unknown`). null when no bridge is running.
   */
  bridgeTarget: "live" | "other" | "unknown" | null;
  /** submitted tasks in the queue; null when the queue could not be read */
  tasksWaiting: number | null;
  /** the queue holds at least one task of any status; null when it could not be read */
  queuesAgentWork: boolean | null;
  /** why the queue could not be read, when it could not */
  queueError: string | null;
}

/** Each request, body included, must finish inside this. */
const PROBE_TIMEOUT_MS = 750;
/** A status read never buffers more than this. */
const PROBE_MAX_BYTES = 1024 * 1024;

interface Reply {
  status: number;
  json: unknown;
  /** the body passed {@link PROBE_MAX_BYTES} and was abandoned */
  tooLarge: boolean;
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
            return { status: res.status, json: null, tooLarge: true };
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
    return { status: res.status, json, tooLarge: false };
  } finally {
    clearTimeout(timer);
  }
}

/** The statuses in a task-list reply, or null when it is not one. A malformed
 *  reply is not evidence of an empty queue. */
function taskStatuses(reply: Reply): string[] | null {
  if (reply.status !== 200) return null;
  const tasks = (reply.json as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return null;
  const statuses: string[] = [];
  for (const t of tasks) {
    const task = t as { id?: unknown; status?: unknown } | null;
    if (task === null || typeof task !== "object" || typeof task.id !== "string" || typeof task.status !== "string") {
      return null;
    }
    statuses.push(task.status);
  }
  return statuses;
}

type QueueRead = Pick<AgentWork, "tasksWaiting" | "queuesAgentWork" | "queueError">;

function failure(err: unknown): string {
  return (err as Error)?.name === "AbortError" ? "the app did not answer in time" : "the app is not answering";
}

async function readQueue(dir: string, appId: string, baseUrl: string, identityVerified: boolean, timeoutMs: number): Promise<QueueRead> {
  const unread = (why: string): QueueRead => ({ tasksWaiting: null, queuesAgentWork: null, queueError: why });
  // Who is answering comes first: the app's own credential goes only to the app.
  if (!identityVerified) {
    try {
      const id = await getJson(`${baseUrl}/api/_a2app`, timeoutMs, null);
      const body = id.json as { a2app?: unknown; app?: { id?: unknown } } | null;
      if (id.status !== 200 || body?.a2app !== true) return unread("the app is not answering");
      if (body.app?.id !== appId) return unread(`another app is answering at ${baseUrl}`);
    } catch (err) {
      return unread(failure(err));
    }
  }
  const token = readAgentToken(dir);
  try {
    // One read gives both answers: every task, of which the submitted ones wait.
    const all = await getJson(`${baseUrl}/api/_a2app/tasks`, timeoutMs, token);
    if (!all.tooLarge) {
      const statuses = taskStatuses(all);
      if (statuses === null) {
        return unread(all.status === 401 || all.status === 403 ? "the app refused its agent credential" : "the queue reply was not a task list");
      }
      return { tasksWaiting: statuses.filter((s) => s === "submitted").length, queuesAgentWork: statuses.length > 0, queueError: null };
    }
    // A history too large to read certainly holds tasks; count only the waiting ones.
    const waiting = await getJson(`${baseUrl}/api/_a2app/tasks?status=submitted`, timeoutMs, token);
    const statuses = waiting.tooLarge ? null : taskStatuses(waiting);
    if (statuses === null) return { tasksWaiting: null, queuesAgentWork: true, queueError: "too many tasks to count" };
    return { tasksWaiting: statuses.filter((s) => s === "submitted").length, queuesAgentWork: true, queueError: null };
  } catch (err) {
    return unread(failure(err));
  }
}

/**
 * Inspect an app's agent work: its local bridge and its live queue.
 *
 * Bounded: at most three requests (identity, unless the caller has just
 * verified it; the task list; and the waiting tasks only when the list is too
 * large), each finished or abandoned within {@link PROBE_TIMEOUT_MS}. It claims
 * and starts nothing. Reading the queue does let the app run its own sweep,
 * which returns expired claims to the queue — the same as any queue read.
 */
export async function inspectAgentWork(
  dir: string,
  appId: string,
  baseUrl: string,
  opts: { identityVerified?: boolean; timeoutMs?: number } = {},
): Promise<AgentWork> {
  const local = inspectLocalBridge(dir);
  const recorded = local.running?.baseUrl;
  const bridgeTarget =
    local.running === null ? null : recorded === undefined ? "unknown" : recorded === baseUrl ? "live" : "other";
  const queue = await readQueue(dir, appId, baseUrl, opts.identityVerified === true, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  return { ...local, baseUrl, bridgeTarget, ...queue };
}

/**
 * How to write an app reference in a command someone will paste. A bare word
 * stays bare; anything else is double-quoted, which cmd.exe, PowerShell and
 * POSIX shells all read the same way (single quotes are not quotes to cmd.exe).
 */
export function shellRef(ref: string): string {
  return /^[A-Za-z0-9._/:@+=-]+$/.test(ref) ? ref : `"${ref}"`;
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
      return {
        level: "warn",
        text:
          `the bridge (pid ${r.pid}) takes work from ${r.baseUrl}, not from this app at ${work.baseUrl}` +
          `${stuck ? `, so the ${tasksPhrase(n)} waiting here are not picked up` : ""}. Restart it: ${restart}`,
        counted: stuck,
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
