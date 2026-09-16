/**
 * agent-app <dir> promote — deploy the verified candidate to live.
 *
 * Refusals come first and are structural, never flags:
 *   1. a fresh GATE PASS is required — recorded by `validate` on success and
 *      keyed to a fingerprint of the exact tree it gated. Missing pass, a tree
 *      edited since, or a pass whose describe-budget walk never ran against
 *      the candidate (no dev instance was up) each refuse with the remedy.
 *      The pass is consumed on success, so one validation never covers two
 *      promotions.
 *   2. the app must not be serving (mutating an open data directory tears it,
 *      especially on Windows).
 *   3. the mandatory pre-promote backup must succeed (first install excepted,
 *      decided structurally: does a live database exist?).
 *
 * Then the toolkit's `lifecycle.promote` applies the new migrations to the
 * live database. On success the dev instance is destroyed and its state swept
 * — operate traffic snaps back to live; on failure BOTH the dev instance and
 * the gate pass are kept for the retry (the code did not change; the pass is
 * still true of it).
 */
import { loadProject } from "../lib/project.js";
import {
  assertNotServing,
  backupId,
  clearGatePass,
  codeFingerprint,
  dataDir,
  lifecycleCommand,
  lifecycleLock,
  liveExists,
  readGatePass,
  takeBackup,
} from "../lib/lifecycle.js";
import { readDevRecord, stopDevInstance, sweepDevBootDirs } from "../lib/instance.js";
import { withLock } from "../lib/lock.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);

  if (project.manifest.modificationLock === true) {
    log.error(
      "this app is modification-locked (manifest.modificationLock) — its code may not be changed, " +
        "so there is nothing to promote. Only the owner clears the lock.",
    );
    return 1;
  }

  return withLock(lifecycleLock(project.dir), async () => {
    // The ordering gate, before anything irreversible (no backups for a doomed
    // promote). See lib/lifecycle.ts "gate pass" for why this is the honest
    // boundary of CLI enforcement.
    const pass = readGatePass(project.dir);
    if (pass === null) {
      log.error(
        "no gate pass — this tree has not been validated. Run:\n" +
          `  agent-app ${app} dev        (boot the candidate)\n` +
          `  agent-app ${app} validate   (the gate; records the pass)\n` +
          "then walk-verify, and promote again.",
      );
      return 1;
    }
    if (pass.fingerprint !== codeFingerprint(project.dir)) {
      log.error(
        "the code changed since the last validate — the recorded gate pass is for a different tree. " +
          `Run \`agent-app ${app} validate\` again (with the dev instance up), then promote.`,
      );
      return 1;
    }
    if (!pass.budgetChecked) {
      log.error(
        "the gate pass is incomplete: the describe-budget step never ran against the candidate. " +
          `Boot it with \`agent-app ${app} dev\`, run \`agent-app ${app} validate\`, then promote.`,
      );
      return 1;
    }

    await assertNotServing(project);

    const cmd = lifecycleCommand(project.dir, "promote");
    if (cmd === null) {
      log.error("this app's toolkit declares no `lifecycle.promote` command");
      return 1;
    }

    let backup: string | null = null;
    if (liveExists(project.dir)) {
      // Mandatory pre-promote backup: failure aborts the promotion.
      try {
        const id = backupId(new Date(), "pre-promote");
        const path = takeBackup(project.dir, id);
        backup = id;
        log.ok(`pre-promote backup ${id} (${path})`);
      } catch (err) {
        log.error(`pre-promote backup FAILED — aborting promotion: ${(err as Error).message}`);
        return 1;
      }
    } else {
      log.info("first install (no live database yet) — no pre-promote backup needed");
    }

    try {
      // The same launch contract every toolkit script gets: promote acts on
      // LIVE, so the env names the live data directory.
      const liveDataDir = dataDir(project.dir);
      const out = runShell(cmd, project.dir, {
        env: { A2APP_ENV: "live", ...(liveDataDir !== null ? { A2APP_DATA_DIR: liveDataDir } : {}) },
      });
      if (out.stdout.trim()) log.raw(out.stdout.trim());
    } catch (err) {
      // The dev instance and the gate pass are both KEPT: the live app is the
      // casualty being repaired, and the next attempt needs them.
      log.error(`promotion failed — the dev instance is kept for retry: ${(err as Error).message}`);
      if (backup !== null) log.info(`live database unchanged; restore point: ${backup}`);
      return 1;
    }

    // One validation covers one promotion — consume the pass.
    clearGatePass(project.dir);

    // Destroy the dev environment: operate traffic goes back to live the
    // moment the record is gone. A kill that fails keeps the record (honest),
    // but the promote itself has already succeeded and says so.
    const dev = readDevRecord(project.dir);
    if (dev !== null) {
      const outcome = await stopDevInstance(project.dir, project.manifest.id);
      if (outcome === "failed") {
        log.warn(
          `the dev instance (pid ${dev.pid}) would not die — its record is kept; ` +
            `run \`agent-app ${app} stop --dev\` to retry the teardown`,
        );
      } else {
        sweepDevBootDirs(project.dir, null);
        log.ok("dev instance destroyed — operate commands target the live app again");
      }
    }

    // Promotion runs with the app STOPPED (assertNotServing above), so nothing
    // is live yet — say the one thing that has to happen next. Left implicit,
    // this is where the loop breaks: the code is promoted, the user believes
    // they are done, and the tab they still have open keeps running the old
    // build with nothing to tell them otherwise.
    log.ok("promoted to live");
    log.info(`launch it: agent-app ${app} serve`);
    log.info(
      "a tab left open on the old build will offer a reload once the app is back " +
        "(it never reloads by itself — unsaved input is safe)",
    );
    log.raw(JSON.stringify({ ok: true, backup, next: `agent-app ${app} serve` }, null, 2));
    return 0;
  });
}
