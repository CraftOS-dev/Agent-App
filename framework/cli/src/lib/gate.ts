/**
 * The validation gate and the security gate.
 *
 * Stack-agnostic core: framework files valid → build (manifest pipeline) →
 * toolkit-defined steps (migrations, footguns, ops resolution) → ownership canon
 * (validation-gate item AND the one v1-required security-gate check).
 *
 * Every failure is machine-readable — `{ step, message }` — so an agent fixes it
 * without human interpretation.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifySystemHashes } from "./canon.js";
import { validateFrameworkFiles } from "./frameworkFiles.js";
import { DESCRIBE_BUDGET_CHARS } from "@a2app/rules";
import { describeOverruns, walkDescribeBudget } from "./budget.js";
import { clientFor, type Manifest, type Project } from "./project.js";
import { runShell } from "./shell.js";
import { projectToolkit } from "./toolkit.js";
import { log } from "./log.js";

export interface GateError {
  step: string;
  message: string;
}

/**
 * A step that could NOT run.
 *
 * Distinct from a pass by construction. The whole point of a gate is that
 * "could not check" and "checked and fine" are different outcomes, and a caller
 * reading only an error list cannot tell them apart — which is the failure mode
 * `runGate` already calls out for its own skipped steps. Surfaced in the
 * `validate` output so an agent sees what went unverified.
 */
export interface GateUnchecked {
  step: string;
  reason: string;
}

export interface BudgetGateResult {
  errors: GateError[];
  unchecked: GateUnchecked[];
}

export interface GateOptions {
  /** skip the (slow) build step — used by data-only re-checks */
  skipBuild?: boolean;
}

function runStep(errors: GateError[], step: string, fn: () => void): void {
  try {
    fn();
    log.ok(step);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ step, message: message.trim().slice(0, 4000) });
    log.error(`${step} failed`);
  }
}

export function runGate(projectDir: string, manifest: Manifest, opts: GateOptions = {}): GateError[] {
  const errors: GateError[] = [];

  runStep(errors, "framework files (present and valid)", () => {
    const problems = validateFrameworkFiles(projectDir);
    if (problems.length > 0) {
      throw new Error(problems.map((p) => `${p.file}: ${p.message}`).join("\n"));
    }
  });

  // Ownership canon FIRST — the one v1-required security-gate check. It must run
  // BEFORE any manifest/toolkit shell executes: `manifest.json` is a system-owned,
  // canon-covered file, so if it was tampered to inject a malicious build/start
  // string, the canon check has to fail the gate before that shell ever runs. A
  // security check that runs after the code it is meant to gate protects nothing.
  runStep(errors, "ownership (system files unmodified)", () => {
    if (!existsSync(join(projectDir, ".a2app", "system-hashes.json")) &&
        !existsSync(join(projectDir, ".lui", "system-hashes.json"))) {
      throw new Error(
        "no ownership canon — run `agent-app toolkit-sync` to record system-file hashes",
      );
    }
    const drift = verifySystemHashes(projectDir);
    const problems = [
      ...drift.modified.map((p) => `modified: ${p}`),
      ...drift.missing.map((p) => `deleted: ${p}`),
      ...drift.added.map((p) => `added: ${p}`),
    ];
    if (problems.length > 0) {
      throw new Error(
        `system-managed files changed outside tooling:\n${problems.join("\n")}\n` +
          "If a toolkit upgrade is intended, run `agent-app toolkit-sync`; agent edits belong in app-owned paths.",
      );
    }
  });

  if (!opts.skipBuild) {
    runStep(errors, "build (manifest pipeline)", () => {
      if (manifest.pipeline.install) runShell(manifest.pipeline.install, projectDir);
      runShell(manifest.pipeline.build, projectDir);
    });
  }

  // Toolkit-defined steps: migrations replay, known stack footguns, deep
  // operation resolution — whatever this stack needs.
  const tk = projectToolkit(projectDir);
  const steps = tk?.manifest.gate ?? [];
  for (const step of steps) {
    runStep(errors, step.name, () => {
      runShell(step.run, projectDir);
    });
  }

  // Operation resolution — every declared operation reaching a real
  // implementation — is stack-specific and can only run as a toolkit step. It
  // must be reported as UNCHECKED when no step covers it, never passed over in
  // silence: a step a gate cannot run is indistinguishable from one it ran and
  // passed, which is the failure mode gates exist to prevent. Previously this
  // warning fired only when a toolkit declared NO steps at all, so a toolkit
  // with unrelated steps produced a fully green gate with nothing said.
  if (!steps.some((s) => RESOLUTION_STEP.test(s.name))) {
    log.warn(
      "UNCHECKED: operation resolution (every declared operation reaches an implementation) — " +
        "no toolkit gate step covers it. Declare one named e.g. \"operations resolve\" in a2app.toolkit.json.",
    );
  }
  if (steps.length === 0) {
    log.warn(
      "UNCHECKED: migration replay on a fresh database — no toolkit gate steps " +
        "(hand-built or toolkit-less app). Declare gate steps in a2app.toolkit.json to cover them.",
    );
  }

  return errors;
}

/** A toolkit gate step that resolves declared operations to implementations. */
const RESOLUTION_STEP = /operation|ops/i;

/**
 * The describe budget walk (framework spec 5.3 step 7).
 *
 * Separated from {@link runGate} because it needs the app RUNNING: the budget is
 * a property of what the app serves, and only the app knows that. Callers run it
 * after `serve`/`dev`; when the app is unreachable it reports the step as
 * unchecked rather than passed.
 */
export async function runBudgetGate(project: Project): Promise<BudgetGateResult> {
  const step = `describe budget (every level ≤ ${DESCRIBE_BUDGET_CHARS.toLocaleString("en-US")} chars)`;
  const unchecked = (reason: string): BudgetGateResult => {
    log.warn(`UNCHECKED: ${step} — ${reason}`);
    return { errors: [], unchecked: [{ step, reason }] };
  };

  let client;
  try {
    client = await clientFor(project);
  } catch {
    return unchecked("could not build a client for the app");
  }

  let report;
  try {
    report = await walkDescribeBudget(client);
  } catch (err) {
    return unchecked(err instanceof Error ? err.message : String(err));
  }

  if (!report.reachable) {
    return unchecked("the app is not running, so no level could be measured — run `serve` first");
  }
  if (report.overruns.length > 0) {
    log.error(`${step} failed`);
    return {
      errors: [
        {
          step,
          message:
            `${report.overruns.length} of ${report.checked} describe level(s) exceed the budget:\n` +
            describeOverruns(report),
        },
      ],
      unchecked: [],
    };
  }
  log.ok(`${step} — ${report.checked} level(s)`);
  return { errors: [], unchecked: [] };
}
