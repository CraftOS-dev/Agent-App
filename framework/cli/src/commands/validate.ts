/**
 * agent-app <dir> validate — the validation gate and the v1 security gate.
 * Machine-readable failures on stdout: one block per failed step.
 */
import { hasFlag } from "../lib/args.js";
import { runBudgetGate, runGate } from "../lib/gate.js";
import { loadProject } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);

  const errors = runGate(project.dir, project.manifest, { skipBuild: hasFlag(args, "no-build") });

  // The budget can only be measured against a running app, so it is its own step
  // and reports itself unchecked when the app is down rather than passing by
  // default. Skipped entirely once an earlier step has already failed: a broken
  // build would report every level unreachable and bury the real cause.
  const budget = errors.length === 0 ? await runBudgetGate(project) : { errors: [], unchecked: [] };
  errors.push(...budget.errors);

  if (errors.length > 0) {
    log.raw("");
    log.raw(JSON.stringify({ ok: false, failures: errors, unchecked: budget.unchecked }, null, 2));
    log.error(`Gate: ${errors.length} step(s) failed`);
    return 1;
  }
  // `unchecked` rides in the success document too: a step that could not run is
  // not a step that passed, and a caller reading only `ok` would never learn the
  // difference.
  log.raw(JSON.stringify({ ok: true, unchecked: budget.unchecked }, null, 2));
  log.ok(
    budget.unchecked.length > 0
      ? `Gate: all runnable steps passed, ${budget.unchecked.length} unchecked`
      : "Gate: all steps passed",
  );
  return 0;
}
