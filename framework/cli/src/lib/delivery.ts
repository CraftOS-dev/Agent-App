/** Read-only launch/handoff inspection. A local bridge PID is not proof of
 * delivery, and its absence does not rule out an external queue subscriber. */
import { existsSync } from "node:fs";
import type { A2AppResponse } from "@a2app/sdk";
import { scanAgentState } from "./agentState.js";
import { bridgeRecordPath, countWaiting, readBridgeRecord, type BridgeRecord } from "./bridge.js";
import { isPidAlive } from "./proc.js";
import { readAgentToken } from "./project.js";
import { log } from "./log.js";

export type RunningBridge = Pick<BridgeRecord, "pid" | "harness" | "mode" | "startedAt" | "baseUrl">;
export interface LocalBridge {
  state: "absent" | "stale" | "running";
  running: RunningBridge | null;
}

export function inspectLocalBridge(dir: string): LocalBridge {
  const rec = readBridgeRecord(dir);
  if (rec === null || !isPidAlive(rec.pid)) {
    return { state: existsSync(bridgeRecordPath(dir)) ? "stale" : "absent", running: null };
  }
  return {
    state: "running",
    running: { pid: rec.pid, harness: rec.harness, mode: rec.mode, startedAt: rec.startedAt, ...(rec.baseUrl ? { baseUrl: rec.baseUrl } : {}) },
  };
}

export interface DeliveryInspection extends LocalBridge {
  /** Static trigger detection or observed submitted work; not queue support alone.
   * Dynamic/custom enqueue implementations may not be found by the scanner. */
  queuesAgentWork: boolean;
  /** Number observed in the poll response; null means unavailable, never zero. */
  tasksWaiting: number | null;
  /** Always the live endpoint, even when operate commands target dev. */
  baseUrl: string;
  /** null for legacy records without an endpoint, or no local process. */
  bridgeTargetsLive: boolean | null;
}

/** The SDK timeout currently bounds response headers, not a stalled body.
 * Status probes need a deadline through the entire read, without leaving an
 * abandoned fetch alive after the caller has returned. */
async function readReply(baseUrl: string, path: string, timeoutMs: number, token: string | null = null): Promise<A2AppResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      redirect: "error",
      headers: { "X-A2App-Agent": "agent-app-status", ...(token ? { "X-A2App-Token": token } : {}) },
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) { controller.abort(); throw new Error("status response exceeds 1 MiB"); }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    return { status: res.status, ok: res.ok, body, json: JSON.parse(body) };
  } finally { clearTimeout(timer); }
}

/** At most two bounded requests, including response-body reads. Nothing is
 * claimed, started, cleared or written. Credentials go only to the verified app. */
export async function inspectDelivery(
  dir: string,
  appId: string,
  baseUrl: string,
  timeoutMs = 750,
): Promise<DeliveryInspection> {
  const local = inspectLocalBridge(dir);
  let queuesAgentWork = false;
  try {
    queuesAgentWork = scanAgentState(dir).triggers.length > 0;
  } catch {
    // A malformed/unreadable canon must not turn a status courtesy into a
    // failed launch. A queue read can still establish that work is waiting.
  }
  let tasksWaiting: number | null = null;
  try {
    const identity = await readReply(baseUrl, "/api/_a2app", timeoutMs);
    const body = identity.json as { a2app?: boolean; app?: { id?: string } } | null;
    if (identity.ok && body?.a2app === true && body.app?.id === appId) {
      tasksWaiting = await countWaiting({
        pollTasks: () => readReply(baseUrl, "/api/_a2app/tasks?status=submitted", timeoutMs, readAgentToken(dir)),
      });
    }
  } catch {
    // Missing credential, stopped app, wrong identity or failed queue read:
    // the queue state is unknown, not an empty queue.
  }
  const bridgeTargetsLive = local.running?.baseUrl ? local.running.baseUrl === baseUrl : null;
  return { ...local, queuesAgentWork: queuesAgentWork || (tasksWaiting ?? 0) > 0, tasksWaiting, baseUrl, bridgeTargetsLive };
}

/** A copyable command, including paths with spaces/apostrophes. */
export function appCommand(dir: string, command: string): string {
  const quoted = process.platform === "win32"
    ? `'${dir.replace(/'/g, "''")}'`
    : `'${dir.replace(/'/g, "'\\''")}'`;
  return `agent-app ${quoted} ${command}`;
}

export function reportDelivery(info: DeliveryInspection, dir: string): void {
  if (!info.queuesAgentWork && info.state === "absent") return;
  if (info.running !== null) {
    log.info(`local bridge process running (pid ${info.running.pid}) — ${info.running.harness}/${info.running.mode}; task delivery is not verified by process liveness`);
    if (info.bridgeTargetsLive !== true) {
      log.warn(
        `AGENT WORK DELIVERY NOT VERIFIED: ${info.bridgeTargetsLive === false ? `the local bridge watches ${info.running.baseUrl}, rather than live at ${info.baseUrl}` : "the recorded bridge endpoint is unknown"}.\n` +
        `  After dev is gone, restart it for live: ${appCommand(dir, "bridge stop")} then ${appCommand(dir, "bridge start")}`,
      );
    }
  } else {
    log.warn(
      `AGENT WORK DELIVERY NOT VERIFIED: this app ${info.queuesAgentWork ? "queues agent work" : "has a stale bridge record"}, ` +
      `but no local bridge is running${info.state === "stale" ? " (stale record)" : ""}. Tasks may remain unclaimed.\n` +
      `  Start a background bridge: ${appCommand(dir, "bridge start")}\n` +
      `  Check the harness route:   ${appCommand(dir, "bridge")}\n` +
      "  A harness polling the queue independently is also valid; no local bridge does not prove no external listener.",
    );
  }
  log.info(info.tasksWaiting === null ? "waiting work: unknown (live queue could not be read)" : `${info.tasksWaiting} waiting task(s) observed in the live queue`);
}
