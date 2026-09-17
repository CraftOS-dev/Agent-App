/**
 * agent-app <app> bridge [status|start|stop] [--flags]
 *
 * The app→agent direction, made to actually happen.
 *
 * A2App gives an app a queue it can put work in. Nothing in the protocol makes
 * an agent turn up to take it, because that step is the one part of this that
 * depends on the harness rather than on the app. The bridge is that step: a
 * background service on THIS machine that watches one app's queue, claims what
 * appears, and triggers the harness by whichever route the harness offers —
 * inbound endpoint, headless CLI, gateway, or (when the harness can only poll)
 * by handing over the listen command instead.
 *
 * It is an `agent-app` command, not an `a2app` one, and the split (spec 5.1)
 * decides that by itself: `a2app` is the protocol and nothing else, and this
 * spawns local processes, manages a pid file, and reads a machine's harness
 * configuration. None of that is A2App, and a third party implementing the
 * protocol must not be led to think it is.
 *
 * It is also deliberately opt-in and per-app. Nothing starts a bridge on the
 * user's behalf: a bridge makes an app able to start agent runs, which is a
 * capability a person grants once, knowingly, for an app they chose.
 */
import { existsSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { flag, flagAll, hasFlag, positionals } from "../lib/args.js";
import {
  bridgeLockPath,
  bridgeLogPath,
  clearBridgeRecord,
  countWaiting,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  logTail,
  ensureGateway,
  pumpLoop,
  pumpOnce,
  readBridgeRecord,
  writeBridgeRecord,
  type BridgeContext,
} from "../lib/bridge.js";
import { chooseRoute, harnessesPath, loadHarnesses, selectProfile, type RungReport } from "../lib/harness.js";
import { withLock } from "../lib/lock.js";
import { isPidAlive, killTreeForce, terminateTree, waitForExit } from "../lib/proc.js";
import { loadProject, UsageError, type Project } from "../lib/project.js";
import { connect } from "../lib/target.js";
import { log } from "../lib/log.js";

/** A bridge that is recorded AND actually alive. A record whose process is gone
 *  is not a running bridge — it is a leftover, and treating it as one would make
 *  `start` refuse forever after a crash. */
function runningBridge(dir: string): { pid: number; harness: string; mode: string; startedAt: string } | null {
  const rec = readBridgeRecord(dir);
  if (rec === null) return null;
  if (rec.pid === process.pid) return null;
  if (!isPidAlive(rec.pid)) return null;
  return { pid: rec.pid, harness: rec.harness, mode: rec.mode, startedAt: rec.startedAt };
}

/** The five rungs as a person needs to read them when nothing worked. */
function explainNoRoute(app: string, ladder: RungReport[]): void {
  log.error(
    `no way to reach an agent harness from here — bi-directional operation is NOT supported for this app right now.`,
  );
  if (ladder.length > 0) {
    log.info("what was tried, deepest integration first:");
    for (const rung of ladder) log.info(`  ${rung.available ? "✓" : "✗"} ${rung.mode.padEnd(10)} ${rung.detail}`);
  }
  log.info(
    `Any one of these fixes it:\n` +
      `  · install a harness with a headless mode (claude, codex, gemini, aider) — nothing else to configure\n` +
      `  · describe your harness in ${harnessesPath()} (an inbound endpoint, a gateway, or its own headless command)\n` +
      `  · or drive it from the harness's side instead: a2app ${app} tasks next --wait 60000`,
  );
}

/** `bridge` with no subcommand: what would happen, and what is happening. */
async function status(args: string[], app: string, project: Project): Promise<number> {
  const loaded = loadHarnesses();
  const selection = await selectProfile(loaded, flag(args, "harness"));
  const running = runningBridge(project.dir);

  let ladder: RungReport[] = [];
  let mode: string | null = null;
  if (selection.profile !== null) {
    const chosen = await chooseRoute(selection.profile);
    ladder = chosen.ladder;
    mode = chosen.route?.mode ?? null;
  }

  let waiting: number | null = null;
  try {
    const { client } = await connect(app);
    waiting = await countWaiting(client);
  } catch {
    waiting = null; // the app is not up; that is reported, not fatal
  }

  const report = {
    a2app: true,
    app: { id: project.manifest.id, name: project.manifest.name },
    harness: selection.profile === null ? null : { id: selection.profile.id, name: selection.profile.name ?? null },
    why: selection.why,
    mode,
    supported: mode !== null,
    ladder,
    running,
    tasksWaiting: waiting,
    config: existsSync(harnessesPath()) ? harnessesPath() : null,
    profiles: loaded.profiles.map((p) => p.id),
  };

  if (running !== null) log.ok(`bridge running (pid ${running.pid}) — ${running.harness} via ${running.mode}`);
  else log.info("no bridge is running for this app");
  if (selection.profile === null) log.warn(selection.why);
  else if (mode === null) explainNoRoute(app, ladder);
  else if (mode === "subscribe") log.info(`${selection.profile.id} subscribes — start it to be shown the listen command`);
  else log.info(`ready: ${selection.profile.id} via ${mode} (${selection.why})`);
  if (waiting !== null && waiting > 0) log.info(`${waiting} task(s) waiting in the queue`);
  for (const line of logTail(project.dir)) log.info(`  log: ${line}`);

  log.raw(JSON.stringify(report, null, 2));
  return 0;
}

/** Re-launch this same CLI as a detached background bridge. */
async function startBackground(passthrough: string[], app: string, project: Project): Promise<number> {
  // Re-check under the lock. The check before the lock keeps the common case
  // cheap; this one is what makes two simultaneous `start`s spawn one bridge
  // rather than two, which would double every delivery.
  const already = runningBridge(project.dir);
  if (already !== null) {
    log.ok(`a bridge is already running for this app (pid ${already.pid}, ${already.harness} via ${already.mode})`);
    log.raw(JSON.stringify({ ok: true, started: false, alreadyRunning: true, ...already }, null, 2));
    return 0;
  }
  mkdirSync(join(project.dir, ".a2app"), { recursive: true });
  const entry = fileURLToPath(new URL("../agent-app.js", import.meta.url));
  const outFd = openSync(bridgeLogPath(project.dir), "a");
  // The child is handed the RESOLVED directory, never the string the caller
  // typed. It runs with its own working directory, so a relative `apps/thing`
  // would resolve against that instead — and the bridge would go looking for an
  // app inside the app.
  //
  // No shell, either: the arguments include user-supplied values, and a shell
  // would reinterpret them. `serve` may use one because a manifest pipeline is
  // a trusted string; nothing on this line is.
  const child = spawn(process.execPath, [entry, project.dir, "bridge", "start", "--foreground", ...passthrough], {
    cwd: project.dir,
    detached: true,
    shell: false,
    stdio: ["ignore", outFd, outFd],
  });
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });
  if (child.pid === undefined) {
    log.error(`could not start the bridge${spawnError ? `: ${(spawnError as Error).message}` : ""}`);
    return 1;
  }
  child.unref();

  // The child records itself, so the pid in the file is the process that is
  // really polling — never a parent's guess that survives the child dying at
  // startup. Wait for that record to appear, and report the log if it does not.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rec = readBridgeRecord(project.dir);
    if (rec !== null && rec.pid === child.pid) {
      log.ok(`bridge started (pid ${rec.pid}) — ${rec.harness} via ${rec.mode}, polling every ${rec.intervalMs}ms`);
      log.info(`log: ${bridgeLogPath(project.dir)} · stop it: agent-app ${app} bridge stop`);
      log.raw(JSON.stringify({ ok: true, started: true, ...rec }, null, 2));
      return 0;
    }
    if (!isPidAlive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  killTreeForce(child.pid);
  clearBridgeRecord(project.dir);
  log.error(`the bridge did not come up — see ${bridgeLogPath(project.dir)}`);
  for (const line of logTail(project.dir, 12)) log.error(`  ${line}`);
  return 1;
}

