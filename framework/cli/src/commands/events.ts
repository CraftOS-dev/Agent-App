/** a2app <app> events [--since <cursor>] — poll the event log. */
import { flag } from "../lib/args.js";
import { clientFor, loadProject } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[], app: string): Promise<number> {
  const client = await clientFor(loadProject(app));
  const res = await client.pollEvents(flag(args, "since"));
  if (res.status >= 300) {
    log.error(res.body || `HTTP ${res.status}`);
    return 1;
  }
  log.raw(res.body || "{}");
  return 0;
}
