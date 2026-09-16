/**
 * agent-app <dir> validate — the validation gate and the v1 security gate.
 * Machine-readable failures on stdout: one block per failed step.
 */
import { hasFlag } from "../lib/args.js";
import { runBudgetGate, runGate } from "../lib/gate.js";
import { readDevRecord } from "../lib/instance.js";
import { clearGatePass, writeGatePass } from "../lib/lifecycle.js";
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
    // A failed gate revokes any earlier pass: the tree in front of us is not
    // promotable, whatever an older record says.
    clearGatePass(project.dir);
    log.raw("");
    log.raw(JSON.stringify({ ok: false, failures: errors, unchecked: budget.unchecked }, null, 2));
    log.error(`Gate: ${errors.length} step(s) failed`);
    return 1;
  }

  // Record the pass `promote` will demand: a fingerprint of the exact tree that
  // was gated, plus whether the describe-budget walk really ran against the
  // CANDIDATE. Routing sends the walk to the dev instance whenever one is
  // recorded, so "budget checked AND a dev instance up" is the structural proof
  // that what was measured is the code being promoted — a walk against the live
  // app measures the previously promoted build, which proves nothing about this
  // tree.
  const budgetCheckedOnDev = budget.unchecked.length === 0 && readDevRecord(project.dir) !== null;
  writeGatePass(project.dir, budgetCheckedOnDev);

  // `unchecked` rides in the success document too: a step that could not run is
  // not a step that passed, and a caller reading only `ok` would never learn the
  // difference.
  log.raw(JSON.stringify({ ok: true, unchecked: budget.unchecked, promotable: budgetCheckedOnDev }, null, 2));
  log.ok(
    budget.unchecked.length > 0
      ? `Gate: all runnable steps passed, ${budget.unchecked.length} unchecked`
      : "Gate: all steps passed",
  );
  log.info(
    budgetCheckedOnDev
      ? "gate pass recorded — `promote` will accept this exact tree"
      : "gate pass recorded, but NOT yet promotable: the describe budget must be measured on the " +
          "candidate — boot it with `agent-app <dir> dev`, then validate again",
  );
  return 0;
}
