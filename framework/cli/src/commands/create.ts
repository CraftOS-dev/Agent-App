/**
 * agent-app create <dir> [--blueprint <id|path>] [--name "..."] [--port N]
 *
 * Scaffold a new Agent App: vendor the blueprint, assign a fresh identity, stamp
 * versions, write the ownership canon, and provision the agent credential.
 * Credentials are runtime artifacts — never copied from a blueprint.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeSystemHashes } from "../lib/canon.js";
import { flag } from "../lib/args.js";
import { UsageError } from "../lib/project.js";
import { adapterVersionOf, recordProjectToolkit, resolveToolkit, vendorPaths, type ResolvedToolkit } from "../lib/toolkit.js";
import { reserveApp } from "../lib/registry.js";
import { log } from "../lib/log.js";

const AGENT_APP_VERSION = "0.1.0";

export async function run(args: string[]): Promise<number> {
  const dirArg = args.find((a) => !a.startsWith("--"));
  if (dirArg === undefined) {
    throw new UsageError("Usage: agent-app create <dir> [--blueprint <id|path>] [--name \"...\"] [--port N]");
  }
  const dir = resolve(dirArg);
  if (existsSync(join(dir, "manifest.json"))) {
    log.error(`${dir} already contains an Agent App (manifest.json present)`);
    return 1;
  }
  const name = flag(args, "name") ?? basename(dir);
  const blueprintId = flag(args, "blueprint");

  mkdirSync(dir, { recursive: true });

  let tk: ResolvedToolkit | null = null;
  let systemPaths: string[] = ["manifest.json"];
  let adapterVersion = "0.1.0";

  if (blueprintId !== undefined) {
    tk = resolveToolkit(blueprintId);
    vendorPaths(tk, dir, allTemplateFiles(tk));
    recordProjectToolkit(dir, tk);
    systemPaths = tk.manifest.systemPaths;
    adapterVersion = adapterVersionOf(tk);
    log.step(`scaffolded from blueprint "${tk.manifest.id}"`);
  } else {
    scaffoldMinimal(dir, name);
    log.step("scaffolded a minimal Agent App skeleton (no blueprint)");
  }

  // Fresh identity + stamped versions, merged over the blueprint's manifest.
  const manifestPath = join(dir, "manifest.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>)
    : {};
  manifest.id = randomBytes(4).toString("hex");
  manifest.name = name;
  manifest.agentAppVersion = AGENT_APP_VERSION;
  manifest.adapterVersion = adapterVersion;
  if (manifest.authMode === undefined) manifest.authMode = "none";
  // Assign a port no registered app claims and nothing is listening on, so two
  // apps are never mutually unreachable to their own tooling (section 5.6).
  // An explicit --port is honoured when free, and reported when it is not.
  const requested = flag(args, "port");
  const preferred = requested !== undefined ? Number(requested) : (manifest.port as number | undefined);
  // Pick AND claim the port in one locked step, then record the app. Splitting
  // choose-then-claim lets a concurrent `create` pick the same port.
  const assigned = await reserveApp(
    {
      id: manifest.id as string,
      name,
      path: dir,
      ...(tk ? { blueprint: tk.manifest.id } : {}),
      createdAt: new Date().toISOString(),
    },
    preferred,
  );
  if (requested !== undefined && assigned !== Number(requested)) {
    log.warn(`port ${requested} is already taken — assigned ${assigned} instead`);
  }
  manifest.port = assigned;
  if (manifest.pipeline === undefined) {
    manifest.pipeline = { install: "", build: "", start: "", health: "/api/health" };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // Strip any credential that slipped in from a template, then mint a fresh one.
  for (const cred of [".agent-token", ".principal", ".superuser"]) {
    const p = join(dir, cred);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  writeFileSync(join(dir, ".agent-token"), "a2app_" + randomBytes(24).toString("hex") + "\n", { mode: 0o600 });

  writeHarnessGuides(dir, name);

  writeSystemHashes(dir, systemPaths);

  log.ok(`Created Agent App "${name}" (id ${manifest.id as string}) at ${dir}`);
  log.raw(JSON.stringify({ ok: true, id: manifest.id, dir, port: assigned, adapterVersion }, null, 2));
  return 0;
}

/**
 * Harness-facing pointer files: `AGENTS.md` (the common convention) and a
 * `CLAUDE.md` that defers to it.
 *
 * These are NOT framework files — an app is conforming without them, and they
 * are agent-accessible, never canonized. They exist because discovery is the
 * framework's weakest link: an agent dropped into an app directory by a harness
 * with no plugin has no way to learn that `agent-app` builds and launches this app and
 * `a2app` operates it. The scaffolded app tells it.
 *
 * A blueprint that ships its own guidance wins: an existing file is never
 * overwritten.
 */
