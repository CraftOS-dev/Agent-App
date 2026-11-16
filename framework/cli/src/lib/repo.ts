/**
 * The app's history: a git repository of its own (Quality Standard Q18).
 *
 * Every app the framework creates or installs gets one, with the app as it
 * arrived as the first commit, so its history starts where the app does. The
 * builder commits each coherent change through `agent-app <dir> commit` (which
 * needs no shell of the harness's own), walk-verify verifies a commit, and a
 * re-verify reads what changed since the commit it last verified.
 *
 * An app inside another repository's work tree (a monorepo) is versioned
 * there: no repository is nested in it, and a commit takes the app's own paths
 * only, never anything else staged in that repository.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { log } from "./log.js";
import { EnvError } from "./project.js";

const GIT_TIMEOUT_MS = 60_000;

/** The identity a commit falls back on where git has none configured. */
const FALLBACK_IDENTITY: Record<string, string> = { "user.name": "Agent App", "user.email": "agent-app@localhost" };

/** git is not installed: the app's history can be neither kept nor checked. */
export class GitMissingError extends EnvError {
  constructor() {
    super("git is not on PATH: install git — the app's history (Quality Standard Q18) is kept with it");
    this.name = "GitMissingError";
  }
}

/**
 * Run git in `dir`. It never prompts: a commit that would need a person (a
 * signing passphrase, a credential) fails within the timeout instead of
 * waiting, since the CLI may be running where no one can answer.
 */
function run(dir: string, args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; signal?: string };
    if (e.code === "ENOENT") throw new GitMissingError();
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") throw new EnvError(`git ${args[0]} did not finish within ${GIT_TIMEOUT_MS / 1000}s`);
    return { ok: false, stderr: String(e.stderr ?? e.message).trim() };
  }
}

function git(dir: string, args: string[]): string {
  const result = run(dir, args);
  if (!result.ok) throw new EnvError(`git ${args[0]} failed in ${dir}: ${result.stderr}`);
  return result.stdout;
}

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== "");

/** Whether git is installed. */
export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** The root of the work tree `dir` is in, or null when it is in none. */
export function workTree(dir: string): string | null {
  const result = run(dir, ["rev-parse", "--show-toplevel"]);
  if (result.ok) return result.stdout.trim();
  if (/not a git repository/i.test(result.stderr)) return null;
  throw new EnvError(`git cannot read ${dir}: ${result.stderr}`);
}

/** The commit HEAD names, or null before the first commit. */
function head(dir: string): string | null {
  const result = run(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

/** `-c` options for each part of the commit identity git has no value for. */
function identity(dir: string): string[] {
  return Object.entries(FALLBACK_IDENTITY).flatMap(([key, value]) => (run(dir, ["config", "--get", key]).ok ? [] : ["-c", `${key}=${value}`]));
}

/** Whether `a` and `b` are the same folder, however each is written. */
function samePath(a: string, b: string): boolean {
  return relative(realpathSync.native(a), realpathSync.native(b)) === "";
}

/** Give `dir` a repository of its own. */
export function createRepository(dir: string): void {
  git(dir, ["init", "--quiet"]);
}

export interface Commit {
  /** HEAD afterwards: the new commit, or the one already holding this tree; null when there is none yet */
  commit: string | null;
  /** whether a commit was made (false: nothing had changed) */
  committed: boolean;
  /** the paths committed, relative to the app */
  files: string[];
}

/**
 * Commit everything under `dir` its ignore rules do not exclude. Only `dir`'s
 * own paths are staged and committed, so in a larger repository nothing else
 * already staged there is swept in.
 */
export function commitApp(dir: string, message: string): Commit {
  git(dir, ["add", "--all", "--", "."]);
  const files = lines(git(dir, ["diff", "--cached", "--name-only", "--relative", "--", "."]));
  if (files.length === 0) return { commit: head(dir), committed: false, files };
  git(dir, [...identity(dir), "commit", "--quiet", "--message", message, "--", "."]);
  return { commit: head(dir), committed: true, files };
}

/** The paths under `dir` that differ from its last commit (untracked ones included), or null when there is no repository to compare. */
export function uncommitted(dir: string): string[] | null {
  const result = run(dir, ["status", "--porcelain", "--untracked-files=all", "--", "."]);
  return result.ok ? lines(result.stdout) : null;
}

/**
 * Start the history of an app the framework has just created or installed:
 * a repository of its own (unless one around it already versions it) with
 * the app as it stands as the first commit. Never fails the caller — the app
 * works without git, and the gate says what is missing. Returns the commit.
 */
export function startHistory(dir: string, message: string): string | null {
  try {
    const top = workTree(dir);
    if (top !== null && !samePath(top, dir)) {
      log.info(`the app is versioned by the repository at ${top}; it gets none of its own`);
      return null;
    }
    if (top === null) createRepository(dir);
    const { commit } = commitApp(dir, message);
    if (commit !== null) log.step(`history started: ${commit.slice(0, 12)} ${message}`);
    return commit;
  } catch (err) {
    log.warn(`the app's history was not started: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
