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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A monotonic-per-process suffix so staged temp names never collide, without
 *  relying on wall-clock time. */
let tmpCounter = 0;
function tmpSuffix(): string {
  return `${process.pid}-${tmpCounter++}`;
}

/**
 * Physical containment: lexically inside `base` AND not reached through a
 * symlink.
 *
 * {@link assertInside} compares strings, so a path with no `..` and no drive
 * letter passes even when a component of it is a link pointing elsewhere. An
 * app directory is untrusted input — `import` exists to take one from a
 * stranger, and tar, zip and git all carry links (a Windows junction needs no
 * privilege at all) — so a template file named `hooks/authorized_keys`, with
 * `hooks` a link to ~/.ssh, was written straight through the link and
 * overwrote a file the project has no business touching.
 *
 * Every component below `base` is checked. `base` itself may legitimately be a
 * link: the user chose where their project lives.
 */
export function assertRealInside(base: string, candidate: string, label = "path"): string {
  const target = assertInside(base, candidate, label);
  const root = resolve(base);
  let cur = root;
  for (const segment of relative(root, target).split(sep)) {
    if (segment === "") continue;
    cur = join(cur, segment);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // nothing here yet, so nothing to traverse
    }
    if (st.isSymbolicLink()) {
      throw new Error(`${label} "${candidate}" leaves ${root} through a link at ${cur}`);
    }
  }
  return target;
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
  // cpSync refuses to copy a directory into itself (ERR_FS_CP_EINVAL). Dropping
  // that check does not merely lose an error message: the walk would copy the
  // destination it is creating, on and on, until the disk or the path limit
  // stops it. `agent-app <app> skills --install ./skills/somewhere` is enough to
  // reach it, so the guard is restored here rather than left to the caller.
  const s = resolve(src);
  const d = resolve(dest);
  const rel = relative(s, d);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`Cannot copy ${s} into itself (${d})`);
  }
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true });
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  if (!st.isDirectory()) {
    mkdirSync(dirname(dest), { recursive: true });
    // Replace a link rather than write through it: copyFileSync follows the
    // destination, so a link left in the tree redirects the write outside it.
    try {
      if (lstatSync(dest).isSymbolicLink()) rmSync(dest, { force: true });
    } catch {
      /* nothing there yet */
    }
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
