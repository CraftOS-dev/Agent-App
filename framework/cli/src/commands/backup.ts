/** agent-app <dir> backup — take an explicit, verified backup of the live database. */
import { loadProject } from "../lib/project.js";
import { assertNotServing, backupId, lifecycleLock, takeBackup } from "../lib/lifecycle.js";
import { withLock } from "../lib/lock.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
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
