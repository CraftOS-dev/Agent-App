/**
 * A cross-process advisory lock for the framework home.
 *
 * The registry is shared by every `agent-app` invocation on the machine, and each
 * invocation is a SEPARATE process — so an in-process mutex cannot protect it.
 * Without a real lock, two concurrent `scaffold` runs both read the registry, both
 * pick the same free port, and both write: one entry is lost and two apps get
 * the same port, which is exactly the failure the registry exists to prevent.
 *
 * Implementation: `mkdir` is atomic and fails if the directory exists on every
 * supported platform, which makes it a portable mutex with no dependencies. The
 * holder's pid and start time are recorded inside for diagnosis, and a lock left
 * behind by a killed process is broken once it is provably stale.
 */
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome } from "./home.js";

const LOCK_FILE = ".registry.lock";
const STALE_AFTER_MS = 30_000;
const RETRY_MS = 25;
const ACQUIRE_TIMEOUT_MS = 10_000;

function lockPath(): string {
  return join(ensureHome(), LOCK_FILE);
}

function readHolder(file: string): { pid: number; at: number } | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { pid: number; at: number };
  } catch {
    return null;
  }
}

/**
 * Is the recorded holder gone, or the lock simply too old to be believed?
 *
 * An unreadable holder is NOT assumed abandoned: it is judged by the lock's own
 * age instead. Assuming otherwise breaks a live lock during the instant between
 * creating it and describing its owner — which lets two processes hold it at
 * once, the exact corruption the lock exists to prevent.
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
  if (Date.now() - holder.at > STALE_AFTER_MS) return true;
  try {
    process.kill(holder.pid, 0); // signal 0 only tests for existence
    return false;
  } catch {
    return true; // no such process — the holder died holding the lock
  }
}

/**
 * Run `fn` with the home lock held. Always releases, including on throw, so one
 * failed command never wedges every later one.
 */
export async function withHomeLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const file = lockPath();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // `wx` is O_CREAT|O_EXCL: the file and its owner record come into
      // existence together, so there is no instant where the lock is held by
      // nobody. Fails when it already exists.
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      break;
    } catch {
      if (isStale(file)) {
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        const holder = readHolder(file);
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
