/**
 * Process control for launched apps.
 *
 * `serve` spawns the app detached and records its pid; `stop` ends it. Both must
 * be careful: a recorded pid can be stale (the app already exited) or, after a
 * reboot, REUSED by an unrelated process — so a blind `kill` can take down
 * something innocent. These helpers make liveness and termination explicit, and
 * refuse to signal pid <= 1 (never signal init / a whole process group by
 * accident).
 */
import { execFileSync } from "node:child_process";

/** Is this pid a live process? (EPERM means it exists but we may not signal it.) */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Ask the process tree rooted at `pid` to terminate gracefully (SIGTERM / a
 *  non-forced taskkill). Returns false if the pid is invalid. */
export function terminateTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T"], { stdio: "ignore" });
    } else {
      // Negative pid signals the whole group (serve spawns detached, so the
      // child is its own group leader); fall back to the bare pid.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Force-kill the process tree rooted at `pid` (SIGKILL / taskkill /F). */
export function killTreeForce(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone or the deadline passes. Returns true if it exited. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}
