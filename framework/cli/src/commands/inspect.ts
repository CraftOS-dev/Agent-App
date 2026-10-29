/**
 * agent-app inspect <catalogue id> [--source <marketplace>] | --from <source> [--keep <dir>]
 *
 * Stage a source, classify it, report, and delete the staging (framework
 * packaging §5). Nothing is installed and nothing from the source runs: the
 * report says what the tree is (`agent-app`, `living-ui` or `foreign`), whether
 * `install` would take it and why not, which toolkit it would be re-vendored
 * from, whether its system files match its own canon, the commands its
 * toolkit's pipeline runs, and what sanitize would strip.
 *
 * `--keep <dir>` also keeps the source there, as a package would carry it
 * (no credentials, secrets, runtime state, data, `.git/`, `node_modules/` or
 * build output): the reference a conversion rebuilds from (packaging §7).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags } from "../lib/args.js";
import { inspectStaged } from "../lib/inspect.js";
import { requestOf } from "../lib/install.js";
import { log } from "../lib/log.js";
import { exclusionRules, walkPackage } from "../lib/package.js";
import { UsageError } from "../lib/project.js";
import { acquire, createStaging, removeStaging } from "../lib/sources.js";

export async function run(args: string[]): Promise<number> {
  const flags = parseFlags(args, { values: ["from", "source", "keep"] });
  const request = requestOf(flags.positionals, flags.values.get("from"), flags.values.get("source"));
  const keep = flags.values.get("keep");
  const keepDir = keep === undefined ? null : resolve(keep);
  if (keepDir !== null && existsSync(keepDir) && readdirSync(keepDir).length > 0) {
    throw new UsageError(`--keep ${keepDir} is not empty`);
  }
  const staging = createStaging();
  try {
    const acquired = await acquire(request, staging);
    const untrusted = [staging, ...(request.kind === "from" && request.source.kind === "folder" ? [request.source.dir] : [])];
    const { report, toolkit } = inspectStaged(acquired, { untrusted });
    if (keepDir !== null) {
      const skipped = keepTree(acquired.root, keepDir, exclusionRules(acquired.root, toolkit));
      if (skipped.length > 0) report.warnings.push(`--keep left out what is neither a file nor a folder: ${skipped.join(", ")}`);
      report.kept = keepDir;
      log.ok(`kept the source at ${keepDir}`);
    }
    for (const warning of report.warnings) log.warn(warning);
    if (report.installable) log.ok(`${report.kind}: installable`);
    else log.info(`${report.kind}: not installable — ${report.reason ?? ""}`);
    log.raw(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    removeStaging(staging);
  }
}

/** Copy what a package carries of `root` to `dest`; returns what was neither a
 *  file nor a folder (links, devices), which is never followed or copied. */
function keepTree(root: string, dest: string, rules: ReturnType<typeof exclusionRules>): string[] {
  const skipped: string[] = [];
  mkdirSync(dest, { recursive: true });
  walkPackage(root, rules, (rel, abs, kind) => {
    const to = join(dest, ...rel.split("/"));
    if (kind === "directory") mkdirSync(to, { recursive: true });
    else if (kind === "file") copyFileSync(abs, to);
    else skipped.push(rel);
  });
  return skipped;
}
