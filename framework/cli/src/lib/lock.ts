/**
 * A cross-process advisory lock for the framework home.
 *
 * The registry is shared by every `agent-app` invocation on the machine, and each
 * invocation is a SEPARATE process — so an in-process mutex cannot protect it.
 * Without a real lock, two concurrent `scaffold` runs both read the registry, both
 * pick the same free port, and both write: one entry is lost and two apps get
 * the same port, which is exactly the failure the registry exists to prevent.
 *
 * Implementation: an exclusive `wx` create is atomic and fails if the file
 * exists on every supported platform, which makes it a portable mutex with no
 * dependencies. The holder's pid and start time are recorded inside for
 * diagnosis and liveness. A lock left behind by a killed process is broken —
 * but the break is atomic and identity-checked (rename-to-unique, then verify
 * we captured the SAME stale record we meant to break), so two waiters can
 * never both "break" their way into the critical section at once.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureHome } from "./home.js";

const LOCK_FILE = ".registry.lock";
/** How long an UNREADABLE lock (no owner record) may sit before it is broken. */
const STALE_AFTER_MS = 30_000;
/** Absolute ceiling: a lock older than this is broken even if its recorded pid
 *  still resolves — the pid has almost certainly been reused, or the holder is
 *  wedged. Well above any real critical section (which is now sub-second: no
 *  network I/O runs under the lock — see registry.reserveApp). */
const REUSE_CEILING_MS = 300_000;
const RETRY_MS = 25;
const ACQUIRE_TIMEOUT_MS = 10_000;

interface Holder {
  pid: number;
  at: number;
}

function lockPath(): string {
  return join(ensureHome(), LOCK_FILE);
}

function readHolder(file: string): Holder | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Holder;
  } catch {
    return null;
  }
}

function sameHolder(a: Holder | null, b: Holder | null): boolean {
  if (a === null || b === null) return a === b; // both unreadable counts as "same"
  return a.pid === b.pid && a.at === b.at;
}

/**
 * Is the lock stale — the holder gone, or the lock too old to be believed?
 *
 * A LIVING holder is never stale on age alone: a critical section that legitly
 * runs longer than 30s (or a process suspended by sleep) must not have its lock
 * stolen. Only a dead pid, an unreadable owner record past the age cutoff, or a
 * lock past the absolute reuse ceiling is broken.
 */
function isStale(file: string): boolean {
  const holder = readHolder(file);
  if (holder === null) {
    try {
      return Date.now() - statSync(file).mtimeMs > STALE_AFTER_MS;
    } catch {
      return false; // vanished: someone else released it, just retry
    }
  }
  if (Date.now() - holder.at > REUSE_CEILING_MS) return true; // pid-reuse / wedged backstop
  try {
    process.kill(holder.pid, 0); // signal 0 only tests for existence
    return false;
  } catch {
    return true; // no such process — the holder died holding the lock
  }
}

/**
 * Break a lock we believe is stale, atomically. Rename it to a unique name
 * (only one process wins the rename of a given inode); then verify we captured
 * the same record we intended to break. If instead we captured a FRESH lock
 * (another process acquired it in the gap between our staleness check and the
 * rename), put it back untouched. Returns true if a stale lock was removed.
 */
let breakCounter = 0;
function breakIfStale(file: string, expected: Holder | null): boolean {
  const captured = `${file}.breaking.${process.pid}.${breakCounter++}`;
  try {
    renameSync(file, captured);
  } catch {
    return false; // someone else already moved/released it — just retry
  }
  const got = readHolder(captured);
  if (!sameHolder(got, expected)) {
    // We stole a lock that had been refreshed since we judged it stale. Restore
    // it and let its owner keep it; we go back to waiting.
    try {
      renameSync(captured, file);
    } catch {
      rmSync(captured, { recursive: true, force: true });
    }
    return false;
  }
  rmSync(captured, { recursive: true, force: true });
  return true;
}

/**
 * Run `fn` while holding the lock at `file`. Always releases, including on
 * throw, so one failed command never wedges every later one. Used both for the
 * home/registry lock and for per-app locks (serve/stop, and the lifecycle
 * mutations backup/restore/promote/dev), which must not run two at once against
 * the same app's data directory.
 */
export async function withLock<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // `wx` is O_CREAT|O_EXCL: the file and its owner record come into
      // existence together, so there is no instant where the lock is held by
      // nobody. Fails when it already exists.
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      break;
    } catch {
      const holder = readHolder(file);
      if (isStale(file)) {
        breakIfStale(file, holder);
        continue; // retry the wx create; only one process wins it
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for the registry lock at ${file}` +
            (holder ? ` (held by pid ${holder.pid})` : "") +
            ". If no agent-app command is running, delete that file.",
        );
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/** Run `fn` while holding the framework-home (registry) lock. */
export async function withHomeLock<T>(fn: () => Promise<T> | T): Promise<T> {
  return withLock(lockPath(), fn);
}
