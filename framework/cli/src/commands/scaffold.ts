/**
 * agent-app <dir> scaffold [--blueprint <id|path>] [--name "..."] [--port N]
 *
 * Scaffold a new Agent App: vendor the blueprint, assign a fresh identity, stamp
 * versions, write the ownership canon, and provision the agent credential.
 * Credentials are runtime artifacts — never copied from a blueprint.
 *
 * `<dir>` is the app being created, so it is the target here rather than an
 * existing app — same first-positional slot as every other command (spec 5.1).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeSystemHashes } from "../lib/canon.js";
import { flag, hasFlag } from "../lib/args.js";
import { mintAgentToken, stripCredentials } from "../lib/credential.js";
import { writeFileAtomic } from "../lib/home.js";
import { linkLocalPackages } from "../lib/localPackages.js";
import { AGENT_APP_VERSION } from "../lib/manifest.js";
import { UsageError } from "../lib/project.js";
import { adapterVersionOf, recordProjectToolkit, resolveToolkit, vendorPaths, type ResolvedToolkit } from "../lib/toolkit.js";
import { reserveApp, unregister } from "../lib/registry.js";
import { log } from "../lib/log.js";
import { readJsonFile } from "../lib/json.js";

/** Files whose presence does NOT make a directory "populated" for scaffolding. */
const IGNORABLE_ENTRIES = new Set([".git", ".gitignore", ".DS_Store", "Thumbs.db", ".hg", ".svn"]);

