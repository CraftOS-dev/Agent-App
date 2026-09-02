/** agent-app backup <dir> — take an explicit backup of the live database. */
import { loadProject, UsageError } from "../lib/project.js";
import { backupId, takeBackup } from "../lib/lifecycle.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: agent-app backup <dir>");
  const project = loadProject(dir);
  const id = backupId(new Date());
  const path = takeBackup(project.dir, id);
  log.ok(`backup ${id}`);
  log.raw(JSON.stringify({ ok: true, backup: id, path }, null, 2));
  return 0;
}
