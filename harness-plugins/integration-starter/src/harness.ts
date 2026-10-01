/**
 * A plugin's half of the app→agent ladder: telling the framework how to start
 * this harness.
 *
 * `agent-app <dir> bridge` watches an app's task queue and, when work appears,
 * starts an agent harness by whatever route that harness offers. It reads those
 * routes from `$A2APP_HOME/harnesses.json` (default `~/.a2app/harnesses.json`),
 * on top of a few built-in headless profiles. A harness with no built-in
 * profile is invisible to the bridge until something writes its route there,
 * and the plugin is the only thing that knows the route, so the plugin writes
 * it: once, when it loads.
 *
 * What it writes is the machine's file, not the plugin's, so the rules are
 * strict. It adds its own profile only when no profile with that id exists; it
 * never edits or removes another entry, never sets `default` (which harness the
 * bridge drives is the user's choice), and never rewrites a file it cannot
 * parse. A user who edits the entry keeps their edit; deleting the entry makes
 * the plugin write it again on its next load.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The `{prompt}` placeholder a headless route substitutes the task prompt into. */
export const PROMPT_PLACEHOLDER = "{prompt}";

/** Rung 1: an HTTP endpoint the harness already serves. */
export interface InboundRoute {
  mode: "inbound";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** the NAME of an env var holding a bearer token, never the token itself */
  tokenEnv?: string;
  health?: string;
}

/** Rung 2: the harness's one-shot headless CLI. */
export interface HeadlessRoute {
  mode: "headless";
  command: string;
  /** exactly one element carries {@link PROMPT_PLACEHOLDER}, unless `input` is "stdin" */
  args: string[];
  input?: "arg" | "stdin";
  cwd?: string;
  timeoutMs?: number;
}

/** Rung 3: a local gateway the bridge starts, then posts to. */
export interface GatewayRoute {
  mode: "gateway";
  url: string;
  start: string;
  health: string;
  readyMs?: number;
  method?: string;
  headers?: Record<string, string>;
  tokenEnv?: string;
}

/** Rung 4: the harness polls for its own work. */
export interface SubscribeRoute {
  mode: "subscribe";
  hint?: string;
}

export type HarnessRoute = InboundRoute | HeadlessRoute | GatewayRoute | SubscribeRoute;

export interface HarnessProfile {
  id: string;
  name?: string;
  routes: HarnessRoute[];
}

export interface HarnessRegistration {
  /** `registered`: written now · `kept`: a profile with this id was already there ·
   *  `refused`: the file exists but could not be read, so it was left alone */
  status: "registered" | "kept" | "refused";
  file: string;
  detail: string;
}

/** The file the bridge reads — the same resolution as the framework home. */
export function harnessesFile(): string {
  const override = process.env["A2APP_HOME"];
  const home = override && override.trim() !== "" ? resolve(override) : join(homedir(), ".a2app");
  return join(home, "harnesses.json");
}

/** Write via a synced temp file and a rename, so a crash never leaves the
 *  machine's harness file present but empty. */
function writeAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Add `profile` to the machine's harness file unless a profile with its id is
 * already there. Never throws for a file it cannot use: the plugin loading must
 * not fail because of it, so the outcome is returned for the plugin to log.
 */
export function registerHarnessProfile(profile: HarnessProfile): HarnessRegistration {
  const file = harnessesFile();
  let doc: Record<string, unknown> = { version: 1, harnesses: [] };
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      return { status: "refused", file, detail: `${file} is not valid JSON (${(err as Error).message}); left it alone` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "refused", file, detail: `${file} is not a JSON object; left it alone` };
    }
    doc = parsed as Record<string, unknown>;
    if (doc["harnesses"] === undefined) doc["harnesses"] = [];
    if (!Array.isArray(doc["harnesses"])) {
      return { status: "refused", file, detail: `${file} has a "harnesses" that is not an array; left it alone` };
    }
  }
  const harnesses = doc["harnesses"] as unknown[];
  const taken = harnesses.some((h) => (h as { id?: unknown } | null)?.id === profile.id);
  if (taken) return { status: "kept", file, detail: `a "${profile.id}" profile is already in ${file}` };
  harnesses.push(profile);
  try {
    writeAtomic(file, JSON.stringify(doc, null, 2) + "\n");
  } catch (err) {
    return { status: "refused", file, detail: `could not write ${file}: ${(err as Error).message}` };
  }
  return { status: "registered", file, detail: `registered the "${profile.id}" harness for \`agent-app <dir> bridge\` in ${file}` };
}
