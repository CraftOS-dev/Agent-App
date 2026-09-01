/** a2app context <dir> — what the user is currently viewing. */
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: a2app context <dir>");
  const client = await clientFor(loadProject(dir));
  const ctx = await client.context();
  if (ctx === null) {
    log.error("context surface unavailable (adapter has not implemented /api/_a2app/context)");
    return 1;
  }
  log.raw(JSON.stringify(ctx, null, 2));
  return 0;
}
