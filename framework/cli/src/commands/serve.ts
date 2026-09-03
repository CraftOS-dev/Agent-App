/**
 * agent-app <dir> serve [--install]
 *
 * Launch a running Agent App the framework way — never "start a server by hand".
 * Runs the manifest `pipeline` (optionally `install`, then `build`, then `start`)
 * as a MANAGED BACKGROUND process bound to `manifest.port` (the same port the
 * operate commands read), polls `pipeline.health` until the app answers, and
 * records `.a2app/serve.json` so `agent-app stop` can shut it down. Server stdout is
 * captured to `.a2app/serve.log` for diagnosis.
 *
 * Guarantees: idempotent (a second serve of THIS app reports the existing
 * instance; a port held by a DIFFERENT app or a stranger fails loudly, never a
 * silent second start); no orphans (a launch that never becomes healthy is
 * killed and its record cleared); serialized per app (a serve.lock prevents two
 * concurrent serves racing to spawn two processes).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../lib/project.js";
import { portInUse, register } from "../lib/registry.js";
import { withLock } from "../lib/lock.js";
import { fetchWithTimeout, identifyApp } from "../lib/net.js";
import { killTreeForce } from "../lib/proc.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, 2000);
      if (res.ok) return true;
    } catch {
      /* not up yet, or this probe timed out — keep polling until the deadline */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function readServe(file: string): { pid: number } | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { pid: number };
  } catch {
    return null;
  }
}

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const pipeline = project.manifest.pipeline;
  const port = project.manifest.port ?? 8090;
  const healthUrl = `${project.baseUrl}${pipeline?.health ?? "/api/_a2app"}`;
  if (!pipeline?.start) {
    log.error("manifest.pipeline.start is empty — nothing to launch");
    return 1;
  }

  // Index the app before anything else, so an app that was never created here
  // (imported, cloned, or already running) still shows up in `agent-app list`.
  // Convenience only: an unwritable index never fails a launch.
  try {
    await register({ id: project.manifest.id, name: project.manifest.name, path: project.dir, port });
  } catch (err) {
    log.warn(`could not update the app registry: ${(err as Error).message}`);
  }

  mkdirSync(join(project.dir, ".a2app"), { recursive: true });
  const serveLock = join(project.dir, ".a2app", "serve.lock");
  // Serialize serve/stop for this app: two concurrent serves must not both pass
  // the idempotency check and spawn two processes.
  return withLock(serveLock, async () => {
    const servePath = join(project.dir, ".a2app", "serve.json");

    // Idempotency + safety: if the port is already answering, find out WHO.
    if (await portInUse(port)) {
      const servingId = await identifyApp(port);
      if (servingId === project.manifest.id) {
        const prev = readServe(servePath);
        log.ok(`already serving on ${project.baseUrl}${prev ? ` (pid ${prev.pid})` : ""}`);
        log.raw(
          JSON.stringify({ ok: true, url: project.baseUrl, pid: prev?.pid ?? null, alreadyRunning: true }, null, 2),
        );
        return 0;
      }
      if (servingId !== null) {
        log.error(
          `port ${port} is held by a DIFFERENT Agent App (id ${servingId}) — refusing to start a second instance. ` +
            `Stop that app, or change this app's manifest.port.`,
        );
        return 1;
      }
      log.error(
        `port ${port} is already in use by another process (not an Agent App) — free it or change manifest.port.`,
      );
      return 1;
    }

    if (args.includes("--install") && pipeline.install) {
      log.step(`install: ${pipeline.install}`);
      runShell(pipeline.install, project.dir);
    }
    if (pipeline.build) {
      log.step(`build: ${pipeline.build}`);
      runShell(pipeline.build, project.dir);
    }

    const outFd = openSync(join(project.dir, ".a2app", "serve.log"), "a");
    const child = spawn(pipeline.start, {
      cwd: project.dir,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: ["ignore", outFd, outFd],
      shell: true,
    });
    // A spawn failure (e.g. shell not found) arrives asynchronously as 'error';
    // capture it so it becomes a clean failure, not an unhandled rejection.
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    if (child.pid === undefined) {
      log.error(`failed to spawn: ${pipeline.start}${spawnError ? ` (${(spawnError as Error).message})` : ""}`);
      return 1;
    }
    const pid = child.pid;
    // Record the pid BEFORE polling health, so a launch that never becomes
    // healthy can still be found and killed (no untracked orphan on the port).
    writeFileSync(
      servePath,
      JSON.stringify({ pid, port, url: project.baseUrl, startedAt: new Date().toISOString(), healthy: false }, null, 2) +
        "\n",
    );
    child.unref();

    log.step(`launching: ${pipeline.start} (port ${port})`);
    const healthy = await pollHealth(healthUrl, 20_000);
    if (spawnError || !healthy) {
      // Kill the process we started and clear the record — never leave an
      // orphan holding the port that `stop` cannot find.
      killTreeForce(pid);
      rmSync(servePath, { force: true });
      const why = spawnError
        ? `failed to launch: ${(spawnError as Error).message}`
        : `app did not become healthy at ${healthUrl} within 20s`;
      log.error(`${why} — see ${join(project.dir, ".a2app", "serve.log")}`);
      return 1;
    }

    writeFileSync(
      servePath,
      JSON.stringify({ pid, port, url: project.baseUrl, startedAt: new Date().toISOString(), healthy: true }, null, 2) +
        "\n",
    );
    log.ok(`serving "${project.manifest.name}" on ${project.baseUrl} (pid ${pid})`);
    log.raw(JSON.stringify({ ok: true, url: project.baseUrl, pid, port }, null, 2));
    return 0;
  });
}
