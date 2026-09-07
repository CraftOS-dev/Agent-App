/**
 * Filesystem safety helpers.
 *
 * The framework mutates two things it must never corrupt: the user's app files
 * and the user's data directory. Every mutation here is either contained (a
 * path that cannot escape its base) or atomic (staged to a sibling, verified,
 * then renamed into place — never delete-before-replace). A crash, a full disk,
 * or a Windows file lock at any point leaves the previous good state intact.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** A monotonic-per-process suffix so staged temp names never collide, without
 *  relying on wall-clock time. */
let tmpCounter = 0;
function tmpSuffix(): string {
  return `${process.pid}-${tmpCounter++}`;
}

/**
 * Resolve `candidate` against `base` and throw if it escapes `base` (a `..`
 * traversal or an absolute path pointing elsewhere). Returns the absolute,
 * contained path. Toolkit-declared paths are untrusted input, so every vendor
 * and canon write runs through this.
 */
export function assertInside(base: string, candidate: string, label = "path"): string {
  const b = resolve(base);
  const c = resolve(b, candidate);
  const rel = relative(b, c);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} "${candidate}" escapes the project directory (${b})`);
  }
  return c;
}

/** Count files (not directories) under a path — a cheap integrity check that a
 *  recursive copy landed everything. */
export function countFiles(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return 1;
  let n = 0;
  for (const name of readdirSync(p)) n += countFiles(join(p, name));
  return n;
}

/**
 * Fsync a directory so a rename into it is durable (best-effort: not all
 * platforms permit opening a directory for fsync — a failure is ignored).
 */
function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* directory fsync unsupported on this platform — best effort */
  }
}

/**
 * Recursive copy. Deliberately does NOT use `fs.cpSync`.
 *
 * Node's native recursive copy fail-fasts the entire process on Windows when
 * the SOURCE path contains non-ASCII characters — no exception, no stderr, just
 * exit 0xC0000409 — so scaffold, vendor, backup and restore all died silently
 * for anyone whose checkout lives under a path like `C:\Users\...\デスクトップ`.
 * A plain readdir/copyFile walk has no such limit. Matches the native defaults:
 * overwrites existing entries, and copies symlinks as symlinks.
 */
export function copyTree(src: string, dest: string): void {
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

/**
 * Copy `src` into a NEW directory `dest`, atomically. Stages to a sibling temp,
 * verifies the file count matches, fsyncs, then renames into place. Refuses to
 * overwrite an existing `dest` (a backup id must never merge two snapshots).
 */
export function copyDirAtomic(src: string, dest: string): void {
  if (!existsSync(src)) throw new Error(`source ${src} does not exist`);
  if (existsSync(dest)) throw new Error(`refusing to overwrite existing ${dest}`);
  const staged = `${dest}.staging-${tmpSuffix()}`;
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  copyTree(src, staged);
  const want = countFiles(src);
  const got = countFiles(staged);
  if (got !== want) {
    rmSync(staged, { recursive: true, force: true });
    throw new Error(`copy verification failed: expected ${want} files, staged ${got}`);
  }
  renameSync(staged, dest);
  syncDir(dirname(dest));
}

/**
 * Replace the contents of `live` with a copy of `src`, atomically and with
 * rollback. Never deletes `live` before the replacement is fully staged and
 * verified: stage → move live aside → move staged into place → (on success)
 * drop the old copy; on any failure the original `live` is restored. This is
 * the primitive `restore` and `promote` need so a crash mid-swap cannot leave
 * the user with no data directory.
 */
export function replaceDirAtomic(src: string, live: string): void {
  if (!existsSync(src)) throw new Error(`source ${src} does not exist`);
  const staged = `${live}.staging-${tmpSuffix()}`;
  const old = `${live}.old-${tmpSuffix()}`;
  rmSync(staged, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  copyTree(src, staged);
  const want = countFiles(src);
  const got = countFiles(staged);
  if (got !== want) {
    rmSync(staged, { recursive: true, force: true });
    throw new Error(`copy verification failed: expected ${want} files, staged ${got}`);
  }
  let movedAside = false;
  if (existsSync(live)) {
    renameSync(live, old);
    movedAside = true;
  }
  try {
    mkdirSync(dirname(live), { recursive: true });
    renameSync(staged, live);
  } catch (err) {
    // Put the original back before surfacing the failure.
    if (movedAside && !existsSync(live)) renameSync(old, live);
    rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  syncDir(dirname(live));
  if (movedAside) rmSync(old, { recursive: true, force: true });
}
