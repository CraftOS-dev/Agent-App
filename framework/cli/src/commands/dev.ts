/**
 * agent-app <dir> dev — PREPARE a dev database: fresh, built by replaying the
 * full migration chain, with live data NEVER cloned. The stack-specific action is
 * the toolkit's `lifecycle.dev` command; the framework enforces the invariant the
 * toolkit cannot be trusted to keep — that dev did not touch the live data
 * directory — by fingerprinting it before and after.
 *
 * IT DOES NOT START A SERVER, and there is no dev URL. Earlier wording here
 * promised "a dev copy on a hidden port", which was never true of any shipped
 * toolkit: `lifecycle.dev` prepares a database and exits. The gap is real —
 * there is no supported way to exercise a change against a disposable copy
 * before promoting — and it is recorded as such rather than papered over, so
 * nobody spends an afternoon looking for a URL that does not exist.
 *
 * What IS supported today: `dev` (prove the schema replays clean) → `validate`
 * (the gate) → a verifier agent walk-verifying → `promote` → `serve`, which
 * exercises the change against the live app with a pre-promote backup taken
 * automatically as the way back.
 */
import { loadProject } from "../lib/project.js";
import { dataFingerprint, lifecycleCommand, lifecycleLock } from "../lib/lifecycle.js";
import { withLock } from "../lib/lock.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);

  return withLock(lifecycleLock(project.dir), async () => {
    const cmd = lifecycleCommand(project.dir, "dev");
    if (cmd === null) {
      log.error(
        "this app's toolkit declares no `lifecycle.dev` command — cannot boot a safe dev copy. " +
          "A stack-agnostic app must provide one before it can be safely evolved.",
      );
      return 1;
    }
    // Fingerprint live BEFORE, so we can prove dev did not clone/mutate it.
    const before = dataFingerprint(project.dir);
    log.step("preparing dev database (fresh, migration-replayed; no server is started)");
    const out = runShell(cmd, project.dir);
    if (out.stdout.trim()) log.raw(out.stdout.trim());
    const after = dataFingerprint(project.dir);
    if (before !== after) {
      log.error(
        "SAFETY VIOLATION: the toolkit's dev command modified the LIVE data directory " +
          `(fingerprint ${before ?? "none"} -> ${after ?? "none"}). dev must build a fresh copy only, ` +
          "never touch live data. Aborting — fix lifecycle.dev in the toolkit.",
      );
      return 1;
    }
    log.ok("dev database prepared (nothing is serving it — this command starts no server)");
    // Named without the app argument on purpose: repeating a long project path
    // four times buries the sequence, which is the part worth reading.
    log.info("next, for this app: validate → walk-verify (skill) → stop → promote → serve");
    return 0;
  });
}
