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
import { loadProject } from "../lib/project.js";
import { register } from "../lib/registry.js";
import { withLock } from "../lib/lock.js";
import { identifyApp } from "../lib/net.js";
import { isPidAlive, killTreeForce, terminateTree, waitForExit } from "../lib/proc.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
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