/** A `--flag <ms>` that must be a number, rejected as a usage error when it is not. */
function millis(args: string[], name: string, fallback: number, floor: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < floor) {
    throw new UsageError(`--${name} takes a number of milliseconds >= ${floor} (got ${raw})`);
  }
  return value;
}

async function start(args: string[], app: string, project: Project): Promise<number> {
  const already = runningBridge(project.dir);
  if (already !== null) {
    log.ok(`a bridge is already running for this app (pid ${already.pid}, ${already.harness} via ${already.mode})`);
    log.raw(JSON.stringify({ ok: true, started: false, alreadyRunning: true, ...already }, null, 2));
    return 0;
  }

  // Parse every option HERE, before the fork in the road. A background start
  // that only discovered `--interval banana` inside its own detached child
  // would report "the bridge did not come up" and make the caller read a log to
  // find a typo the parent could have named.
  const intervalMs = millis(args, "interval", DEFAULT_INTERVAL_MS, 250);
  const taskTimeoutMs = millis(args, "task-timeout", DEFAULT_TASK_TIMEOUT_MS, 1_000);
  const capabilities = flagAll(args, "capability");
  const harnessFlag = flag(args, "harness");
  const dryRun = hasFlag(args, "dry-run");

  const loaded = loadHarnesses();
  const selection = await selectProfile(loaded, harnessFlag);
  if (selection.profile === null) {
    log.error(selection.why);
    log.info(`profiles known here: ${loaded.profiles.map((p) => p.id).join(", ")} · configure more in ${harnessesPath()}`);
    return 1;
  }
  const profile = selection.profile;
  const { route, ladder } = await chooseRoute(profile);

  // Rung 5 — say so plainly. A bridge that "starts" and then delivers nothing
  // is worse than no bridge: the user believes their app can reach an agent.
  if (route === null) {
    explainNoRoute(app, ladder);
    log.raw(JSON.stringify({ ok: false, supported: false, harness: profile.id, ladder }, null, 2));
    return 1;
  }

  // Rung 4 — this harness cannot be triggered, only subscribed to. The
  // framework's half is the listen command; there is nothing to daemonize.
  if (route.mode === "subscribe") {
    log.ok(`${profile.id} is driven by its own background loop, not by delivery.`);
    log.info(
      `Run this inside the harness (it blocks until a task arrives, claims it, prints it, and exits):\n` +
        `  a2app ${app} tasks next --wait 60000\n` +
        `Loop it, and report each task with \`a2app ${app} tasks complete <id> …\`.` +
        (route.hint !== undefined ? `\n${route.hint}` : ""),
    );
    log.raw(
      JSON.stringify(
        { ok: true, started: false, mode: "subscribe", harness: profile.id, listen: `a2app ${app} tasks next --wait 60000` },
        null,
        2,
      ),
    );
    return 0;
  }

  const once = hasFlag(args, "once");
  if (!hasFlag(args, "foreground") && !once && !dryRun) {
    // Rebuild the child's arguments from what was parsed rather than filtering
    // the original tokens: a token-filter would strip a flag's VALUE if it
    // happened to read like a subcommand, leaving the child a valueless flag.
    const passthrough = ["--interval", String(intervalMs), "--task-timeout", String(taskTimeoutMs)];
    if (harnessFlag !== undefined) passthrough.push("--harness", harnessFlag);
    for (const capability of capabilities) passthrough.push("--capability", capability);
    return withLock(bridgeLockPath(project.dir), () => startBackground(passthrough, app, project));
  }

  // ---- foreground: this process is the bridge ----
  const { client, target } = await connect(app);
  const identity = await client.identity();
  if (identity === null) {
    throw new UsageError(
      `${project.manifest.name} is not answering at ${target.baseUrl}. A bridge polls a RUNNING app — ` +
        `launch it first: agent-app ${app} serve`,
    );
  }
  // Ask WHO answered, not just whether something did — the same discipline
  // `serve` and `stop` apply to a port. A bridge that polled a stranger holding
  // this port would take that stranger's tasks and start agent runs from them,
  // and every request would look perfectly successful while it did.
  if (identity.app?.id !== project.manifest.id) {
    throw new UsageError(
      `${target.baseUrl} is answering as "${identity.app?.id ?? "an app with no id"}", but this directory is ` +
        `"${project.manifest.id}". Refusing to take work from an app that is not the one addressed — ` +
        `something else is holding that port.`,
    );
  }

  let gatewayPid: number | undefined;
  if (route.mode === "gateway") {
    const up = await ensureGateway(route, project.dir);
    if (!up.ok) {
      log.error(`gateway not available: ${up.detail}`);
      return 1;
    }
    log.ok(up.detail);
    gatewayPid = up.pid;
    // A gateway outlives the run that started it, and only a LONG-RUNNING bridge
    // records its pid (in `.a2app/bridge.json`, for `bridge stop`). A one-shot
    // pass clears that record on the way out, so a gateway it started would be
    // left with nothing tracking it. That is the right behaviour — a gateway is
    // a service, and a cron'd `--once` should reuse it rather than restart it
    // every time — but it must be said, or the process becomes unstoppable by
    // anything except the task manager.
    if ((once || dryRun) && gatewayPid !== undefined) {
      log.warn(
        `this pass started the gateway (pid ${gatewayPid}) and it keeps running after the pass ends — ` +
          `later runs reuse it. \`bridge stop\` only takes down a gateway that a long-running ` +
          `\`bridge start\` owns, so stop this one by its pid when you are done with it.`,
      );
    }
  }

  const ctx: BridgeContext = {
    project,
    client,
    profile,
    route,
    // The prompt addresses the app by resolved directory, not by whatever the
    // caller typed: the harness is a separate process that may start anywhere,
    // and a relative path in its instructions would be a path to somewhere else.
    prompt: {
      appRef: project.dir,
      appName: project.manifest.name,
      appId: project.manifest.id,
      // Only a headless run's end is observable from here, so only a headless
      // run is promised a safety net.
      closesOnExit: route.mode === "headless",
    },
    taskTimeoutMs,
    capabilities: capabilities.length > 0 ? capabilities : null,
    dryRun,
  };

  let stop = false;
  const stopped = (): boolean => stop;
  const onSignal = (): void => {
    if (stop) return;
    stop = true;
    log.info("stopping after the current task…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // A dry run records nothing: it claims nothing and runs nothing, so it should
  // not leave a file behind either, however briefly.
  if (!dryRun) {
    writeBridgeRecord(project.dir, {
      pid: process.pid,
      harness: profile.id,
      mode: route.mode,
      intervalMs,
      startedAt: new Date().toISOString(),
      ...(gatewayPid !== undefined ? { gatewayPid } : {}),
    });
  }

  try {
    if (once || dryRun) {
      const result = await pumpOnce(ctx, stopped);
      if (dryRun) {
        log.ok(`dry run: ${result.prompts?.length ?? 0} of ${result.seen} waiting task(s) would be delivered — nothing was claimed or run`);
      } else {
        log.ok(`one pass: ${result.delivered} delivered, ${result.failed} failed, ${result.skipped} skipped of ${result.seen} waiting`);
      }
      log.raw(
        JSON.stringify({ ok: true, ...(dryRun ? { dryRun: true } : { once: true }), harness: profile.id, mode: route.mode, ...result }, null, 2),
      );
      return result.failed > 0 ? 1 : 0;
    }
    log.ok(`bridge up: ${project.manifest.name} → ${profile.id} via ${route.mode}, polling every ${intervalMs}ms`);
    await pumpLoop(ctx, intervalMs, stopped);
    log.ok("bridge stopped");
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    clearBridgeRecord(project.dir);
  }
}

/**
 * Stop the recorded bridge, with the same pid discipline `stop` uses on apps: a
 * recorded pid can have been reused after a reboot, so a record whose process is
 * gone is cleared rather than signalled, and a kill that does not take is
 * reported as a failure with the record KEPT for a retry — never as "stopped".
 */
async function stopBridge(project: Project, app: string): Promise<number> {
  return withLock(bridgeLockPath(project.dir), async () => {
    const rec = readBridgeRecord(project.dir);
    if (rec === null) {
      log.info("no bridge is recorded for this app");
      log.raw(JSON.stringify({ ok: true, stopped: null }, null, 2));
      return 0;
    }
    if (!isPidAlive(rec.pid)) {
      clearBridgeRecord(project.dir);
      log.info(`the recorded bridge (pid ${rec.pid}) is gone — cleared the record`);
      log.raw(JSON.stringify({ ok: true, stopped: null, cleared: true }, null, 2));
      return 0;
    }
    terminateTree(rec.pid);
    let exited = await waitForExit(rec.pid, 5_000);
    if (!exited) {
      killTreeForce(rec.pid);
      exited = await waitForExit(rec.pid, 2_000);
    }
    if (!exited) {
      log.error(`could not stop the bridge (pid ${rec.pid}) — it is still running. Record kept for a retry.`);
      log.raw(JSON.stringify({ ok: false, stopped: null, pid: rec.pid }, null, 2));
      return 1;
    }
    // A gateway this bridge started is ours to take down; one that was already
    // up when we arrived has no pid here and is left alone.
    if (rec.gatewayPid !== undefined && isPidAlive(rec.gatewayPid)) {
      killTreeForce(rec.gatewayPid);
      log.info(`also stopped the gateway this bridge started (pid ${rec.gatewayPid})`);
    }
    clearBridgeRecord(project.dir);
    log.ok(`bridge stopped (pid ${rec.pid})`);
    // Stopping takes the process tree, so a harness run in flight goes with it.
    // That task is not lost: it stays `working` until the app's own sweeper
    // returns it to the queue, which is the same path a crashed agent takes.
    log.info(
      `a task being worked on right now was interrupted; the app returns it to the queue by itself.\n` +
        `The app keeps queueing tasks either way — nothing will claim them until: agent-app ${app} bridge start`,
    );
    log.raw(JSON.stringify({ ok: true, stopped: rec.pid }, null, 2));
    return 0;
  });
}

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const [sub] = positionals(args);
  switch (sub) {
    case undefined:
    case "status":
      return status(args, app, project);
    case "start":
      return start(args, app, project);
    case "stop":
      return stopBridge(project, app);
    default:
      throw new UsageError(
        `unknown bridge subcommand "${sub}" — it is one of: status (the default), start, stop.`,
      );
  }
}
