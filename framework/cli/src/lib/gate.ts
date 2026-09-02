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
import type { Manifest } from "./project.js";
import { runShell } from "./shell.js";
import { projectToolkit } from "./toolkit.js";
import { log } from "./log.js";

export interface GateError {
  step: string;
  message: string;
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

  if (!opts.skipBuild) {
    runStep(errors, "build (manifest pipeline)", () => {
      if (manifest.pipeline.install) runShell(manifest.pipeline.install, projectDir);
      runShell(manifest.pipeline.build, projectDir);
    });
  }

  // Toolkit-defined steps: migrations replay, known stack footguns, deep
  // operation resolution — whatever this stack needs.
  const tk = projectToolkit(projectDir);
  if (tk?.manifest.gate) {
    for (const step of tk.manifest.gate) {
      runStep(errors, step.name, () => {
        runShell(step.run, projectDir);
      });
    }
  }

  // Ownership canon: the validation gate's system-files check and the one
  // required security-gate check in v1. Re-hash every entry.
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

  return errors;
}
