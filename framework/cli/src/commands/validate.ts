/**
 * agent-app <dir> validate — the validation gate and the v1 security gate.
 * Machine-readable failures on stdout: one block per failed step.
 */
import { hasFlag } from "../lib/args.js";
import { runAccessGate, runBudgetGate, runGate, type GateError, type GateUnchecked } from "../lib/gate.js";
import { readDevRecord } from "../lib/instance.js";
import { clearGatePass, writeGatePass } from "../lib/lifecycle.js";
import { loadProject, type Project } from "../lib/project.js";
import { log } from "../lib/log.js";

export interface ValidateOutcome {
  ok: boolean;
  failures: GateError[];
  unchecked: GateUnchecked[];
  /** a pass whose running-app checks ran on a dev candidate, so `promote` accepts it */
  promotable: boolean;
}

export interface ValidateOptions {
  /** skip the build step (`--no-build`) */
  skipBuild?: boolean;
  /** the caller has just run `pipeline.install`; the build step runs only `pipeline.build` */
  skipInstall?: boolean;
  /** the caller runs the running-app checks itself once the app is up (install) */
  skipRunningChecks?: boolean;
}

/**
 * Run the gate and record (or revoke) the gate pass. Diagnostics go to stderr;
 * nothing is written to stdout, so the install pipeline can run this gate as
 * one of its steps and still own its output.
 */
export async function validateApp(project: Project, opts: ValidateOptions = {}): Promise<ValidateOutcome> {
  const errors = runGate(project.dir, project.manifest, {
    ...(opts.skipBuild === true ? { skipBuild: true } : {}),
    ...(opts.skipInstall === true ? { skipInstall: true } : {}),
  });

  // The budget and who the app answers can only be checked against a running
  // app, so they are their own steps and report themselves unchecked when the
  // app is down rather than passing by default. Skipped entirely once an earlier
  // step has already failed: a broken build would report every level
  // unreachable and bury the real cause.
  const none = { errors: [], unchecked: [] };
  const running = errors.length === 0 && opts.skipRunningChecks !== true;
  const budget = running ? await runBudgetGate(project) : none;
  const access = running ? await runAccessGate(project) : none;
  errors.push(...budget.errors, ...access.errors);
  const unchecked = [...budget.unchecked, ...access.unchecked];

  if (errors.length > 0) {
    // A failed gate revokes any earlier pass: the tree in front of us is not
    // promotable, whatever an older record says.
    clearGatePass(project.dir);
    log.error(`Gate: ${errors.length} step(s) failed`);
    return { ok: false, failures: errors, unchecked, promotable: false };
  }

  // Record the pass `promote` will demand: a fingerprint of the exact tree that
  // was gated, plus whether the running-app checks really ran against the
  // CANDIDATE. Routing sends them to the dev instance whenever one is recorded,
  // so "checked AND a dev instance up" is the structural proof that what was
  // measured is the code being promoted — a walk against the live app measures
  // the previously promoted build, which proves nothing about this tree.
  const checkedOnDev = unchecked.length === 0 && readDevRecord(project.dir) !== null;
  writeGatePass(project.dir, checkedOnDev);
  log.ok(unchecked.length > 0 ? `Gate: all runnable steps passed, ${unchecked.length} unchecked` : "Gate: all steps passed");
  return { ok: true, failures: [], unchecked, promotable: checkedOnDev };
}

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const outcome = await validateApp(project, { skipBuild: hasFlag(args, "no-build") });

  if (!outcome.ok) {
    log.raw("");
    log.raw(JSON.stringify({ ok: false, failures: outcome.failures, unchecked: outcome.unchecked }, null, 2));
    return 1;
  }

  // `unchecked` rides in the success document too: a step that could not run is
  // not a step that passed, and a caller reading only `ok` would never learn the
  // difference.
  log.raw(JSON.stringify({ ok: true, unchecked: outcome.unchecked, promotable: outcome.promotable }, null, 2));
  log.info(
    outcome.promotable
      ? "gate pass recorded — `promote` will accept this exact tree"
      : "gate pass recorded, but NOT yet promotable: the running-app checks must run on the " +
          "candidate — boot it with `agent-app <dir> dev`, then validate again",
  );
  return 0;
}