export async function run(args: string[], app: string): Promise<number> {
  const dir = resolve(app);

  // Validate --port up front: a mistyped port must be a usage error (exit 2),
  // never a NaN/garbage value persisted into the manifest and registry.
  const requested = flag(args, "port");
  let preferred: number | undefined;
  if (requested !== undefined) {
    const n = Number(requested);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new UsageError(`--port must be an integer between 1 and 65535 (got "${requested}")`);
    }
    preferred = n;
  }

  if (existsSync(join(dir, "manifest.json"))) {
    log.error(`${dir} already contains an Agent App (manifest.json present)`);
    return 1;
  }

  // Refuse to scatter a blueprint over a populated directory (a mistyped path,
  // an existing project, $HOME): only an empty dir, or an explicit --force.
  const force = hasFlag(args, "force");
  const dirExisted = existsSync(dir);
  if (dirExisted && !force) {
    const occupants = readdirSync(dir).filter((n) => !IGNORABLE_ENTRIES.has(n));
    if (occupants.length > 0) {
      throw new UsageError(
        `${dir} is not empty (${occupants.length} entr${occupants.length === 1 ? "y" : "ies"}). ` +
          `Scaffold into an empty directory, or pass --force to write into this one.`,
      );
    }
  }

  const name = flag(args, "name") ?? basename(dir);
  const blueprintId = flag(args, "blueprint");

  mkdirSync(dir, { recursive: true });

  // From here on, unwind on failure: a partial scaffold must not leak a registry
  // entry / claimed port, nor leave a half-written app that reads as "present".
  let reserved = false;
  try {
    let tk: ResolvedToolkit | null = null;
    let systemPaths: string[] = ["manifest.json"];
    let adapterVersion = "0.1.0";

    if (blueprintId !== undefined) {
      try {
        tk = resolveToolkit(blueprintId);
      } catch (err) {
        // An unknown blueprint is a usage mistake (exit 2), not a rejection.
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
      vendorPaths(tk, dir, allTemplateFiles(tk));
      ensureIgnoreRules(dir, tk.manifest.lifecycle?.dataDir);
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
      ? (readJsonFile(manifestPath) as Record<string, unknown>)
      : {};
    manifest.id = randomBytes(6).toString("hex");
    manifest.name = name;
    manifest.agentAppVersion = AGENT_APP_VERSION;
    manifest.adapterVersion = adapterVersion;
    if (manifest.authMode === undefined) manifest.authMode = "none";
    // Every app needs at least one module before it can declare an entity, so a
    // blueprint that ships none gets a single starter to rename. Seeding it here
    // rather than leaving the key absent means a freshly scaffolded app serves a
    // valid root screen immediately, instead of failing its own gate on step one.
    if (manifest.modules === undefined) {
      manifest.modules = [{ name: "core", summary: `${name} — rename this module as the app takes shape` }];
    }
    // Assign a port no registered app claims and nothing is listening on, so two
    // apps are never mutually unreachable to their own tooling (section 5.6).
    // Pick AND claim in one locked step; an explicit --port is honoured when free.
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
    reserved = true;
    if (preferred !== undefined && assigned !== preferred) {
      log.warn(`port ${preferred} is already taken — assigned ${assigned} instead`);
    }
    manifest.port = assigned;
    if (manifest.pipeline === undefined) {
      manifest.pipeline = { install: "", build: "", start: "", health: "/api/health" };
    }
    // Atomic write: the manifest's presence is what makes this "an Agent App",
    // so a crash mid-write must never leave a truncated, unparseable one.
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    // Point any dependency on an unpublished package from the toolkit's own
    // repository at that source tree. Without this, an app scaffolded outside
    // the repo fails `npm install` — and so fails its build gate — before its
    // author has touched it. A no-op when the blueprint ships without a source
    // tree beside it, which is the published-CLI case.
    if (tk !== null) {
      const linked = linkLocalPackages(dir, tk.source);
      for (const dep of linked) {
        log.step(`linked ${dep.name} ${dep.from} -> ${dep.to} (not published; resolved from the toolkit's repo)`);
      }
    }

    // Strip any credential that slipped in from a template, then mint a fresh one.
    stripCredentials(dir);
    mintAgentToken(dir);

    writeHarnessGuides(dir, name);

    writeSystemHashes(dir, systemPaths);

    log.ok(`Created Agent App "${name}" (id ${manifest.id as string}) at ${dir}`);
    log.raw(JSON.stringify({ ok: true, id: manifest.id, dir, port: assigned, adapterVersion }, null, 2));
    return 0;
  } catch (err) {
    // Roll back the port/registry claim, and remove the directory only if this
    // command created it (never delete a directory the user already had).
    if (reserved) {
      try {
        await unregister(dir);
      } catch {
        /* best effort */
      }
    }
    if (!dirExisted) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
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
        "agent-app . serve                       # launch (never start a server by hand)",
        "a2app .                                 # the app's modules — start here",
        "a2app . <module>                        # its entities and operations",
        "a2app . <module> <entity>               # fields, and the operations that act on it",
        "a2app . <module> <entity> <id>          # one record, and what its state allows",
        "a2app . <module> <entity> <id> <op> …   # invoke, at the path that identifies it",
        "a2app . --find <term>                   # search names, get locations",
        "a2app . data <entity> list|create|…     # raw record access",
        "```",
        "",
        "The CLI is a walk: each argument names a place in the app, and every screen",
        "ends by naming the legal next moves — read that line, you never have to guess.",
        "",
        "Read and write through the adapter only. Never drive the UI to operate this app;",
        "the UI is for humans and for walk-verify.",
        "",
        "## Change its code",
        "",
        "```bash",
        "agent-app . dev          # dev copy, fresh migration-replayed database",
        "agent-app . validate     # the gate — must pass",
        "# walk-verify: a verifier agent that is NOT the builder loads the walk-verify",
        "# skill and drives every reference/requirements.md Feature in a browser.",
        "agent-app . promote      # mandatory pre-promote backup, then apply to live",
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

/** Every file under the toolkit template — the scaffold copies the whole app, not
 *  only the system paths (which is what toolkit-sync re-vendors later). */
function allTemplateFiles(_tk: ResolvedToolkit): string[] {
  // vendorPaths copies directories recursively; "." copies the whole template.
  return ["."];
}

/**
 * Guarantee the ignore rules that keep runtime artifacts out of a repository.
 *
 * Blueprints ship their own `.gitignore`, but npm strips dotfiles named
 * `.gitignore` out of a published tarball, so a CLI installed with `npm i -g`
 * scaffolds an app carrying none at all — and the next `git add -A` publishes
 * the agent token, the principal password and the live database. The rules the
 * framework depends on are therefore written here, from the CLI, on every path.
 *
 * Existing lines are kept and only missing ones appended: a blueprint's own
 * rules (node_modules, the PocketBase binary, __pycache__) are none of the
 * framework's business, and re-running must not churn the file.
 */
function ensureIgnoreRules(dir: string, dataDir?: string): void {
  const rules = [
    ".agent-token",
    ".principal",
    ".superuser",
    ".a2app/serve.json",
    ".a2app/serve.log",
    ".a2app/dev/",
    ".a2app/backups/",
  ];
  // The database lives wherever the toolkit says it does, so the rule follows
  // the declaration rather than assuming "data/".
  if (dataDir !== undefined && dataDir.trim() !== "") {
    rules.push(dataDir.trim().replace(/[\/]+$/, "") + "/");
  }
  const file = join(dir, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = rules.filter((rule) => !present.has(rule));
  if (missing.length === 0) return;
  const header = [
    "# Written by agent-app: credentials, framework state and the live database",
    "# are runtime artifacts and must never be committed.",
  ];
  const prefix = existing.trim() === "" ? "" : existing.replace(/\s*$/, "") + "\n\n";
  writeFileSync(file, prefix + [...header, ...missing, ""].join("\n"));
}

/** A stack-free skeleton: just the framework files, so `scaffold` without a
 *  blueprint still yields a conforming artifact shell an agent then fills in. */
function scaffoldMinimal(dir: string, name: string): void {
  mkdirSync(join(dir, "reference"), { recursive: true });
  ensureIgnoreRules(dir);
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
      "## Modules",
      "Each module: what it covers, which entities sit in it. Decide these FIRST —",
      "an entity cannot be declared until there is a module to hold it, and the root",
      "screen of describe lists them.",
      "- core — (rename me) this app's first area",
      "",
      "## Entities",
      "Each entity: its module, purpose, key fields.",
      "",
      "## Operations",
      "Each declared operation: its module, the entity it acts on, what it does, destructive?",
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
      "## Modules",
      "How the app divides: one line per module, its scope.",
      "- core — (rename me) this app's first area",
      "",
      "## Data",
      "Entities and the fields each must hold, each under a module.",
      "",
      "## Design",
      "Layout, theme, any visual requirements.",
      "",
      "## Operations",
      "What the agent must be able to do on the user's behalf, each under a module.",
      "",
      "## Quality of life",
      "Nice-to-haves, explicitly non-binding.",
      "",
    ].join("\n"),
  );
}
