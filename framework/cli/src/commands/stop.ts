/**
 * agent-app <dir> stop — stop an app launched with `agent-app <dir> serve`.
 *
 * Safe by construction: it only kills a recorded pid when it can confirm the app
 * is actually the one answering on its port (guarding against a reused pid after
 * a reboot signalling an innocent process), tries a graceful terminate before a
 * force-kill, and — crucially — keeps `.a2app/serve.json` if the kill did NOT
 * succeed, reporting the failure honestly rather than claiming "stopped".
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hasFlag } from "../lib/args.js";
import { readDevRecord, stopDevInstance, sweepDevBootDirs } from "../lib/instance.js";
import { lifecycleLock } from "../lib/lifecycle.js";
import { loadProject } from "../lib/project.js";
import { register } from "../lib/registry.js";
import { withLock } from "../lib/lock.js";
import { identifyApp } from "../lib/net.js";
import { isPidAlive, killTreeForce, terminateTree, waitForExit } from "../lib/proc.js";
import { log } from "../lib/log.js";

/**
 * `stop --dev`: tear down the DEV instance (abandoning the candidate) and
 * sweep its state. Serialized on the lifecycle lock — the same lock `dev` and
 * `promote` hold — because both also act on the dev record. The live app is
 * untouched; operate commands target it again once the record is gone.
 */
async function runStopDev(app: string, project: ReturnType<typeof loadProject>): Promise<number> {
  return withLock(lifecycleLock(project.dir), async () => {
    const rec = readDevRecord(project.dir);
    if (rec === null) {
      log.info("no dev instance recorded (.a2app/dev.json)");
      log.raw(JSON.stringify({ ok: true, stopped: null }, null, 2));
      return 0;
    }
    const outcome = await stopDevInstance(project.dir, project.manifest.id);
    if (outcome === "failed") {
      log.error(`could not stop the dev instance (pid ${rec.pid}) — it is still running. Record kept for a retry.`);
      log.raw(JSON.stringify({ ok: false, stopped: null, pid: rec.pid }, null, 2));
      return 1;
    }
    sweepDevBootDirs(project.dir, null);
    if (outcome === "stopped") log.ok(`dev instance stopped (pid ${rec.pid}) — candidate abandoned, state swept`);
    else log.info("dev record was stale (nothing answering as this app) — cleared and swept");
    log.info("operate commands target the live app again");
    log.raw(JSON.stringify({ ok: true, stopped: outcome === "stopped" ? rec.pid : null }, null, 2));
    return 0;
  });
}

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  if (hasFlag(args, "dev")) return runStopDev(app, project);
  // A dev instance is deliberately NOT stopped by a bare `stop` (the modify
  // flow stops live for promote while the candidate stays up) — but it must
  // never be invisible either, and the caller is at a fork with two exits.
  if (readDevRecord(project.dir) !== null) {
    log.info(
      `a dev instance is also recorded and keeps running.\n` +
        `  Promoting the change?   agent-app ${app} promote   (destroys the dev instance itself)\n` +
        `  Abandoning the change?  agent-app ${app} stop --dev`,
    );
  }
  const serveLock = join(project.dir, ".a2app", "serve.lock");

  return withLock(serveLock, async () => {
    const servePath = join(project.dir, ".a2app", "serve.json");

    const clearRecord = async (): Promise<void> => {
      rmSync(servePath, { force: true });
      // Keep the index current on the way down: an app whose path/port moved is
      // corrected here rather than drifting. Unwritable index never fails a stop.
      try {
        await register({
          id: project.manifest.id,
          name: project.manifest.name,
          path: project.dir,
          ...(project.manifest.port !== undefined ? { port: project.manifest.port } : {}),
        });
      } catch {
        /* best effort */
      }
    };

    if (!existsSync(servePath)) {
      log.info("not serving (no .a2app/serve.json)");
      log.raw(JSON.stringify({ ok: true, stopped: null }, null, 2));
      return 0;
    }

    const rec = (() => {
      try {
        return JSON.parse(readFileSync(servePath, "utf8")) as { pid?: number };
      } catch {
        return {};
      }
    })();
    const pid = rec.pid;

    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
      log.warn(`serve.json has no usable pid — clearing the record without killing anything.`);
      await clearRecord();
      log.raw(JSON.stringify({ ok: true, stopped: null }, null, 2));
      return 0;
    }

    // PID-reuse guard: only kill when we can confirm THIS app is the one on its
    // port. If it is not answering as itself, the recorded pid is stale or has
    // been reused by an unrelated process — clear the record, never kill it.
    const appPort = project.manifest.port;
    if (appPort !== undefined) {
      const servingId = await identifyApp(appPort);
      if (servingId !== project.manifest.id) {
        log.info(
          `this app is not answering on port ${appPort} (recorded pid ${pid}) — clearing a stale serve record without killing.`,
        );
        await clearRecord();
        log.raw(JSON.stringify({ ok: true, stopped: null }, null, 2));
        return 0;
      }
    } else if (!isPidAlive(pid)) {
      log.info(`recorded process (pid ${pid}) is not running — clearing stale record.`);
      await clearRecord();
      log.raw(JSON.stringify({ ok: true, stopped: null }, null, 2));
      return 0;
    }

    // Graceful, then force.
    terminateTree(pid);
    let exited = await waitForExit(pid, 3000);
    if (!exited) {
      killTreeForce(pid);
      exited = await waitForExit(pid, 2000);
    }

    if (!exited) {
      // Do NOT clear the record on a failed kill: reporting "stopped" while the
      // process is still alive is the failure mode this guards against.
      log.error(`could not stop pid ${pid} — it is still running. Kept ${servePath} for a retry.`);
      log.raw(JSON.stringify({ ok: false, stopped: null, pid }, null, 2));
      return 1;
    }

    await clearRecord();
    log.ok(`stopped (pid ${pid})`);
    log.raw(JSON.stringify({ ok: true, stopped: pid }, null, 2));
    return 0;
  });
}
