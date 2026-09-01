/**
 * a2app restore <dir> [<backup-id>] — restore a backup, capturing the current
 * state first and rolling back automatically on failure.
 */
import { positionals } from "../lib/args.js";
import { loadProject, UsageError } from "../lib/project.js";
import { backupId, listBackups, restoreBackup, takeBackup } from "../lib/lifecycle.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const [dir, requested] = positionals(args);
  if (dir === undefined) throw new UsageError("Usage: a2app restore <dir> [<backup-id>]");
  const project = loadProject(dir);

  const backups = listBackups(project.dir);
  if (backups.length === 0) {
    log.error("no backups exist to restore");
    return 1;
  }
  const target = requested ?? backups[backups.length - 1]!;
  if (!backups.includes(target)) {
    log.error(`backup "${target}" not found. Available: ${backups.join(", ")}`);
    return 1;
  }

  // Capture the current state so a failed restore can roll back.
  const safety = backupId(new Date()) + "-pre-restore";
  takeBackup(project.dir, safety);

  try {
    restoreBackup(project.dir, target);
  } catch (err) {
    log.error(`restore failed (${(err as Error).message}) — rolling back`);
    restoreBackup(project.dir, safety);
    return 1;
  }
  log.ok(`restored ${target} (pre-restore snapshot: ${safety})`);
  log.raw(JSON.stringify({ ok: true, restored: target, rollback: safety }, null, 2));
  return 0;
}
