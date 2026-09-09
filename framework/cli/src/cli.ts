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
import { EnvError, UsageError } from "./lib/project.js";
import { ValuelessFlagError } from "./lib/args.js";
import { log } from "./lib/log.js";

export const VERSION = "0.1.0";

/** Which binary owns a command. */
export type Surface = "agent-app" | "a2app";

/**
 * Whether a command addresses ONE app or the machine's set of apps.
 *
 * "app" commands take the app as their first positional (spec 5.1); "registry"
 * commands take no app and stand alone. The set of registry commands is closed —
 * a command that acts on an app is never added to it, because that is what lets
 * the parser treat the first positional as an app unconditionally.
 */
export type Scope = "app" | "registry";

interface CommandMeta {
  summary: string;
  surface: Surface;
  scope: Scope;
  /** Verb arguments shown in usage, after `<binary> <app> <verb>`. */
  args?: string;
}

const COMMANDS: Record<string, CommandMeta> = {
  // agent-app — the framework: build, evolve, and manage Agent Apps.
  scaffold: { summary: "Scaffold a new Agent App (framework files + ownership canon)", surface: "agent-app", scope: "app" },
  import: { summary: "Import an existing app: fresh identity + port, strip credentials, re-vendor from a trusted toolkit", surface: "agent-app", scope: "app" },
  validate: { summary: "Run the validation + security gate", surface: "agent-app", scope: "app" },
  "toolkit-sync": { summary: "Re-vendor system files and re-record the ownership canon", surface: "agent-app", scope: "app" },
  "adapter-sync": { summary: "Deliver/update the A2App adapter (no rebuild)", surface: "agent-app", scope: "app" },
  serve: { summary: "Launch the app via its manifest pipeline as a managed background process (health-polled)", surface: "agent-app", scope: "app" },
  stop: { summary: "Stop an app launched with `agent-app <app> serve`", surface: "agent-app", scope: "app" },
  open: { summary: "Open a running app in a browser (harness opener, else the OS browser; always prints the URL)", surface: "agent-app", scope: "app" },
  dev: { summary: "Prepare a fresh, migration-replayed dev database (no server is started)", surface: "agent-app", scope: "app" },
  promote: { summary: "Pre-promote backup, then apply the dev copy's migrations to live", surface: "agent-app", scope: "app" },
  backup: { summary: "Take an explicit backup of the live database", surface: "agent-app", scope: "app" },
  restore: { summary: "Restore a backup (captures current state, rolls back on failure)", surface: "agent-app", scope: "app", args: "[<backup-id>]" },
  // agent-app registry commands: the machine's set of apps, not one app.
  list: { summary: "List every known Agent App with its port and derived status", surface: "agent-app", scope: "registry" },
  global: { summary: "Show the cross-app conventions (GLOBAL_AGENT_APP.md), seeding it on first use", surface: "agent-app", scope: "registry" },
  skills: { summary: "List the framework skills, or install them into a harness (--install <dir>)", surface: "agent-app", scope: "registry" },
  // a2app — the A2App protocol client. Operate only; never a build command.
  identity: { summary: "Probe the app's identity document", surface: "a2app", scope: "app" },
  data: { summary: "Read/write records; `<app> data schema` lists entities", surface: "a2app", scope: "app", args: "<entity> <verb>" },
  whoami: { summary: "Show the calling credential's grant (scopes)", surface: "a2app", scope: "app" },
  context: { summary: "Show what the user is currently viewing", surface: "a2app", scope: "app" },
  tasks: { summary: "Poll/claim/progress/complete the app→agent task queue", surface: "a2app", scope: "app" },
  events: { summary: "Poll the app's event log", surface: "a2app", scope: "app" },
};

/**
 * The first path segments `a2app` keeps for the protocol surface. Everything
 * else in that position is a module name, which is why these six are forbidden
 * as module names (framework spec 5.1) — a module called `data` would be
 * permanently unreachable, and the build gate rejects one.
 *
 * Kept in lockstep with `RESERVED_PATH_SEGMENTS` in `@a2app/rules`, which the
 * gate checks against; this copy exists so the dispatcher does not have to load
 * the rules package to route a command.
 */
const RESERVED_SEGMENTS = new Set(["data", "identity", "whoami", "context", "tasks", "events"]);

function isReservedSegment(segment: string): boolean {
  return RESERVED_SEGMENTS.has(segment);
}

const TAGLINE: Record<Surface, string> = {
  "agent-app": "build, evolve, and manage Agent Apps",
  a2app: "operate a running Agent App (the A2App protocol client)",
};

/** How a command is written, for usage and error messages (spec 5.1). */
function shape(surface: Surface, cmd: string, meta: CommandMeta): string {
  const target = surface === "a2app" ? "<app>" : "<dir>";
  return meta.scope === "registry"
    ? `${surface} ${cmd}`
    : `${surface} ${target} ${cmd}${meta.args ? ` ${meta.args}` : ""}`;
}

