/**
 * Containment: a write aimed into a project must land in that project.
 *
 * `assertInside` compares strings, which is not the same question. An app
 * directory is untrusted — `import` exists to take one from a stranger, and
 * tar, zip and git all carry links — so a path with no `..` in it can still be
 * a link pointing at the user's home directory. This file pins the physical
 * check, and the copy that must not follow a link it finds at the destination.
 *
 * Symlink creation needs a privilege Windows does not grant by default; when it
 * is unavailable the cases that need one are skipped rather than failed, so
 * this still runs everywhere (CI is Linux, where they always work).
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInside, assertRealInside, copyTree } from "../dist/lib/fsx.js";

const failures = [];
let skipped = 0;
const check = (label, got, want) => {
  if (got !== want) failures.push(`${label}\n    expected: ${want}\n    actual:   ${got}`);
};
const throws = (label, fn) => {
  try { fn(); failures.push(`${label}\n    expected: a thrown error\n    actual:   completed`); }
  catch { /* expected */ }
};

const base = mkdtempSync(join(tmpdir(), "containment-"));
const project = join(base, "project");
const outside = join(base, "outside");
mkdirSync(project, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "authorized_keys"), "ORIGINAL");

// Lexical containment still rejects the obvious escapes.
throws("a parent-relative path is refused", () => assertInside(project, "../outside/x", "p"));
throws("an absolute path elsewhere is refused", () => assertInside(project, join(outside, "x"), "p"));
check("an ordinary relative path is accepted",
  typeof assertInside(project, "reference/requirements.md", "p"), "string");
check("the physical check agrees on an ordinary path",
  typeof assertRealInside(project, "reference/requirements.md", "p"), "string");

let links = true;
try {
  symlinkSync(outside, join(project, "hooks"), "junction");
} catch {
  links = false;
  skipped += 2;
}

if (links) {
  // The whole point: lexically clean, physically outside.
  throws("a path reached through a linked directory is refused", () =>
    assertRealInside(project, "hooks/authorized_keys", "vendored path"));

  // And a copy must replace a link at the destination, not write through it.
  const src = join(base, "payload.txt");
  writeFileSync(src, "VENDORED");
  const linkedDest = join(project, "linked-file");
  try {
    symlinkSync(join(outside, "authorized_keys"), linkedDest, "file");
    copyTree(src, linkedDest);
    check("the file outside is untouched", readFileSync(join(outside, "authorized_keys"), "utf8"), "ORIGINAL");
    check("the destination is no longer a link", lstatSync(linkedDest).isSymbolicLink(), false);
    check("the destination holds the copied bytes", readFileSync(linkedDest, "utf8"), "VENDORED");
  } catch (e) {
    if (e && e.code === "EPERM") skipped += 3;
    else throw e;
  }
}

rmSync(base, { recursive: true, force: true });

if (failures.length) {
  console.log(`containment: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log(`containment: all checks passed${skipped ? ` (${skipped} skipped: symlinks unavailable)` : ""}`);
