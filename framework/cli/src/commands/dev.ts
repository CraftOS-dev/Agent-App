/**
 * agent-app <dir> dev — prepare a dev copy on a hidden port with a fresh database
 * created by replaying the full migration chain; live data is NEVER cloned. The
 * stack-specific action is the toolkit's `lifecycle.dev` command; the framework
 * enforces the invariant the toolkit cannot be trusted to keep — that dev did
 * not touch the live data directory — by fingerprinting it before and after.
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
    log.step("preparing dev copy (fresh, migration-replayed database)");
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
    log.ok("dev copy prepared — run `agent-app validate`, have a verifier agent walk-verify against it (skill), then `agent-app promote`");
    return 0;
  });
}