function usage(surface: Surface): void {
  const other: Surface = surface === "agent-app" ? "a2app" : "agent-app";
  const target = surface === "a2app" ? "<app>" : "<dir>";
  log.raw(`${surface} v${VERSION} — ${TAGLINE[surface]}\n`);
  if (surface === "a2app") {
    // The walk is the surface; the reserved verbs are the exception to it. Show
    // the walk first, because an agent that reads only the first lines should
    // learn to navigate rather than learn a verb table.
    log.raw(`  Usage: ${surface} ${target} [<path…>] [<operation>] [--flags]   (the app comes first)\n`);
    log.raw(`  ${target}                        the app's root screen: its modules`);
    log.raw(`  ${target} <module>               a module's entities and operations`);
    log.raw(`  ${target} <module> <entity>      one entity's fields and operations`);
    log.raw(`  ${target} <module> <entity> <id> one record, and what it allows now`);
    log.raw(`  ${target} … <operation> [--…]    invoke, at the path that identifies it`);
    log.raw(`  ${target} --find <term>          search names, get locations\n`);
    log.raw(`  Every screen ends by naming the legal next moves.\n`);
    log.raw(`  Reserved (never module names):`);
  } else {
    log.raw(`  Usage: ${surface} ${target} <verb> [args] [--flags]   (the app comes first)\n`);
  }
  const mine = Object.entries(COMMANDS).filter(([, m]) => m.surface === surface);
  for (const [cmd, meta] of mine.filter(([, m]) => m.scope === "app")) {
    log.raw(`  ${target} ${cmd.padEnd(13)} ${meta.summary}`);
  }
  const registry = mine.filter(([, m]) => m.scope === "registry");
  if (registry.length > 0) {
    log.raw(`\n  Across all apps (no app argument):`);
    for (const [cmd, meta] of registry) log.raw(`  ${" ".repeat(target.length)} ${cmd.padEnd(13)} ${meta.summary}`);
  }
  log.raw(`\n  To ${TAGLINE[other]}: ${other} help`);
}

/**
 * Parse `<binary> <app> <verb> [args]` (spec 5.1).
 *
 * The first positional is the app, unconditionally — it is never inspected to
 * decide whether it "looks like" a command, so an app directory named `./data`
 * or `./serve` parses correctly. The only commands read from position one are
 * the closed set of registry commands, which take no app at all.
 */
export async function main(surface: Surface): Promise<number> {
  const [, , first, ...rest] = process.argv;
  if (!first || first === "help" || first === "--help" || first === "-h") {
    usage(surface);
    return 0;
  }
  if (first === "version" || first === "--version" || first === "-v") {
    log.raw(JSON.stringify({ [surface]: VERSION, protocol: "0.1" }));
    return 0;
  }

  // Position one is a verb ONLY for registry commands.
  const asRegistry = COMMANDS[first];
  if (asRegistry?.scope === "registry") {
    if (asRegistry.surface !== surface) return wrongBinary(surface, first, asRegistry, rest);
    const mod = (await import(`./commands/${first}.js`)) as { run: (args: string[]) => Promise<number> };
    return mod.run(rest);
  }

  if (first.startsWith("-")) {
    log.error(`Unknown option: ${first}`);
    log.raw(`Usage: ${surface} <app> <verb> [args]  —  the app comes first. Try: ${surface} help`);
    return 2;
  }

  // Everything else: `<app> <verb> [args]`.
  const app = first;
  const name = rest[0];

  // `a2app` is a walk, not a verb table (A2APP-SPEC 4.1). Its first path segment
  // is a module unless it is one of the reserved protocol segments, and a bare
  // app is the root screen rather than a usage error — arriving at an app is the
  // first thing an agent does, and it must land somewhere.
  if (surface === "a2app" && (name === undefined || !isReservedSegment(name))) {
    const walk = (await import("./commands/walk.js")) as { run: (args: string[], app: string) => Promise<number> };
    return walk.run(rest, app);
  }

  if (name === undefined) {
    log.error(`No command given for "${app}".`);
    log.raw(`Usage: ${surface} ${app} <verb> [args]  —  try: ${surface} help`);
    return 2;
  }
  const meta = COMMANDS[name];
  if (meta === undefined) {
    // A verb-first invocation (`agent-app scaffold ./app`) lands here: position
    // one held a verb name and position two the app. Name the mistake and show
    // the correct line — but still reject it. Accepting both orders would mean
    // inspecting position one to guess, which is exactly what spec 5.1 forbids.
    const misplaced = COMMANDS[app];
    if (misplaced !== undefined && misplaced.scope === "app") {
      log.error(`The app comes first: \`${app}\` is a verb, not an app.`);
      log.raw(`Run: ${misplaced.surface} ${name} ${app} ${rest.slice(1).join(" ")}`.trimEnd());
      return 2;
    }
    log.error(`Unknown command: ${name}`);
    log.raw(`Try: ${surface} help`);
    return 2;
  }
  if (meta.scope === "registry") {
    // A registry command addresses every app, so it never takes one.
    log.error(`\`${name}\` acts across all apps and takes no app argument.`);
    log.raw(`Run: ${meta.surface} ${name}`);
    return 2;
  }
  // Right command, wrong binary: name the one that has it. Guessing on the
  // caller's behalf would hide the split instead of teaching it.
  if (meta.surface !== surface) return wrongBinary(surface, name, meta, rest.slice(1), app);

  const mod = (await import(`./commands/${name}.js`)) as {
    run: (args: string[], app: string) => Promise<number>;
  };
  return mod.run(rest.slice(1), app);
}

/** The command exists, on the other binary. Teach the split at the point of the
 *  mistake rather than reporting "unknown command". */
function wrongBinary(surface: Surface, name: string, meta: CommandMeta, args: string[], app?: string): number {
  log.error(`\`${name}\` is an ${meta.surface} command, not ${surface}.`);
  const target = app !== undefined ? `${app} ` : "";
  log.raw(`Run: ${meta.surface} ${target}${name} ${args.join(" ")}`.trimEnd());
  return 2;
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
      } else if (err instanceof EnvError) {
        // Environment fault, not a gate rejection: framed and actionable.
        log.error(err.message);
        process.exitCode = 1;
      } else {
        log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    },
  );
}
