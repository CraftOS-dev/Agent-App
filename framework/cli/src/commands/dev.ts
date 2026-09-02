/**
 * agent-app dev <dir> — boot a dev copy on a hidden port with a fresh database
 * created by replaying the full migration chain; live data is never cloned. The
 * stack-specific action is the toolkit's `lifecycle.dev` command; the framework
 * only enforces that dev never touches live data.
 */
import { loadProject, UsageError } from "../lib/project.js";
import { lifecycleCommand } from "../lib/lifecycle.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: agent-app dev <dir>");
  const project = loadProject(dir);

  const cmd = lifecycleCommand(project.dir, "dev");
  if (cmd === null) {
    log.error(
      "this app's toolkit declares no `lifecycle.dev` command — cannot boot a safe dev copy. " +
        "A stack-agnostic app must provide one before it can be safely evolved.",
    );
    return 1;
  }
  log.step("booting dev copy (fresh, migration-replayed database)");
  const out = runShell(cmd, project.dir);
  if (out.stdout.trim()) log.raw(out.stdout.trim());
  log.ok("dev copy running — run `agent-app validate` and walk-verify against it, then `agent-app promote`");
  return 0;
}
