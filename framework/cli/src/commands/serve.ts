/**
 * agent-app <dir> serve [--install] [--open]
 *
 * Launch a running Agent App the framework way — never "start a server by hand".
 * Runs the manifest `pipeline` (optionally `install`, then `build`, then `start`)
 * as a MANAGED BACKGROUND process bound to `manifest.port` (the same port the
 * operate commands read), polls `pipeline.health` until the app answers, and
 * records `.a2app/serve.json` so `agent-app stop` can shut it down. Server stdout is
 * captured to `.a2app/serve.log` for diagnosis.
 *
 * With `--open`, a healthy launch is also shown to the human via the opener
 * ladder in `open.ts` (harness-declared command, else the OS browser, else the
 * printed URL). Opening is OFF by default: `serve` is also called by paths that
 * are not a hand-off to a person — the idempotency check, and re-running the
 * gate for the describe budget — and those must never pop a window.
 *
 * Guarantees: idempotent (a second serve of THIS app reports the existing
 * instance; a port held by a DIFFERENT app or a stranger fails loudly, never a
 * silent second start); no orphans (a launch that never becomes healthy is
 * killed and its record cleared); serialized per app (a serve.lock prevents two
 * concurrent serves racing to spawn two processes).
 */
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifySystemHashes } from "../lib/canon.js";
import { hasFlag } from "../lib/args.js";
import { openUrl } from "./open.js";
import { loadProject } from "../lib/project.js";
import { portInUse, register } from "../lib/registry.js";
import { readDevRecord } from "../lib/instance.js";
import { dataDir } from "../lib/lifecycle.js";
import { withLock } from "../lib/lock.js";
import { appPort, identifyApp, pollHealth } from "../lib/net.js";
import { killTreeForce, spawnBackgroundShell } from "../lib/proc.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";
import { agentWorkLine, appCommand, inspectAgentWork, printLine } from "../lib/delivery.js";

function readServe(file: string): { pid: number } | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { pid: number };
  } catch {
    return null;
  }
}

export interface ServeOptions {
  /** run `pipeline.install` first (`--install`) */
  install?: boolean;
  /** run `pipeline.build` first — on unless the caller has just built this exact tree */
  build?: boolean;
  /** show the healthy app to a person (`--open`) */
  open?: boolean;
}

/** What a serve did: its exit code, the result document, and on failure why. */
export interface ServeOutcome {
  code: number;
  result: Record<string, unknown> | null;
  error?: string;
}

export async function run(args: string[], app: string): Promise<number> {
  const outcome = await serveApp(app, { install: hasFlag(args, "install"), open: hasFlag(args, "open") });
  if (outcome.result !== null) log.raw(JSON.stringify(outcome.result, null, 2));
  return outcome.code;
}

/**
 * Serve an app and report the outcome rather than print it: diagnostics go to
 * stderr and nothing to stdout, so the install pipeline can run this as its
 * serve step and still own its output.
 */