function writeHarnessGuides(dir: string, name: string): void {
  const agents = join(dir, "AGENTS.md");
  if (!existsSync(agents)) {
    writeFileSync(
      agents,
      [
        `# ${name} — agent guide`,
        "",
        "This is an **Agent App**: app code plus an A2App adapter plus framework files.",
        "It is built, launched, and operated through two CLIs — never by hand:",
        "",
        "- `agent-app` — build, evolve, manage.",
        "- `a2app` — operate a running app (the A2App protocol client; operate only).",
        "",
        "## Read first",
        "",
        "- `AGENT_APP.md` — this app's index: plan, entities, operations, conventions, checklist.",
        "- `reference/requirements.md` — the binding spec of what this app must do.",
        "",
        "Load the matching framework skill before build or evolve work:",
        "`agent-app skills` lists them; `agent-app skills --install <dir>` installs them here.",
        "",
        "## Operate it (no rebuild)",
        "",
        "```bash",
        "agent-app serve .        # launch (never start a server by hand)",
        "a2app data . schema      # the data model",
        "a2app ops .              # declared operations",
        "a2app run . <op> ...     # invoke one (destructive ops need approval)",
        "```",
        "",
        "Read and write through the adapter only. Never drive the UI to operate this app;",
        "the UI is for humans and for walk-verify.",
        "",
        "## Change its code",
        "",
        "```bash",
        "agent-app dev .          # dev copy, fresh migration-replayed database",
        "agent-app validate .     # the gate — must pass",
        "agent-app walk-verify .  # verified by an agent that is NOT the builder",
        "agent-app promote .      # mandatory pre-promote backup, then apply to live",
        "```",
        "",
        "Never build against the live app, never edit an applied migration, never drop a",
        "collection holding user data, and never write a system-owned file listed in",
        "`.a2app/system-hashes.json` — the gate fails on drift.",
        "",
      ].join("\n"),
    );
  }
  const claude = join(dir, "CLAUDE.md");
  if (!existsSync(claude)) {
    writeFileSync(claude, `See [AGENTS.md](AGENTS.md) — it applies in full.\n`);
  }
}

/** Every file under the toolkit template — the create copies the whole app, not
 *  only the system paths (which is what toolkit-sync re-vendors later). */
function allTemplateFiles(_tk: ResolvedToolkit): string[] {
  // vendorPaths copies directories recursively; "." copies the whole template.
  return ["."];
}

/** A stack-free skeleton: just the framework files, so `create` without a
 *  blueprint still yields a conforming artifact shell an agent then fills in. */
function scaffoldMinimal(dir: string, name: string): void {
  mkdirSync(join(dir, "reference"), { recursive: true });
  writeFileSync(
    join(dir, "operations.json"),
    JSON.stringify({ operations: [] }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "AGENT_APP.md"),
    [
      `# ${name}`,
      "",
      "## Plan",
      "One paragraph describing what this app is. (Fill me in.)",
      "",
      "## Entities",
      "Each entity: purpose, key fields.",
      "",
      "## Operations",
      "Each declared operation: what it does, destructive?",
      "",
      "## Conventions",
      "App-specific rules an operating agent must follow.",
      "",
      "## Checklist",
      "- [ ] first feature",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "reference", "requirements.md"),
    [
      `# Requirements: ${name}`,
      "",
      "## Overview",
      "What the app is for, who uses it.",
      "",
      "## Features",
      '- The user can … (each feature a checkable capability — walk-verify drives them).',
      "",
      "## Data",
      "Entities and the fields each must hold.",
      "",
      "## Design",
      "Layout, theme, any visual requirements.",
      "",
      "## Operations",
      "What the agent must be able to do on the user's behalf.",
      "",
      "## Quality of life",
      "Nice-to-haves, explicitly non-binding.",
      "",
    ].join("\n"),
  );
}
