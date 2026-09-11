/**
 * agent-app <app> remove — delete an app's files AND drop it from the registry.
 *
 * Destructive, so gated three independent ways:
 *   1. Ownership — refuses anything without an ownership canon
 *      (`.a2app/system-hashes.json`), which a conforming Agent App always has.
 *      This is the guard against `rm`-ing a mistyped path that is not one of our
 *      apps at all. Override with --force only when you are certain.
 *   2. Liveness — refuses a running app (open file handles + data safety); stop
 *      it first. Not overridable: deleting a live app's files is never safe.
 *   3. Confirmation — does nothing without an explicit --yes; without it, prints
 *      exactly what would happen and stops (exit 2).
 *
 * Before deleting, the live DATA directory is copied to an OUT-OF-APP backup
 * under the framework home. An app's code is reproducible from its toolkit; its
 * data is not, so removal preserves the one irreplaceable part. (An in-app
 * backup would be deleted along with the app, which is why `backup` is not
 * reused here.)
 *
 * For registry-only cleanup that never touches files, use `forget`.
 */
import { renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadProject, UsageError } from "../lib/project.js";
import { canonPaths } from "../lib/canon.js";
import { assertNotServing, backupId, dataDir, lifecycleLock, liveExists } from "../lib/lifecycle.js";
import { copyDirAtomic } from "../lib/fsx.js";
import { withLock } from "../lib/lock.js";
import { unregister } from "../lib/registry.js";
import { homePath } from "../lib/home.js";
import { hasFlag } from "../lib/args.js";
import { log } from "../lib/log.js";

/** Where a removed app's data snapshot is kept, under the framework home. */
const REMOVED_ROOT = "removed";

/** A filesystem-safe backup folder name from an app name. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/** Transient on Windows: an AV scan, the search indexer, or another handle is
 *  momentarily open on the target. The same set home.ts retries writes on. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

/** A monotonic-per-process suffix so the move-aside name never collides. */
let asideCounter = 0;

/**
 * Rename, retrying transient Windows sharing errors. A single rename is atomic —
 * it moves the whole tree or nothing — so unlike a recursive delete it can never
 * leave a half-removed app behind; the retry only rides out a momentary lock.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!TRANSIENT.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + attempt * 10);
    }
  }
  renameSync(from, to); // last attempt: let a persistent failure surface
}

export async function run(args: string[], app: string): Promise<number> {
  let project;
  try {
    project = loadProject(app);
  } catch (err) {
    // A dead registry entry (directory already gone) has no files to remove — the
    // job is registry-only, which is exactly what `forget` does.
    if (err instanceof UsageError) {
      throw new UsageError(
        `${err.message} (If this is a stale registry entry with no files, use \`agent-app ${app} forget\`.)`,
      );
    }
    throw err;
  }
  const { id, name } = project.manifest;
  const port = project.manifest.port;

  // Guard 1 — ownership. A conforming app always has a non-empty canon; its
  // absence means this directory is not a framework-managed Agent App.
  if (!hasFlag(args, "force") && canonPaths(project.dir).length === 0) {
    log.error(
      `"${name}" has no ownership canon (${join(".a2app", "system-hashes.json")}) — refusing to delete a ` +
        `directory that is not a framework-managed Agent App. Re-check the path, or pass --force if certain.`,
    );
    log.raw(JSON.stringify({ ok: false, removed: null, reason: "no-canon" }, null, 2));
    return 1;
  }

  // Guard 2 — liveness. Throws EnvError (exit 1) with an actionable message if
  // this app is answering on its port.
  await assertNotServing(project);

  const src = dataDir(project.dir);
  const hasData = src !== null && liveExists(project.dir);

  // Guard 3 — confirmation. Show the consequences and stop until --yes.
  if (!hasFlag(args, "yes")) {
    log.warn(`This will DELETE "${name}" and drop it from the registry.`);
    log.info(`  directory:  ${project.dir}`);
    log.info(`  port freed: ${port ?? "—"}`);
    log.info(hasData ? `  data backed up under ${homePath(REMOVED_ROOT)} first` : `  no live data to back up`);
    log.info(`Re-run with --yes to proceed.`);
    log.raw(JSON.stringify({ ok: false, removed: null, reason: "unconfirmed", dir: project.dir, hasData }, null, 2));
    return 2;
  }

  // Snapshot + move-aside under the per-app lifecycle lock, so no dev/promote/
  // backup races the removal. The app dir is renamed to a sibling in ONE atomic
  // step rather than deleted in place: a recursive delete on Windows is neither
  // atomic nor retry-safe (a transient EPERM/EBUSY from an AV scan or a lingering
  // handle aborts it mid-tree, leaving a half-app that is still registered),
  // whereas a rename either moves the whole tree or changes nothing. After it
  // the app is gone from its path. `unregister` takes the (different) home lock,
  // so there is no reentrant-lock deadlock.
  const { dataBackup, aside } = await withLock(lifecycleLock(project.dir), async () => {
    let backup: string | null = null;
    if (hasData && src !== null) {
      backup = homePath(REMOVED_ROOT, `${safeName(name)}-${backupId(new Date())}`, "data");
      copyDirAtomic(src, backup); // atomic + file-count verified; throws on a torn copy
    }
    const target = `${project.dir}.removing-${process.pid}-${asideCounter++}`;
    renameWithRetry(project.dir, target);
    return { dataBackup: backup, aside: target };
  });

  // The app is gone from its path; drop the registry row. If this fails, the
  // entry is simply a dead one that `agent-app list --prune` (or `forget`) clears.
  await unregister(project.dir);

  // Reclaim the disk. Best-effort with retries: the app is already removed, so a
  // temp dir that a stray handle keeps alive is a harmless orphan, never a loss.
  let reclaimed = true;
  try {
    rmSync(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    reclaimed = false;
  }

  log.ok(`removed "${name}"${port !== undefined ? ` (port ${port} released)` : ""}`);
  if (dataBackup) log.info(`data backed up at ${dirname(dataBackup)}`);
  if (!reclaimed) log.warn(`could not fully delete ${aside} (a process may hold it) — remove it manually later.`);
  log.raw(
    JSON.stringify(
      { ok: true, removed: { id, name, path: project.dir, port: port ?? null }, dataBackup },
      null,
      2,
    ),
  );
  return 0;
}
