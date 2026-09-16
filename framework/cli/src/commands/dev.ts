/**
 * agent-app <dir> dev — boot the DEV SERVER: the candidate code on a hidden
 * port with a fresh database (framework spec 7.2).
 *
 * Nothing is copied. The dev environment is the project's OWN tree booted a
 * second time with redirected inputs — `PORT` (an OS-assigned hidden port),
 * `A2APP_DATA_DIR` (a fresh per-boot data directory under `.a2app/dev/`), and
 * `A2APP_ENV=dev` — through the same `manifest.pipeline.start` that `serve`
 * runs. The tree's code IS the candidate being exercised; the live app (if
 * serving) keeps running the code and data it loaded at its own boot,
 * untouched.
 *
 * Every call is a FRESH boot: new boot dir, new port, database rebuilt from
 * nothing by the stack's own bootstrap (for a migration stack, replaying the
 * full chain — which re-proves the chain on every iteration, exactly what the
 * spec demands). The previous dev instance is stopped with the same pid-reuse
 * discipline as `stop`; a survivor cannot collide with the new boot (fresh dir,
 * fresh port) and its directory is swept later.
 *
 * While the dev record exists, EVERY operate command (`a2app` walk/data/…,
 * and `validate`'s describe-budget walk) targets the dev instance — see
 * `operateTarget` in lib/project.ts. That is how test data stays out of the
 * live database, and how `validate` measures the candidate rather than the
 * promoted build.
 *
 * Safety is structural, in this order:
 *   1. the ownership canon is verified before anything runs — the launcher
 *      honoring the data-dir redirect is a hash-locked system file, so a
 *      verified canon is what makes the redirect trustworthy;
 *   2. the toolkit's optional `lifecycle.dev` prepare step (an app-local
 *      script, not canon-covered) is fingerprint-checked against the live data
 *      directory when live is not serving — and when live IS serving, its data
 *      directory is held by the live process and the canon carries the
 *      guarantee;
 *   3. the booted instance must answer the health URL AND identify as this
 *      app before the launch is reported up.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifySystemHashes } from "../lib/canon.js";
import { clearDevRecord, devJsonPath, mintDevBootDir, readDevRecord, stopDevInstance, sweepDevBootDirs } from "../lib/instance.js";
import { dataDir, dataFingerprint, lifecycleCommand, lifecycleLock } from "../lib/lifecycle.js";
import { withLock } from "../lib/lock.js";
import { freeEphemeralPort, identifyApp, pollHealth } from "../lib/net.js";
import { killTreeForce } from "../lib/proc.js";
import { loadProject } from "../lib/project.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";

/** The last lines of this boot's log, for a failure report that explains itself. */
function logTail(file: string, lines = 30): string {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const pipeline = project.manifest.pipeline;

  if (project.manifest.modificationLock === true) {
    log.error(
      "this app is modification-locked (manifest.modificationLock) — no agent may modify its code, " +
        "so there is nothing a dev environment could safely be used for. Only the owner clears the lock.",
    );
    return 1;
  }
  if (!pipeline?.start) {
    log.error("manifest.pipeline.start is empty — nothing to launch");
    return 1;
  }
  if (dataDir(project.dir) === null) {
    log.error(
      "this app's toolkit declares no `lifecycle.dataDir` — without it the framework cannot tell live " +
        "data from anything else, so a dev environment cannot be proven safe. Declare it in a2app.toolkit.json.",
    );
    return 1;
  }

  mkdirSync(join(project.dir, ".a2app"), { recursive: true });
  return withLock(lifecycleLock(project.dir), async () => {
    // Ownership canon FIRST (same as serve): `pipeline.start` and the launcher
    // that honors A2APP_DATA_DIR are canon-covered system files. This check is
    // the load-bearing guarantee that the redirect below will be respected.
    const drift = verifySystemHashes(project.dir);
    const drifted = [
      ...drift.modified.map((p) => `modified: ${p}`),
      ...drift.missing.map((p) => `deleted: ${p}`),
      ...drift.added.map((p) => `added: ${p}`),
    ];
    if (drifted.length > 0) {
      log.error(
        `refusing to boot — system-managed files changed outside tooling:\n${drifted.join("\n")}\n` +
          "If a toolkit upgrade is intended, run `agent-app <dir> toolkit-sync`; agent edits belong in app-owned paths.",
      );
      return 1;
    }

    // Evict the previous dev instance. "failed" keeps its record so nothing is
    // orphaned invisibly — but the boot proceeds regardless: the fresh dir and
    // fresh port mean a survivor cannot collide, only delay its own sweep.
    const previous = readDevRecord(project.dir);
    if (previous !== null) {
      const outcome = await stopDevInstance(project.dir, project.manifest.id);
      if (outcome === "stopped") log.step(`stopped previous dev instance (pid ${previous.pid})`);
      else if (outcome === "failed")
        log.warn(
          `previous dev instance (pid ${previous.pid}) would not die — booting fresh anyway; ` +
            "its directory will be swept once it exits",
        );
    }

    const bootDir = mintDevBootDir(project.dir);
    const devDataDir = join(bootDir, "data");
    sweepDevBootDirs(project.dir, bootDir);

    // The toolkit's optional prepare step (seed a store, prove a schema loads).
    // It is app-local code, not canon-covered, so when live is not serving —
    // its data directory unheld and mutable — prove it did not touch live data.
    const prepare = lifecycleCommand(project.dir, "dev");
    if (prepare !== null) {
      const liveServing = (await identifyApp(project.manifest.port ?? 8090)) === project.manifest.id;
      const before = liveServing ? null : dataFingerprint(project.dir);
      log.step(`prepare (lifecycle.dev): ${prepare}`);
      try {
        const out = runShell(prepare, project.dir, { env: { A2APP_DATA_DIR: devDataDir, A2APP_ENV: "dev" } });
        if (out.stdout.trim()) log.raw(out.stdout.trim());
      } catch (err) {
        log.error(`lifecycle.dev failed: ${(err as Error).message}`);
        return 1;
      }
      if (!liveServing && before !== dataFingerprint(project.dir)) {
        log.error(
          "SAFETY VIOLATION: the toolkit's lifecycle.dev command modified the LIVE data directory. " +
            "dev must only ever write the fresh directory it is given (A2APP_DATA_DIR). " +
            "Aborting — fix lifecycle.dev in the toolkit.",
        );
        return 1;
      }
    }

    const port = await freeEphemeralPort();
    const url = `http://127.0.0.1:${port}`;
    const logPath = join(bootDir, "dev.log");
    const outFd = openSync(logPath, "a");
    const child = spawn(pipeline.start, {
      cwd: project.dir,
      env: { ...process.env, PORT: String(port), A2APP_DATA_DIR: devDataDir, A2APP_ENV: "dev" },
      detached: true,
      stdio: ["ignore", outFd, outFd],
      shell: true,
    });
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    if (child.pid === undefined) {
      log.error(`failed to spawn: ${pipeline.start}${spawnError ? ` (${(spawnError as Error).message})` : ""}`);
      return 1;
    }
    const pid = child.pid;
    // Record BEFORE polling health, so a launch that never becomes healthy can
    // still be found and killed — no untracked orphan.
    writeFileSync(
      devJsonPath(project.dir),
      JSON.stringify({ pid, port, url, bootDir, startedAt: new Date().toISOString(), healthy: false }, null, 2) + "\n",
    );
    child.unref();

    log.step(`booting the candidate: ${pipeline.start} (hidden port ${port}, fresh data at ${devDataDir})`);
    const healthy = await pollHealth(`${url}${pipeline.health ?? "/api/_a2app"}`, 20_000);
    // The port must not merely answer — it must answer AS THIS APP. A stolen
    // port or a half-booted stranger fails here, loudly.
    const answersAs = healthy ? await identifyApp(port) : null;
    if (spawnError || !healthy || answersAs !== project.manifest.id) {
      killTreeForce(pid);
      clearDevRecord(project.dir);
      const why = spawnError
        ? `failed to launch: ${(spawnError as Error).message}`
        : !healthy
          ? `the app did not become healthy at ${url}${pipeline.health ?? "/api/_a2app"} within 20s`
          : `port ${port} answered as ${answersAs === null ? "something that is not this app" : `app id ${answersAs}`}`;
      const tail = logTail(logPath);
      log.error(`${why} — see ${logPath}`);
      if (tail) log.raw(tail);
      return 1;
    }

    writeFileSync(
      devJsonPath(project.dir),
      JSON.stringify({ pid, port, url, bootDir, startedAt: new Date().toISOString(), healthy: true }, null, 2) + "\n",
    );

    log.ok(`dev instance of "${project.manifest.name}" is up at ${url} (pid ${pid})`);
    log.info("fresh database — only what your migrations/seed create exists; test data here is disposable");
    log.info("all `a2app` operate commands and `validate` now target this instance until promote or `stop --dev`");
    log.info(`next, for this app: validate → walk-verify (skill) → stop → promote → serve`);
    log.raw(
      JSON.stringify(
        { ok: true, id: project.manifest.id, name: project.manifest.name, url, port, pid, env: "dev", log: logPath },
        null,
        2,
      ),
    );
    return 0;
  });
}
