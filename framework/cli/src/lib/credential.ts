/**
 * Agent credential handling, shared by scaffold and import.
 *
 * Credentials are RUNTIME artifacts, never shipped, exported, or committed. On
 * import in particular, any credential that arrived in the source is an
 * attacker's known key and MUST be stripped before the app is registered or
 * launched — keeping it would hand an unknown party a live grant.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { log } from "./log.js";

/** All runtime credential files an app may carry. */
const CREDENTIAL_FILES = [".agent-token", ".principal", ".superuser"];

/** Remove every shipped credential from a directory. Returns how many were found. */
export function stripCredentials(dir: string): number {
  let removed = 0;
  for (const name of CREDENTIAL_FILES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/**
 * Restrict a credential file to the current user. `mode: 0o600` is honoured on
 * POSIX but is a no-op on Windows, where the file otherwise inherits the
 * directory ACL. Best-effort: a failure warns but does not abort.
 */
function restrictToOwner(file: string): void {
  if (process.platform !== "win32") return;
  const user = process.env["USERNAME"];
  if (!user) return;
  try {
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch {
    log.warn(`could not restrict permissions on ${file} — review its ACL manually`);
  }
}

/** Mint a fresh agent credential (0600 + owner-only on Windows). Returns its path. */
export function mintAgentToken(dir: string): string {
  const p = join(dir, ".agent-token");
  writeFileSync(p, "a2app_" + randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
  restrictToOwner(p);
  return p;
}
