/** agent-app backup <dir> — take an explicit, verified backup of the live database. */
import { positionals } from "../lib/args.js";
import { loadProject, UsageError } from "../lib/project.js";
import { assertNotServing, backupId, lifecycleLock, takeBackup } from "../lib/lifecycle.js";
import { withLock } from "../lib/lock.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = positionals(args)[0];
  if (dir === undefined) throw new UsageError("Usage: agent-app backup <dir>");
  const project = loadProject(dir);
  // Serialize with any other lifecycle mutation on this app, and never copy a
  // data directory the app currently has open.
  return withLock(lifecycleLock(project.dir), async () => {
    await assertNotServing(project);
    const id = backupId(new Date());
    const path = takeBackup(project.dir, id);
    log.ok(`backup ${id}`);
    log.raw(JSON.stringify({ ok: true, backup: id, path }, null, 2));
    return 0;
  });
}
