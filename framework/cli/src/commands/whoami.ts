/** a2app whoami <dir> — the calling credential's grant. */
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: a2app whoami <dir>");
  const client = await clientFor(loadProject(dir));
  const who = await client.whoami();
  if (who === null) {
    log.error("whoami unavailable (adapter predates IAM, or credential rejected)");
    return 1;
  }
  log.raw(JSON.stringify(who, null, 2));
  return 0;
}
