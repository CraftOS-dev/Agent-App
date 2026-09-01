/** a2app events <dir> [--since <cursor>] — poll the event log. */
import { flag } from "../lib/args.js";
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: a2app events <dir> [--since <cursor>]");
  const client = await clientFor(loadProject(dir));
  const res = await client.pollEvents(flag(args, "since"));
  if (res.status >= 300) {
    log.error(res.body || `HTTP ${res.status}`);
    return 1;
  }
  log.raw(res.body || "{}");
  return 0;
}
