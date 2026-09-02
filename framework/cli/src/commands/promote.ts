/**
 * agent-app promote <dir> — take a mandatory pre-promote backup (backup failure
 * aborts), then apply the dev copy's migrations to the live database.
 * First-install vs update is decided structurally (does a live database exist?),
 * never by a flag.
 */
import { loadProject, UsageError } from "../lib/project.js";
import { backupId, lifecycleCommand, liveExists, takeBackup } from "../lib/lifecycle.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: agent-app promote <dir>");
  const project = loadProject(dir);

  const cmd = lifecycleCommand(project.dir, "promote");
  if (cmd === null) {
    log.error("this app's toolkit declares no `lifecycle.promote` command");
    return 1;
  }

  let backup: string | null = null;
  if (liveExists(project.dir)) {
    // Mandatory pre-promote backup: failure aborts the promotion.
    try {
      const id = backupId(new Date());
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
    const out = runShell(cmd, project.dir);
    if (out.stdout.trim()) log.raw(out.stdout.trim());
  } catch (err) {
    log.error(`promotion failed — the dev copy is kept for retry: ${(err as Error).message}`);
    if (backup !== null) log.info(`live database unchanged; restore point: ${backup}`);
    return 1;
  }
  log.ok("promoted to live");
  log.raw(JSON.stringify({ ok: true, backup }, null, 2));
  return 0;
}
