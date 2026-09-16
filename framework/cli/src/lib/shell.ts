/** Run a shell command, capturing combined output; throw a rich error on
 *  failure so the gate can report a true, machine-readable message. */
import { execSync } from "node:child_process";

export interface ShellResult {
  stdout: string;
  stderr: string;
}

export interface ShellOptions {
  timeoutMs?: number;
  /** Extra environment variables, merged over the current process env. Used by
   *  lifecycle commands to pass the launch contract (A2APP_DATA_DIR, A2APP_ENV)
   *  to toolkit scripts. */
  env?: Record<string, string>;
}

export function runShell(command: string, cwd: string, opts: ShellOptions = {}): ShellResult {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 600_000,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { stdout: String(stdout ?? ""), stderr: "" };
  } catch (err) {
    const e = err as Error & { stdout?: unknown; stderr?: unknown; status?: number };
    const message = [e.stdout, e.stderr]
      .map((s) => String(s ?? "").trim())
      .filter((s) => s !== "")
      .join("\n");
    throw new Error(message === "" ? e.message : message);
  }
}
