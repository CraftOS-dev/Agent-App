/**
 * Safe-evolve helpers. The framework CLI orchestrates the safety invariants —
 * backup before every code-change promotion, capture before restore, rollback on
 * failure, the validate→promote gate pass, and NEVER mutate a data directory
 * that a running app has open — and delegates the stack-specific action
 * (prepare a fresh dev database, apply migrations to live) to toolkit-declared
 * commands.
 *
 * Every data mutation here is atomic (fsx.copyDirAtomic / replaceDirAtomic):
 * staged to a sibling, file-count verified, then renamed into place, with the
 * previous good state kept until the new one lands. A crash, a full disk, or a
 * Windows file lock mid-operation therefore never leaves the user with a torn
 * or missing data directory.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { copyDirAtomic, replaceDirAtomic } from "./fsx.js";
import { identifyApp } from "./net.js";
import { EnvError, type Project } from "./project.js";
import { projectToolkit } from "./toolkit.js";

const BACKUP_ROOT = join(".a2app", "backups");

/** The per-app lifecycle lock: serializes dev/promote/backup/restore so two
 *  never mutate the same data directory at once. */
export function lifecycleLock(projectDir: string): string {
  return join(projectDir, ".a2app", "lifecycle.lock");
}

/** The live data directory, from the toolkit lifecycle contract, or null. */
export function dataDir(projectDir: string): string | null {
  const rel = projectToolkit(projectDir)?.manifest.lifecycle?.dataDir;
  return rel ? join(projectDir, rel) : null;
}

export function lifecycleCommand(
  projectDir: string,
  key: "dev" | "promote" | "backup" | "restore",
): string | null {
  return projectToolkit(projectDir)?.manifest.lifecycle?.[key] ?? null;
}

/** A collision-safe backup id: ISO time + an optional label + a per-process
 *  counter, so two backups in the same millisecond never resolve to the same id
 *  (which `copyDirAtomic` would refuse anyway, rather than silently merging). */
let idCounter = 0;
export function backupId(now: Date, label?: string): string {
  const base = now.toISOString().replace(/[:.]/g, "-");
  const suffix = `${process.pid}-${idCounter++}`;
  return label ? `${base}-${label}-${suffix}` : `${base}-${suffix}`;
}

/**
 * Copy the live data directory into a NEW, verified backup. Atomic and
 * collision-safe: refuses to overwrite an existing id, verifies the copy landed
 * every file, and only then publishes it — so a backup that "succeeds" is a
 * complete, restorable snapshot, never a torn one. Throws (a backup that cannot
 * be taken must abort a promotion).
 */
export function takeBackup(projectDir: string, id: string): string {
  const src = dataDir(projectDir);
  if (src === null) throw new Error("toolkit declares no lifecycle.dataDir — cannot back up");
  if (!existsSync(src)) throw new Error(`data directory ${src} does not exist yet`);
  const dest = join(projectDir, BACKUP_ROOT, id);
  copyDirAtomic(src, dest);
  return dest;
}

/** List backup ids. By default hides internal safety snapshots (pre-restore /
 *  pre-promote) and staging temps, so `restore` never defaults to one. */
export function listBackups(projectDir: string, opts: { includeInternal?: boolean } = {}): string[] {
  const root = join(projectDir, BACKUP_ROOT);
  if (!existsSync(root)) return [];
  let ids = readdirSync(root).filter((n) => !n.includes(".staging-") && !n.includes(".old-"));
  if (!opts.includeInternal) {
    ids = ids.filter((id) => !id.includes("-pre-restore-") && !id.includes("-pre-promote-"));
  }
  return ids.sort();
}

/**
 * Replace the live data directory with a backup's contents. Atomic with
 * rollback (replaceDirAtomic): the live directory is never deleted before the
 * replacement is staged and verified, so a failure mid-restore leaves the
 * original data intact.
 */
export function restoreBackup(projectDir: string, id: string): void {
  const src = join(projectDir, BACKUP_ROOT, id);
  if (!existsSync(src)) throw new Error(`backup "${id}" not found`);
  const live = dataDir(projectDir);
  if (live === null) throw new Error("toolkit declares no lifecycle.dataDir — cannot restore");
  replaceDirAtomic(src, live);
}

/** Files that do not, by themselves, make a data directory "live". */
const NOISE = new Set([".gitkeep", ".DS_Store", "Thumbs.db"]);

/** Does a live database already exist? Decides first-install vs update
 *  structurally, never by a flag — keyed on real content, ignoring transient
 *  lock/temp/noise files that a crashed boot may leave behind. */
export function liveExists(projectDir: string): boolean {
  const dir = dataDir(projectDir);
  if (dir === null || !existsSync(dir)) return false;
  return readdirSync(dir).some(
    (n) => !NOISE.has(n) && !n.endsWith(".lock") && !n.endsWith(".tmp") && !n.includes(".staging-"),
  );
}

