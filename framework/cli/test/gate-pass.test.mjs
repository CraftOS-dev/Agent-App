/**
 * The gate pass fingerprints the app's code, not its build ledger.
 *
 * The skills tick the ledger's tasks and record the walk-verify verdict in it
 * after `validate`. Were the ledger gated, the documented workflow would
 * invalidate its own pass on every delivery: another validate, and for a host
 * that binds verification to the gated code, another walk-verify. Every other
 * edit must still change the fingerprint.
 *
 * Standard library only, run directly.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeFingerprint } from "../dist/lib/lifecycle.js";

const app = mkdtempSync(join(tmpdir(), "a2app-gate-pass-"));
const write = (rel, text) => writeFileSync(join(app, ...rel.split("/")), text);

try {
  mkdirSync(join(app, "reference"));
  mkdirSync(join(app, "src"));
  write("manifest.json", '{"id":"gate1"}\n');
  write("src/app.js", "export const n = 1;\n");
  write("reference/requirements.md", "# Requirements\n");
  write("reference/tasks.md", "- [ ] T-1 (F-1): build it\n- [ ] walk-verify pass — pending\n");
  const gated = codeFingerprint(app);

  write("reference/tasks.md", "- [x] T-1 (F-1): build it\n- [x] walk-verify pass — pass, no defects\n");
  assert.equal(codeFingerprint(app), gated, "ticking tasks and recording the verdict leave the pass valid");
  console.log("  ✓ the ledger is not gated code");

  write("reference/requirements.md", "# Requirements\n\nA new feature.\n");
  assert.notEqual(codeFingerprint(app), gated, "a spec change is gated");
  write("reference/requirements.md", "# Requirements\n");
  assert.equal(codeFingerprint(app), gated);

  write("src/tasks.md", "not the ledger\n");
  assert.notEqual(codeFingerprint(app), gated, "only the app's ledger is exempt, not every tasks.md");
  rmSync(join(app, "src", "tasks.md"));

  write("src/app.js", "export const n = 2;\n");
  assert.notEqual(codeFingerprint(app), gated, "a code change is gated");
  console.log("  ✓ every other edit still invalidates the pass");
  console.log("gate pass: all checks passed");
} finally {
  rmSync(app, { recursive: true, force: true });
}
