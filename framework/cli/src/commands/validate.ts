/**
 * agent-app <dir> validate — the validation gate and the v1 security gate.
 * Machine-readable failures on stdout: one block per failed step.
 */
import { hasFlag } from "../lib/args.js";
import { runGate } from "../lib/gate.js";
import { loadProject } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);

  const errors = runGate(project.dir, project.manifest, { skipBuild: hasFlag(args, "no-build") });

  if (errors.length > 0) {
    log.raw("");
    log.raw(JSON.stringify({ ok: false, failures: errors }, null, 2));
    log.error(`Gate: ${errors.length} step(s) failed`);
    return 1;
  }
  log.raw(JSON.stringify({ ok: true }, null, 2));
  log.ok("Gate: all steps passed");
  return 0;
}
