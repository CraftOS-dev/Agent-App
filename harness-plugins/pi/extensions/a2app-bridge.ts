/**
 * Makes Pi reachable from `agent-app <dir> bridge`, the framework service that
 * starts an agent harness when an Agent App queues work for one.
 *
 * The bridge starts a harness by a route read from `$A2APP_HOME/harnesses.json`
 * (default `~/.a2app/harnesses.json`). The framework ships no Pi profile, so
 * until this extension writes one the bridge cannot see Pi at all. The route is
 * Pi's print mode, `pi -p "<prompt>"`: one run in the app's directory, then
 * exit. Pi's bash tool asks no permission, so the agent can operate the app
 * through the a2app CLI unattended.
 *
 * The file is the machine's, shared by every harness, so this only ever ADDS a
 * "pi" profile when none exists. It never edits another entry, never sets
 * `default`, and never rewrites a file it cannot parse. A user's edit to the
 * entry is kept; deleting it makes this write it again on the next start.
 *
 * Self-contained on purpose (Node built-ins only): Pi installs this package by
 * copying files, so there is no dependency install to rely on. The same rules
 * live in `@a2app/integration-starter`'s `registerHarnessProfile`, which the
 * other plugins use.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROFILE = {
  id: "pi",
  name: "Pi",
  routes: [{ mode: "headless", command: "pi", args: ["-p", "{prompt}"] }],
};

type Outcome = { status: "registered" | "kept" | "refused"; detail: string };

function harnessesFile(): string {
  const override = process.env["A2APP_HOME"];
  const home = override && override.trim() !== "" ? resolve(override) : join(homedir(), ".a2app");
  return join(home, "harnesses.json");
}

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

function register(): Outcome {
  const file = harnessesFile();
  let doc: Record<string, unknown> = { version: 1, harnesses: [] };
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      return { status: "refused", detail: `${file} is not valid JSON (${(err as Error).message}); left it alone` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "refused", detail: `${file} is not a JSON object; left it alone` };
    }
    doc = parsed as Record<string, unknown>;
    if (doc["harnesses"] === undefined) doc["harnesses"] = [];
    if (!Array.isArray(doc["harnesses"])) {
      return { status: "refused", detail: `${file} has a "harnesses" that is not an array; left it alone` };
    }
  }
  const harnesses = doc["harnesses"] as unknown[];
  if (harnesses.some((h) => (h as { id?: unknown } | null)?.id === PROFILE.id)) {
    return { status: "kept", detail: `a "pi" profile is already in ${file}` };
  }
  harnesses.push(PROFILE);
  try {
    writeAtomic(file, JSON.stringify(doc, null, 2) + "\n");
  } catch (err) {
    return { status: "refused", detail: `could not write ${file}: ${(err as Error).message}` };
  }
  return { status: "registered", detail: `registered Pi for \`agent-app <dir> bridge\` in ${file}` };
}

/** The part of Pi's ExtensionAPI this uses. */
interface PiApi {
  on(event: "session_start", handler: (event: unknown, ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }) => void): void;
}

export default function (pi: PiApi): void {
  const outcome = register();
  if (outcome.status === "kept") return;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`agent-app: ${outcome.detail}`, outcome.status === "refused" ? "warning" : "info");
  });
}
