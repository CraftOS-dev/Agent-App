/**
 * agent-app inspect <catalogue id> [--source <marketplace>] | --from <source>
 *
 * Stage a source, classify it, report, and delete the staging (framework
 * packaging §5). Nothing is installed and nothing from the source runs: the
 * report says what the tree is (`agent-app`, `living-ui` or `foreign`), whether
 * `install` would take it and why not, which toolkit it would be re-vendored
 * from, whether its system files match its own canon, the commands its
 * toolkit's pipeline runs, and what sanitize would strip.
 */
import { parseFlags } from "../lib/args.js";
import { inspectStaged } from "../lib/inspect.js";
import { requestOf } from "../lib/install.js";
import { log } from "../lib/log.js";
import { acquire, createStaging, removeStaging } from "../lib/sources.js";

export async function run(args: string[]): Promise<number> {
  const flags = parseFlags(args, { values: ["from", "source"] });
  const request = requestOf(flags.positionals, flags.values.get("from"), flags.values.get("source"));
  const staging = createStaging();
  try {
    const acquired = await acquire(request, staging);
    const untrusted = [staging, ...(request.kind === "from" && request.source.kind === "folder" ? [request.source.dir] : [])];
    const { report } = inspectStaged(acquired, { untrusted });
    for (const warning of report.warnings) log.warn(warning);
    if (report.installable) log.ok(`${report.kind}: installable`);
    else log.info(`${report.kind}: not installable — ${report.reason ?? ""}`);
    log.raw(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    removeStaging(staging);
  }
}
