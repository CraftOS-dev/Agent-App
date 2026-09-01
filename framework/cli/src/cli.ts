#!/usr/bin/env node
/**
 * a2app — the Agent App / A2App CLI.
 *
 * Thin dispatcher: each command is a module in ./commands exporting
 * `run(args): Promise<number>`. The exit-code contract is uniform across build,
 * evolve, and operate:
 *   0 success · 1 rejected (gate/guard) · 2 usage error · 3 app unreachable.
 * On success the machine-readable result is on stdout; diagnostics go to stderr.
 */
import { A2AppUnreachableError } from "@a2app/sdk";
import { UsageError } from "./lib/project.js";
import { ValuelessFlagError } from "./lib/args.js";
import { log } from "./lib/log.js";

export const VERSION = "0.1.0";

interface CommandMeta {
  summary: string;
  group: "build/evolve" | "operate";
}

const COMMANDS: Record<string, CommandMeta> = {
  // build / evolve (framework CLI)
  create: { summary: "Scaffold a new Agent App (framework files + ownership canon)", group: "build/evolve" },
  validate: { summary: "Run the validation + security gate", group: "build/evolve" },
  "toolkit-sync": { summary: "Re-vendor system files and re-record the ownership canon", group: "build/evolve" },
  "adapter-sync": { summary: "Deliver/update the A2App adapter (no rebuild)", group: "build/evolve" },
  serve: { summary: "Launch the app via its manifest pipeline as a managed background process (health-polled)", group: "build/evolve" },
  stop: { summary: "Stop an app launched with `a2app serve`", group: "build/evolve" },
  dev: { summary: "Boot a dev copy on a hidden port with a fresh, migration-replayed database", group: "build/evolve" },
  promote: { summary: "Pre-promote backup, then apply the dev copy's migrations to live", group: "build/evolve" },
  backup: { summary: "Take an explicit backup of the live database", group: "build/evolve" },
  restore: { summary: "Restore a backup (captures current state, rolls back on failure)", group: "build/evolve" },
  "walk-verify": { summary: "Verify a running app against reference/requirements.md", group: "build/evolve" },
  // operate (A2App protocol)
  identity: { summary: "Probe the app's identity document", group: "operate" },
  data: { summary: "Read/write records; `data <dir> schema` shows the data model", group: "operate" },
  ops: { summary: "List the app's declared operations", group: "operate" },
  run: { summary: "Invoke a declared operation (destructive ops need approval)", group: "operate" },
  whoami: { summary: "Show the calling credential's grant (scopes)", group: "operate" },
  context: { summary: "Show what the user is currently viewing", group: "operate" },
  tasks: { summary: "Poll/claim/progress/complete the app→agent task queue", group: "operate" },
  events: { summary: "Poll the app's event log", group: "operate" },
};

function usage(): void {
  log.raw(`a2app v${VERSION} — build, evolve, and operate Agent Apps\n`);
  for (const group of ["build/evolve", "operate"]) {
    log.raw(`  ${group}:`);
    for (const [cmd, meta] of Object.entries(COMMANDS)) {
      if (meta.group === group) log.raw(`    a2app ${cmd.padEnd(13)} ${meta.summary}`);
    }
    log.raw("");
  }
}

async function main(): Promise<number> {
  const [, , name, ...args] = process.argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    usage();
    return 0;
  }
  if (name === "version" || name === "--version" || name === "-v") {
    log.raw(JSON.stringify({ a2app: VERSION, protocol: "0.1" }));
    return 0;
  }
  if (!(name in COMMANDS)) {
    log.error(`Unknown command: ${name}`);
    log.raw("Try: a2app help");
    return 2;
  }
  const mod = (await import(`./commands/${name}.js`)) as { run: (args: string[]) => Promise<number> };
  return mod.run(args);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof UsageError || err instanceof ValuelessFlagError) {
      log.error(err.message);
      process.exitCode = 2;
    } else if (err instanceof A2AppUnreachableError) {
      log.error(err.message);
      process.exitCode = 3;
    } else {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
);
