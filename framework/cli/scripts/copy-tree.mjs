/**
 * Recursive copy for the bundle scripts. Deliberately does NOT use `fs.cpSync`.
 *
 * Node's native recursive copy fail-fasts the whole process on Windows when the
 * SOURCE path contains non-ASCII characters — no exception, no stderr, just exit
 * 0xC0000409 — so `prepack` died silently for anyone packing the CLI from a
 * checkout under a path like `C:\Users\...\デスクトップ`. Mirrors the runtime
 * helper in `src/lib/fsx.ts`, which the build scripts cannot import.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export function copyTree(src, dest) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true });
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  if (!st.isDirectory()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    copyTree(join(src, entry.name), join(dest, entry.name));
  }
}