export async function serveApp(app: string, opts: ServeOptions = {}): Promise<ServeOutcome> {
  const project = loadProject(app);
  const pipeline = project.manifest.pipeline;
  const port = appPort(project.manifest);
  const healthUrl = `${project.baseUrl}${pipeline?.health ?? "/api/_a2app"}`;
  const fail = (message: string): ServeOutcome => {
    log.error(message);
    return { code: 1, result: null, error: message };
  };
  // `--open` is a hand-off to a person, so it runs only once the app is healthy —
  // never before, or the browser races the server and lands on a refused port.
  const show = async (): Promise<Record<string, unknown>> => {
    if (opts.open !== true) return {};
    const outcome = await openUrl(project.baseUrl, false);
    if (outcome.opened) log.ok(`opened ${project.baseUrl} (${outcome.via})`);
    else log.warn(`could not open a browser (${outcome.reason ?? "unknown"}) — open this yourself: ${project.baseUrl}`);
    return { opened: outcome.opened, via: outcome.via, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}) };
  };

  if (!pipeline?.start) return fail("manifest.pipeline.start is empty — nothing to launch");

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
  return withLock(serveLock, async (): Promise<ServeOutcome> => {
    const servePath = join(project.dir, ".a2app", "serve.json");

    // Idempotency + safety: if the port is already answering, find out WHO.
    if (await portInUse(port)) {
      const servingId = await identifyApp(port);
      if (servingId === project.manifest.id) {
        const prev = readServe(servePath);
        log.ok(`already serving on ${project.baseUrl}${prev ? ` (pid ${prev.pid})` : ""}`);
        // The port just answered as this app, so the check need not ask again.
        const agentWork = await inspectAgentWork(project.dir, project.manifest.id, project.baseUrl, { identityVerified: true });
        printLine(agentWorkLine(agentWork, app));
        const shown = await show();
        return {
          code: 0,
          result: {
            ok: true,
            id: project.manifest.id,
            name: project.manifest.name,
            url: project.baseUrl,
            pid: prev?.pid ?? null,
            alreadyRunning: true,
            agentWork,
            ...shown,
          },
        };
      }
      if (servingId !== null) {
        return fail(
          `port ${port} is held by a DIFFERENT Agent App (id ${servingId}) — refusing to start a second instance. ` +
            `Stop that app, or change this app's manifest.port.`,
        );
      }
      return fail(`port ${port} is already in use by another process (not an Agent App) — free it or change manifest.port.`);
    }

    // Ownership canon, before any of the app's own commands run. Launch is the
    // only path that reaches an app a user already has, so a system file swapped
    // for a weakened version between builds would otherwise run unchallenged
    // until someone re-ran the gate. The pipeline strings themselves live in the
    // canonized manifest, so this must precede install/build/start.
    const drift = verifySystemHashes(project.dir);
    const drifted = [
      ...drift.modified.map((p) => `modified: ${p}`),
      ...drift.missing.map((p) => `deleted: ${p}`),
      ...drift.added.map((p) => `added: ${p}`),
    ];
    if (drifted.length > 0) {
      return fail(
        `refusing to launch — system-managed files changed outside tooling:\n${drifted.join("\n")}\n` +
          "If a toolkit upgrade is intended, run `agent-app <dir> toolkit-sync`; agent edits belong in app-owned paths.",
      );
    }

    if (opts.install === true && pipeline.install) {
      log.step(`install: ${pipeline.install}`);
      runShell(pipeline.install, project.dir);
    }
    if (opts.build !== false && pipeline.build) {
      log.step(`build: ${pipeline.build}`);
      runShell(pipeline.build, project.dir);
    }

    const outFd = openSync(join(project.dir, ".a2app", "serve.log"), "a");
    // The launch contract, uniform across environments: PORT, A2APP_DATA_DIR
    // (the toolkit's declared live data directory) and A2APP_ENV. `dev` sets
    // the same three with a hidden port and a fresh directory — one code path
    // in every launcher, never a dev special case.
    const liveDataDir = dataDir(project.dir);
    const child = spawnBackgroundShell(pipeline.start, {
      cwd: project.dir,
      env: {
        ...process.env,
        PORT: String(port),
        A2APP_ENV: "live",
        ...(liveDataDir !== null ? { A2APP_DATA_DIR: liveDataDir } : {}),
      },
      stdio: ["ignore", outFd, outFd],
    });
    // A spawn failure (e.g. shell not found) arrives asynchronously as 'error';
    // capture it so it becomes a clean failure, not an unhandled rejection.
    let spawnError: Error | null = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    if (child.pid === undefined) {
      return fail(`failed to spawn: ${pipeline.start}${spawnError ? ` (${(spawnError as Error).message})` : ""}`);
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
      return fail(`${why} — see ${join(project.dir, ".a2app", "serve.log")}`);
    }

    writeFileSync(
      servePath,
      JSON.stringify({ pid, port, url: project.baseUrl, startedAt: new Date().toISOString(), healthy: true }, null, 2) +
        "\n",
    );
    log.ok(`serving "${project.manifest.name}" on ${project.baseUrl} (pid ${pid})`);
    // Queued agent work needs a bridge, which outlives this app and is never
    // started from here: starting agent runs is the user's call. Say whether
    // one is running, and what to type when one is needed.
    const agentWork = await inspectAgentWork(project.dir, project.manifest.id, project.baseUrl);
    printLine(agentWorkLine(agentWork, app));
    // A relaunch after a code change is the moment a tab opened earlier goes
    // stale, and the person looking at it has no way to know. The View's update
    // watcher tells them; say so here so the loop is visible from the terminal
    // too, and so `--open` is not mistaken for "everyone now has the new build".
    if (opts.open !== true) log.info(`show it to someone: ${appCommand(app, "open")}`);
    // A dev instance alongside a fresh live serve means an evolve is open, and
    // the caller is at a fork with exactly two exits. Name them — a warning
    // that states the fact without the decision is how this state gets missed.
    const dev = readDevRecord(project.dir);
    if (dev !== null) {
      log.warn(
        `a dev instance is still up (port ${dev.port}) and operate commands target IT, not this live app.\n` +
          `  Done with the change?   ${appCommand(app, "promote")}   (stop live first; destroys the dev instance)\n` +
          `  Abandoning the change?  ${appCommand(app, "stop --dev")}`,
      );
    }
    log.info("tabs already open are offered a reload; they are never reloaded out from under anyone");
    const shown = await show();
    return {
      code: 0,
      result: { ok: true, id: project.manifest.id, name: project.manifest.name, url: project.baseUrl, pid, port, agentWork, ...shown },
    };
  });
}
