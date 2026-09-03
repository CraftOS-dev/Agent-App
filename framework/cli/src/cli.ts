#!/usr/bin/env node
/**
 * The framework's two CLIs, one dispatcher.
 *
 * Spec section 5.1 splits the command set across two binaries, on scope:
 *
 *   agent-app   build / evolve / manage — the framework. Needs the app's files.
 *   a2app       operate — the A2App protocol client, and nothing more.
 *
 * The split exists because A2App is operate-only: the binary carrying the
 * protocol's name must carry exactly the protocol, so that a third party
 * implementing A2App ships that client and is not led to believe conformance
 * requires `scaffold` or `promote`. Both are machine-first (the split is
 * framework-vs-protocol, NOT human-vs-agent) and share one exit-code contract:
 *   0 success · 1 rejected (gate/guard) · 2 usage error · 3 app unreachable.
 * On success the machine-readable result is on stdout; diagnostics go to stderr.
 *
 * Each binary knows the other's commands and redirects by name, so the one fact
 * this split adds is taught at the moment it is needed rather than surfacing as
 * "Unknown command".
 */
import { A2AppUnreachableError } from "@a2app/sdk";
import { UsageError } from "./lib/project.js";
import { ValuelessFlagError } from "./lib/args.js";
import { log } from "./lib/log.js";

export const VERSION = "0.1.0";

/** Which binary owns a command. */
export type Surface = "agent-app" | "a2app";

interface CommandMeta {
  summary: string;
  surface: Surface;
}

const COMMANDS: Record<string, CommandMeta> = {
  // agent-app — the framework: build, evolve, and manage Agent Apps.
  scaffold: { summary: "Scaffold a new Agent App (framework files + ownership canon)", surface: "agent-app" },
  validate: { summary: "Run the validation + security gate", surface: "agent-app" },
  "toolkit-sync": { summary: "Re-vendor system files and re-record the ownership canon", surface: "agent-app" },
  "adapter-sync": { summary: "Deliver/update the A2App adapter (no rebuild)", surface: "agent-app" },
  serve: { summary: "Launch the app via its manifest pipeline as a managed background process (health-polled)", surface: "agent-app" },
  stop: { summary: "Stop an app launched with `agent-app serve`", surface: "agent-app" },
  list: { summary: "List every known Agent App with its port and derived status", surface: "agent-app" },
  global: { summary: "Show the cross-app conventions (GLOBAL_AGENT_APP.md), seeding it on first use", surface: "agent-app" },
  skills: { summary: "List the framework skills, or install them into a harness (--install <dir>)", surface: "agent-app" },
  dev: { summary: "Boot a dev copy on a hidden port with a fresh, migration-replayed database", surface: "agent-app" },
  promote: { summary: "Pre-promote backup, then apply the dev copy's migrations to live", surface: "agent-app" },
  backup: { summary: "Take an explicit backup of the live database", surface: "agent-app" },
  restore: { summary: "Restore a backup (captures current state, rolls back on failure)", surface: "agent-app" },
  "walk-verify": { summary: "Verify a running app against reference/requirements.md", surface: "agent-app" },
  // a2app — the A2App protocol client. Operate only; never a build command.
  identity: { summary: "Probe the app's identity document", surface: "a2app" },
  data: { summary: "Read/write records; `data <app> schema` shows the data model", surface: "a2app" },
  ops: { summary: "List the app's declared operations", surface: "a2app" },
  run: { summary: "Invoke a declared operation (destructive ops need approval)", surface: "a2app" },
  whoami: { summary: "Show the calling credential's grant (scopes)", surface: "a2app" },
  context: { summary: "Show what the user is currently viewing", surface: "a2app" },
  tasks: { summary: "Poll/claim/progress/complete the app→agent task queue", surface: "a2app" },
  events: { summary: "Poll the app's event log", surface: "a2app" },
};

const TAGLINE: Record<Surface, string> = {
  "agent-app": "build, evolve, and manage Agent Apps",
  a2app: "operate a running Agent App (the A2App protocol client)",
};

function usage(surface: Surface): void {
  const other: Surface = surface === "agent-app" ? "a2app" : "agent-app";
  log.raw(`${surface} v${VERSION} — ${TAGLINE[surface]}\n`);
  for (const [cmd, meta] of Object.entries(COMMANDS)) {
    if (meta.surface === surface) log.raw(`  ${surface} ${cmd.padEnd(13)} ${meta.summary}`);
  }
  log.raw(`\n  To ${TAGLINE[other]}: ${other} help`);
}

export async function main(surface: Surface): Promise<number> {
  const [, , name, ...args] = process.argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    usage(surface);
    return 0;
  }
  if (name === "version" || name === "--version" || name === "-v") {
    log.raw(JSON.stringify({ [surface]: VERSION, protocol: "0.1" }));
    return 0;
  }
  const meta = COMMANDS[name];
  if (meta === undefined) {
    log.error(`Unknown command: ${name}`);
    log.raw(`Try: ${surface} help`);
    return 2;
  }
  // Right command, wrong binary: name the one that has it. Guessing on the
  // caller's behalf would hide the split instead of teaching it.
  if (meta.surface !== surface) {
    log.error(`\`${name}\` is an ${meta.surface} command, not ${surface}.`);
    log.raw(`Run: ${meta.surface} ${name} ${args.join(" ")}`.trimEnd());
    return 2;
  }
  const mod = (await import(`./commands/${name}.js`)) as { run: (args: string[]) => Promise<number> };
  return mod.run(args);
}

/** Run a binary's dispatcher and apply the shared exit-code contract. */
export function dispatch(surface: Surface): void {
  main(surface).then(
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
}
