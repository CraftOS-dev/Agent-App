/**
 * agent-app restore <dir> [<backup-id>] — restore a backup, capturing the current
 * state first and rolling back automatically on failure.
 *
 * Data safety: the restore itself is atomic (the live directory is never deleted
 * before the replacement is staged and verified), AND a pre-restore snapshot is
 * taken so a failure can always be undone. If even the rollback fails, the
 * user's data is still preserved in that snapshot, whose path is reported.
 */
import { join } from "node:path";
import { positionals } from "../lib/args.js";
import { loadProject, UsageError } from "../lib/project.js";
import { assertNotServing, backupId, lifecycleLock, listBackups, restoreBackup, takeBackup } from "../lib/lifecycle.js";
import { withLock } from "../lib/lock.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const [dir, requested] = positionals(args);
  if (dir === undefined) throw new UsageError("Usage: agent-app restore <dir> [<backup-id>]");
  const project = loadProject(dir);

  return withLock(lifecycleLock(project.dir), async () => {
    await assertNotServing(project);

    const backups = listBackups(project.dir);
    if (requested === undefined && backups.length === 0) {
      log.error("no backups exist to restore");
      return 1;
    }
    // Default to the newest USER backup (never an internal safety snapshot); an
    // explicit id may name any backup, including a snapshot.
    const target = requested ?? backups[backups.length - 1]!;
    const all = listBackups(project.dir, { includeInternal: true });
    if (!all.includes(target)) {
      log.error(`backup "${target}" not found. Available: ${backups.join(", ") || "(none)"}`);
      return 1;
    }

    // Capture current state so a failed restore can be undone. If we cannot even
    // snapshot, abort before touching live.
    let safety: string;
    try {
      safety = backupId(new Date(), "pre-restore");
      takeBackup(project.dir, safety);
    } catch (err) {
      log.error(`could not snapshot current state before restore — aborting: ${(err as Error).message}`);
      return 1;
    }

    try {
      restoreBackup(project.dir, target);
    } catch (err) {
      log.error(`restore failed (${(err as Error).message}) — rolling back`);
      try {
        restoreBackup(project.dir, safety);
        log.info(`rolled back to the pre-restore snapshot ${safety}`);
      } catch (rollbackErr) {
        log.error(
          `ROLLBACK ALSO FAILED (${(rollbackErr as Error).message}). Your data is preserved in ` +
            `${join(project.dir, ".a2app", "backups", safety)} — restore it manually.`,
        );
      }
      return 1;
    }
    log.ok(`restored ${target} (pre-restore snapshot: ${safety})`);
    log.raw(JSON.stringify({ ok: true, restored: target, rollback: safety }, null, 2));
    return 0;
  });
}
