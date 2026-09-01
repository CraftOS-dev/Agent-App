/**
 * Safe-evolve helpers. The framework CLI orchestrates the safety invariants —
 * backup before every code-change promotion, capture before restore, rollback on
 * failure — and delegates the stack-specific action (make a dev copy, apply
 * migrations to live) to toolkit-declared commands.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { projectToolkit } from "./toolkit.js";

const BACKUP_ROOT = join(".a2app", "backups");

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

/** A monotonic-ish backup id. Time is injected so the caller controls it. */
export function backupId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Copy the live data directory into a timestamped backup. Returns the backup
 *  path, or throws (a backup that cannot be taken must abort a promotion). */
export function takeBackup(projectDir: string, id: string): string {
  const src = dataDir(projectDir);
  if (src === null) throw new Error("toolkit declares no lifecycle.dataDir — cannot back up");
  if (!existsSync(src)) throw new Error(`data directory ${src} does not exist yet`);
  const dest = join(projectDir, BACKUP_ROOT, id);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  return dest;
}

export function listBackups(projectDir: string): string[] {
  const root = join(projectDir, BACKUP_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root).sort();
}

/** Replace the live data directory with a backup's contents. */
export function restoreBackup(projectDir: string, id: string): void {
  const src = join(projectDir, BACKUP_ROOT, id);
  if (!existsSync(src)) throw new Error(`backup "${id}" not found`);
  const live = dataDir(projectDir);
  if (live === null) throw new Error("toolkit declares no lifecycle.dataDir — cannot restore");
  rmSync(live, { recursive: true, force: true });
  mkdirSync(live, { recursive: true });
  cpSync(src, live, { recursive: true });
}

/** Does a live database already exist? Decides first-install vs update
 *  structurally, never by a flag. */
export function liveExists(projectDir: string): boolean {
  const dir = dataDir(projectDir);
  return dir !== null && existsSync(dir) && readdirSync(dir).length > 0;
}