/** A cheap fingerprint (file count + total size + newest mtime) of the live data
 *  directory, used to ASSERT that `dev` did not touch live data. */
export function dataFingerprint(projectDir: string): string | null {
  const dir = dataDir(projectDir);
  if (dir === null || !existsSync(dir)) return null;
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const st = statSync(cur);
    if (st.isDirectory()) {
      for (const n of readdirSync(cur)) stack.push(join(cur, n));
    } else {
      files += 1;
      bytes += st.size;
      newest = Math.max(newest, st.mtimeMs);
    }
  }
  return `${files}:${bytes}:${newest}`;
}

/* ───────────────────────────── gate pass ─────────────────────────────────
 *
 * The ordering gate between `validate` and `promote`, decided structurally —
 * the same principle as first-install-vs-update. `validate` records, on
 * success, a fingerprint of the code surface it just gated (plus whether the
 * describe-budget walk actually ran, which requires a live instance — during
 * an evolve, the dev server). `promote` refuses without a pass whose
 * fingerprint matches the tree as it stands NOW, and consumes the pass on
 * success so one validation can never be replayed across edits.
 *
 * This is deliberately NOT a walk-verify enforcement: the verifier is an
 * agent with the same local privileges as the builder, so a verdict file the
 * CLI checked would be forgeable theater. Verify discipline belongs to the
 * skills and the host; what the CLI can honestly enforce is "the code being
 * promoted is exactly the code that passed the gate".
 */

const GATE_PASS_FILE = join(".a2app", "gate-pass.json");

export interface GatePass {
  fingerprint: string;
  /** True when the describe-budget walk ran against a live instance — during
   *  an evolve, the dev server (routing sends validate there while one is up). */
  budgetChecked: boolean;
  at: string;
}

/** Directory/file names that are runtime state, never gated code. */
const FINGERPRINT_SKIP_DIRS = new Set([".a2app", ".git", ".lui", "node_modules"]);
const FINGERPRINT_SKIP_FILES = new Set([".agent-token", ".principal", ".superuser", ".DS_Store", "Thumbs.db"]);

/**
 * A content fingerprint of the app's code surface: every file except framework
 * runtime state (`.a2app/`), VCS internals, dependency trees, credentials, and
 * the toolkit's declared live data directory. Deterministic across platforms
 * (paths normalized to `/`, sorted, content-hashed — never mtimes).
 */
export function codeFingerprint(projectDir: string): string {
  const root = resolve(projectDir);
  const dataRoot = (() => {
    const d = dataDir(projectDir);
    return d === null ? null : resolve(d);
  })();
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (FINGERPRINT_SKIP_DIRS.has(name)) continue;
        if (dataRoot !== null && resolve(full) === dataRoot) continue;
        stack.push(full);
      } else if (!FINGERPRINT_SKIP_FILES.has(name)) {
        files.push(full);
      }
    }
  }
  const hash = createHash("sha256");
  for (const file of files.map((f) => ({ f, rel: relative(root, f).split(sep).join("/") })).sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(readFileSync(file.f));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Record a gate pass for the tree as it stands now (called by `validate` on success). */
export function writeGatePass(projectDir: string, budgetChecked: boolean): void {
  const file = join(projectDir, GATE_PASS_FILE);
  mkdirSync(join(projectDir, ".a2app"), { recursive: true });
  const pass: GatePass = { fingerprint: codeFingerprint(projectDir), budgetChecked, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(pass, null, 2) + "\n");
}

export function readGatePass(projectDir: string): GatePass | null {
  const file = join(projectDir, GATE_PASS_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<GatePass>;
    if (typeof raw.fingerprint !== "string") return null;
    return { fingerprint: raw.fingerprint, budgetChecked: raw.budgetChecked === true, at: raw.at ?? "" };
  } catch {
    return null;
  }
}

export function clearGatePass(projectDir: string): void {
  rmSync(join(projectDir, GATE_PASS_FILE), { force: true });
}

/**
 * Refuse to mutate a data directory that the app currently has open. On Windows
 * an open SQLite/store handle makes a delete/copy of the data dir fail or tear;
 * everywhere it risks an inconsistent snapshot. Confirmed by asking the port
 * whether THIS app is answering there.
 */
export async function assertNotServing(project: Project): Promise<void> {
  const port = project.manifest.port;
  if (port === undefined) return;
  const servingId = await identifyApp(port);
  if (servingId === project.manifest.id) {
    throw new EnvError(
      `"${project.manifest.name}" is currently serving on port ${port}. Stop it first ` +
        "(`agent-app stop`) before backup/restore/promote — mutating its data directory " +
        "while it is running risks corruption (open file handles, especially on Windows).",
    );
  }
}
