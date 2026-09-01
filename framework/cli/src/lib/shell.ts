/** Run a shell command, capturing combined output; throw a rich error on
 *  failure so the gate can report a true, machine-readable message. */
import { execSync } from "node:child_process";

export interface ShellResult {
  stdout: string;
  stderr: string;
}

export function runShell(command: string, cwd: string, timeoutMs = 600_000): ShellResult {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
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
