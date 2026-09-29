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
import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "node:child_process";

/**
 * On Windows, the shell `spawnBackgroundShell` launches runs inside this: a
 * console-less node that starts the shell with `windowsHide`, so the shell and
 * everything under it share ONE hidden console. It exits with the shell's code.
 */
const HIDDEN_SHELL =
  "const c=require('child_process').spawn(process.argv[1],{shell:true,stdio:'inherit',windowsHide:true});" +
  "c.on('error',e=>{console.error(e.message);process.exit(127)});" +
  "c.on('exit',code=>process.exit(code??1))";

/**
 * Start a trusted shell command as a detached background process — the shape
 * `serve`, `dev` and a bridge gateway all need — without putting a terminal
 * window on the user's desktop.
 *
 * `windowsHide` alone is not enough for this shape. `detached` on Windows starts
 * the shell with no console at all, so the first console program IT runs (the
 * app's server) is given a brand-new, visible one — out of reach of any flag
 * passed here. Starting the shell from a console-less node that passes
 * `windowsHide` itself gives the whole tree one hidden console instead. The
 * wrapper is the recorded pid; `taskkill /T` still reaches everything below it.
 */
export function spawnBackgroundShell(
  command: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; stdio: StdioOptions },
): ChildProcess {
  const base = { cwd: opts.cwd, detached: true, stdio: opts.stdio, windowsHide: true, ...(opts.env ? { env: opts.env } : {}) };
  if (process.platform === "win32") return spawn(process.execPath, ["-e", HIDDEN_SHELL, command], base);
  return spawn(command, { ...base, shell: true });
}

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
      execFileSync("taskkill", ["/pid", String(pid), "/T"], { stdio: "ignore", windowsHide: true });
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
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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
