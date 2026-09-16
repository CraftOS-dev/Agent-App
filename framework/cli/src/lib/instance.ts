/**
 * The dev-instance record: `.a2app/dev.json`.
 *
 * One file is both the process record (so `stop --dev`/`promote` can tear the
 * instance down) and the routing truth (so every operate command targets the
 * candidate while it is up). Keeping them the same file is deliberate — the
 * reference host this design was extracted from kept two routing stores that
 * had to agree, and their disagreement was a recorded production failure.
 *
 * The record is non-normative framework state (the spec pins no schema for it)
 * and lives in the project's `.a2app/` dir, which every blueprint gitignores.
 *
 * Boot directories: each `dev` boots into a FRESH `.a2app/dev/<boot-id>/`
 * (holding `data/` and `dev.log`) and old boot dirs are swept lazily. A zombie
 * process from a previous boot — Windows holds files open, and kills can fail —
 * can therefore never block the next boot; its directory just waits for a later
 * sweep. This is the one structural lesson worth keeping from the reference
 * host's shadow provisioner: never delete in place on the boot path.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { identifyApp } from "./net.js";
import { isPidAlive, killTreeForce, terminateTree, waitForExit } from "./proc.js";

export interface DevRecord {
  pid: number;
  port: number;
  url: string;
  /** Absolute path of this boot's state dir (`.a2app/dev/<boot-id>`). */
  bootDir: string;
  startedAt: string;
  healthy: boolean;
}

export function devJsonPath(projectDir: string): string {
  return join(projectDir, ".a2app", "dev.json");
}

export function devRoot(projectDir: string): string {
  return join(projectDir, ".a2app", "dev");
}

/** The current dev-instance record, or null when none exists or it is unreadable
 *  (an unreadable record is reported as absent; `dev` rewrites it on next boot). */
export function readDevRecord(projectDir: string): DevRecord | null {
  const file = devJsonPath(projectDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DevRecord>;
    if (typeof raw.port !== "number" || typeof raw.pid !== "number") return null;
    return {
      pid: raw.pid,
      port: raw.port,
      url: raw.url ?? `http://127.0.0.1:${raw.port}`,
      bootDir: raw.bootDir ?? "",
      startedAt: raw.startedAt ?? "",
      healthy: raw.healthy === true,
    };
  } catch {
    return null;
  }
}

export function clearDevRecord(projectDir: string): void {
  rmSync(devJsonPath(projectDir), { force: true });
}

/** Mint a fresh per-boot state dir `.a2app/dev/<boot-id>/` with `data/` inside.
 *  Never reuses a directory, so a locked leftover cannot block the boot. */
export function mintDevBootDir(projectDir: string): string {
  const bootId = `${Date.now().toString(16)}-${process.pid}`;
  const bootDir = join(devRoot(projectDir), bootId);
  mkdirSync(join(bootDir, "data"), { recursive: true });
  return bootDir;
}

/**
 * Stop the recorded dev instance, with the same pid-reuse discipline as `stop`:
 * kill only when the dev port answers as THIS app; a record whose port answers
 * as someone else (or not at all) is cleared without killing — after a reboot
 * the pid may belong to an innocent process. A pid that is alive but whose port
 * answers as nobody is also left alone for the same reason.
 *
 * Returns what happened so callers can report honestly:
 *   "stopped"  the instance was killed and the record cleared
 *   "cleared"  the record was stale; nothing was killed
 *   "failed"   the process would not die — the record is KEPT for a retry
 */
export async function stopDevInstance(projectDir: string, appId: string): Promise<"stopped" | "cleared" | "failed"> {
  const rec = readDevRecord(projectDir);
  if (rec === null) {
    clearDevRecord(projectDir);
    return "cleared";
  }
  const answeringId = await identifyApp(rec.port);
  if (answeringId !== appId || !isPidAlive(rec.pid)) {
    clearDevRecord(projectDir);
    return "cleared";
  }
  terminateTree(rec.pid);
  let exited = await waitForExit(rec.pid, 3000);
  if (!exited) {
    killTreeForce(rec.pid);
    exited = await waitForExit(rec.pid, 2000);
  }
  if (!exited) return "failed";
  clearDevRecord(projectDir);
  return "stopped";
}

/**
 * Delete old boot dirs under `.a2app/dev/`, keeping `keep` (or everything gone
 * when `keep` is null). Locked entries are skipped without complaint — the next
 * sweep gets them. Only ever deletes inside the dev root, by construction.
 */
export function sweepDevBootDirs(projectDir: string, keep: string | null): void {
  const root = devRoot(projectDir);
  if (!existsSync(root)) return;
  const keepResolved = keep === null ? null : resolve(keep);
  for (const name of readdirSync(root)) {
    const entry = join(root, name);
    if (keepResolved !== null && resolve(entry) === keepResolved) continue;
    try {
      rmSync(entry, { recursive: true, force: true });
    } catch {
      /* locked by a zombie process — the next sweep gets it */
    }
  }
  if (keep === null) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* same: locked, swept later */
    }
  }
}
