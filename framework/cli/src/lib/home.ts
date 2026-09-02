/**
 * The framework home — where user-level, cross-app state lives (framework
 * section 5.6/5.7): the app registry and the global conventions file.
 *
 * `A2APP_HOME` if set, else `~/.a2app`. One home per user, shared by every agent
 * and host on the machine, so two harnesses never keep private, divergent views
 * of the same apps. Nothing here is required for an app to be complete: an app
 * is any directory with a `manifest.json`.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const REGISTRY_FILE = "registry.json";
export const GLOBAL_DOC_FILE = "GLOBAL_AGENT_APP.md";

/** The framework home directory (not created by this call). */
export function homeDir(): string {
  const override = process.env["A2APP_HOME"];
  return override && override.trim() !== "" ? resolve(override) : join(homedir(), ".a2app");
}

/** A path inside the framework home. */
export function homePath(...parts: string[]): string {
  return join(homeDir(), ...parts);
}

/** Ensure the home exists and return it. */
export function ensureHome(): string {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Block this thread briefly without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Transient on Windows: another handle is momentarily open on the target. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Write a file atomically (temp + rename), so a crash or a second process
 * mid-write can never leave a half-written file behind.
 *
 * The rename is retried on transient sharing errors: on Windows, replacing an
 * existing file fails with EPERM/EBUSY whenever any other process holds a handle
 * on it — including a reader that is only listing apps. A single attempt makes
 * concurrent commands fail sporadically and silently lose registry entries.
 */
export function writeFileAtomic(file: string, contents: string, attempts = 12): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      lastError = err;
      if (!TRANSIENT.has((err as NodeJS.ErrnoException).code ?? "")) break;
      sleepSync(15 + attempt * 10);
    }
  }
  rmSync(tmp, { force: true });
  throw lastError;
}
