#!/usr/bin/env node
/**
 * a2app-sidecar [<dir>]           run the adopted app in <dir> (default: the
 *                                 current directory) behind its A2App surface
 * a2app-sidecar --check [<dir>]   check sidecar.json against manifest.json and
 *                                 operations.json; exit 1 naming each problem
 *
 * An adopted app's `pipeline.start` runs the first form; its toolkit gate runs
 * the second. Exit codes: 0 stopped cleanly or checked clean, 1 refused or the
 * app went away, 2 usage.
 */
import { resolve } from "node:path";
import { loadAdoptedApp } from "./config.js";
import { jsonLog, SidecarConfigError, startSidecar, type Sidecar } from "./sidecar.js";

const USAGE = "usage: a2app-sidecar [--check] [<app dir>]";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const positionals = args.filter((a) => !a.startsWith("-"));
if (flags.some((f) => f !== "--check") || positionals.length > 1) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const dir = resolve(positionals[0] ?? ".");

if (flags.includes("--check")) {
  const result = loadAdoptedApp(dir);
  if (!result.ok) {
    process.stderr.write(`sidecar: ${result.problems.length} problem(s)\n  - ${result.problems.join("\n  - ")}\n`);
    process.exit(1);
  }
  const { operations, sidecar } = result.app;
  process.stdout.write(
    `sidecar ok: ${operations.length} operation(s), each mapped onto a route of \`${sidecar.upstream.command.join(" ")}\`\n`,
  );
  process.exit(0);
}

const log = jsonLog;
let sidecar: Sidecar | null = null;

// Fail fast and loudly: a structured last line beats a silent wedge, and the
// launch contract's supervisor is what restarts the process, not the process.
process.on("uncaughtException", (err) => {
  log("error", "crash", { message: err?.message, stack: err?.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason as Error | undefined;
  log("error", "crash", { message: String(err?.message ?? reason), stack: err?.stack });
  process.exit(1);
});
// Whatever ends this process, the app it started goes with it.
process.on("exit", () => sidecar?.killUpstreamNow());

try {
  sidecar = await startSidecar({ dir, log });
} catch (e) {
  log("error", "boot-failed", {
    message: (e as Error).message,
    ...(e instanceof SidecarConfigError ? { problems: e.problems } : {}),
  });
  process.exit(1);
}

const running = sidecar;
// Windows delivers no SIGTERM; a console's Ctrl+C and Ctrl+Break arrive as
// SIGINT and SIGBREAK.
const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  process.once(signal, () => {
    log("info", "stop", { signal });
    void running.stop();
  });
}

const closed = await running.closed;
// End by letting the event loop drain rather than with process.exit(): on
// Windows, exiting while the app's just-ended process handle is still closing
// aborts Node (0xC0000409). The unref'd timer only fires if something still
// holds the loop open, and then ends the process anyway.
process.exitCode = closed.reason === "stopped" ? 0 : 1;
setTimeout(() => process.exit(), 2000).unref();
