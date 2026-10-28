/**
 * agent-app <dir> validate — the validation gate and the v1 security gate.
 * Machine-readable failures on stdout: one block per failed step.
 */
import { hasFlag } from "../lib/args.js";
import { runAccessGate, runBudgetGate, runGate } from "../lib/gate.js";
import { readDevRecord } from "../lib/instance.js";
import { clearGatePass, writeGatePass } from "../lib/lifecycle.js";
import { loadProject } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);

  const errors = runGate(project.dir, project.manifest, { skipBuild: hasFlag(args, "no-build") });

  // The budget and who the app answers can only be checked against a running
  // app, so they are their own steps and report themselves unchecked when the
  // app is down rather than passing by default. Skipped entirely once an earlier
  // step has already failed: a broken build would report every level
  // unreachable and bury the real cause.
  const none = { errors: [], unchecked: [] };
  const budget = errors.length === 0 ? await runBudgetGate(project) : none;
  const access = errors.length === 0 ? await runAccessGate(project) : none;
  errors.push(...budget.errors, ...access.errors);
  const unchecked = [...budget.unchecked, ...access.unchecked];

  if (errors.length > 0) {
    // A failed gate revokes any earlier pass: the tree in front of us is not
    // promotable, whatever an older record says.
    clearGatePass(project.dir);
    log.raw("");
    log.raw(JSON.stringify({ ok: false, failures: errors, unchecked }, null, 2));
    log.error(`Gate: ${errors.length} step(s) failed`);
    return 1;
  }

  // Record the pass `promote` will demand: a fingerprint of the exact tree that
  // was gated, plus whether the running-app checks really ran against the
  // CANDIDATE. Routing sends them to the dev instance whenever one is recorded,
  // so "checked AND a dev instance up" is the structural proof that what was
  // measured is the code being promoted — a walk against the live app measures
  // the previously promoted build, which proves nothing about this tree.
  const checkedOnDev = unchecked.length === 0 && readDevRecord(project.dir) !== null;
  writeGatePass(project.dir, checkedOnDev);

  // `unchecked` rides in the success document too: a step that could not run is
  // not a step that passed, and a caller reading only `ok` would never learn the
  // difference.
  log.raw(JSON.stringify({ ok: true, unchecked, promotable: checkedOnDev }, null, 2));
  log.ok(unchecked.length > 0 ? `Gate: all runnable steps passed, ${unchecked.length} unchecked` : "Gate: all steps passed");
  log.info(
    checkedOnDev
      ? "gate pass recorded — `promote` will accept this exact tree"
      : "gate pass recorded, but NOT yet promotable: the running-app checks must run on the " +
          "candidate — boot it with `agent-app <dir> dev`, then validate again",
  );
  return 0;
}
