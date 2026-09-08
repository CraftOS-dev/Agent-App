/**
 * copyTree: the recursive copy that replaced fs.cpSync.
 *
 * Standard library only, run directly, so `pnpm -r test` needs no test runner.
 * The self-copy cases are the reason this file exists: cpSync refuses them with
 * ERR_FS_CP_EINVAL, and a replacement that merely omitted the check would not
 * fail loudly — it would walk the destination it is creating until the disk
 * filled. That is not a difference a reviewer sees by reading the diff.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTree } from "../dist/lib/fsx.js";

const failures = [];
const check = (label, got, want) => {
  if (got !== want) failures.push(`${label}\n    expected: ${want}\n    actual:   ${got}`);
};
const throws = (label, fn) => {
  try {
    fn();
    failures.push(`${label}\n    expected: a thrown error\n    actual:   completed`);
  } catch {
    /* expected */
  }
};

const base = mkdtempSync(join(tmpdir(), "copytree-"));
const src = join(base, "src");
mkdirSync(join(src, "deep", "deeper"), { recursive: true });
writeFileSync(join(src, "top.txt"), "top");
writeFileSync(join(src, "deep", "mid.txt"), "mid");
writeFileSync(join(src, "deep", "deeper", "leaf.txt"), "leaf");
mkdirSync(join(src, "empty-dir"), { recursive: true });

const walk = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );

// --- faithful copy ---------------------------------------------------------
const dest = join(base, "dest");
copyTree(src, dest);
check("every file is copied", walk(dest).sort().join(","), walk(src).sort().join(","));
check("nested content survives", readFileSync(join(dest, "deep", "deeper", "leaf.txt"), "utf8"), "leaf");
check("an empty directory is preserved", readdirSync(join(dest, "empty-dir")).length, 0);

// --- overwrite is safe (toolkit-sync and skills --install both re-run) ------
writeFileSync(join(dest, "top.txt"), "stale");
copyTree(src, dest);
check("re-copying overwrites rather than failing", readFileSync(join(dest, "top.txt"), "utf8"), "top");

// --- a single file, not a directory ----------------------------------------
const oneFile = join(base, "just-a-file.txt");
copyTree(join(src, "top.txt"), oneFile);
check("a file source copies to a file", readFileSync(oneFile, "utf8"), "top");

// --- the regression: a destination inside the source -----------------------
throws("copying a directory into itself is refused", () => copyTree(src, join(src, "nested")));
throws("copying a directory into a deeper path inside itself is refused", () =>
  copyTree(src, join(src, "deep", "deeper", "nested")));
throws("copying a directory onto itself is refused", () => copyTree(src, src));

// A sibling that merely shares a name prefix is NOT inside the source, and must
// still be allowed — a containment test written with startsWith on the raw
// string would wrongly reject this.
const sibling = `${src}-backup`;
copyTree(src, sibling);
check("a sibling sharing a name prefix is still allowed", readFileSync(join(sibling, "top.txt"), "utf8"), "top");

rmSync(base, { recursive: true, force: true });

if (failures.length) {
  console.log(`copyTree: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("copyTree: all checks passed");
