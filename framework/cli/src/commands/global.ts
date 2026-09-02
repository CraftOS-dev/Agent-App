/**
 * agent-app global [--path]
 *
 * Show the cross-app conventions an agent reads before building or evolving any
 * app (framework section 5.7), seeding `GLOBAL_AGENT_APP.md` in the framework
 * home on first use. `--path` prints only its location, for an agent that wants
 * to read or edit the file directly.
 *
 * The file is the user's: seeded once, never rewritten. Per-app requirements
 * override it on conflict.
 */
import { hasFlag } from "../lib/args.js";
import { ensureGlobalDoc, globalDocPath, readGlobalDoc } from "../lib/globalDoc.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const seeded = ensureGlobalDoc();
  if (seeded) log.info(`seeded ${globalDocPath()} — it is yours to edit; the framework will not rewrite it`);

  if (hasFlag(args, "path")) {
    log.raw(globalDocPath());
    return 0;
  }
  log.raw(readGlobalDoc());
  return 0;
}
