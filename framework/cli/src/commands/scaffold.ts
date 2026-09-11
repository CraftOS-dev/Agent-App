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
      "Build and evolve tasks live in `reference/tasks.md` — one home. This section points there.",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "reference", "requirements.md"), requirementsTemplate(name));
  writeFileSync(join(dir, "reference", "tasks.md"), tasksTemplate(name));
}

/** The requirements template. Every slot is a `<REPLACE: …>` marker whose text
 *  IS the fill instruction; the gate refuses a spec that still carries one, so
 *  template text can never reach verification or the user. */
export function requirementsTemplate(name: string): string {
  return [
    `# Requirements: ${name}`,
    "",
    "PART A — REQUIREMENTS (SRS). User-approved before build; frozen after; changes via ## Changes.",
    "",
    "## Introduction",
    "",
    "### Purpose",
    "<REPLACE: one paragraph — kind of app, its one job, who it is for, agent operates same data via A2App>",
    "",
    "### Scope",
    "**Goals**",
    "1. <REPLACE: 2–5 numbered falsifiable outcomes>",
    "",
    "**Core functionalities:** <REPLACE: capability nouns separated by ·>",
    "",
    "### Approval",
    "Approved by the user: <REPLACE: date — written only when the user actually approved Part A>",
    "",
    "## Product Description",
    "",
    "### Product Perspective",
    "<REPLACE: authMode and why; integrations or none; what this app deliberately is not built on>",
    "",
    "### User Characteristics",
    "<REPLACE: who, which devices, how often — every device named here must have Q8/Q9 decisions>",
    "",
    "### Constraints",
    "- C-1: <REPLACE: binding business rules, one C-n each — currency+format, immutability, numbering, complete fixed vocabularies>",
    "",
    "### Assumptions",
    "- A-1: Volume ceiling: <REPLACE: a number — performance is judged at it>",
    "",
    "## Features",
    "",
    "### Module: <REPLACE: module name from manifest.json>",
    "- F-<REPLACE: MOD>-1: <REPLACE: binary observable statements — \"The user can <verb>…\"; WHEN…SHALL for conditional; states the user must see are features too; one check per item, stable IDs, never renumbered>",
    "",
    "### Agent (via A2App)",
    "- F-AGT-1: <REPLACE: \"The agent can <verb>…\" — the agent's own capabilities>",
    "",
    "## Non-Functional Requirements",
    "- N-1: <REPLACE: app-specific measurable bars only — quality decisions go in ## Quality Conformance>",
    "",
    "## Data Requirements",
    "- **<REPLACE: entity>** (module: <REPLACE: module>): <REPLACE: every field — type, required, bounds, server-set — plus the deletion/retention rule>",
    "",
    "## External Interfaces",
    "- **Human (browser):** <REPLACE: each surface, per role when multi-user>",
    "- **Agent (A2App):** <REPLACE: modules, entities, \"operations exactly as declared in ## Operations Design\"; state no other machine interface exists or declare it>",
    "",
    "## Out of Scope",
    "- <REPLACE: exhaustive — what a reasonable builder would otherwise add; \"- None declared.\" almost never true>",
    "",
    "## Quality of Life",
    "- <REPLACE: non-binding niceties, or \"None.\">",
    "",
    "PART B — TECHNICAL SPECIFICATION. QUALITY.md read is mandatory before writing it. Evolves during build; never silently contradicts Part A.",
    "",
    "## System Overview",
    "<REPLACE: stack in one line; modules → navigation map>",
    "",
    "## UI Design",
    "- **Design system:** <REPLACE: token source + this app's extensions — extended, never forked>",
    "- **Layout:** <REPLACE: structure, max width, density>",
    "- **Screen — <REPLACE: name>:** <REPLACE: one entry per screen — primary object · primary action · five states · narrow-width behavior>",
    "- **Formatting:** <REPLACE: dates, money, identifiers, empty values>",
    "",
    "## Quality Conformance",
    "",
    "This app's decisions per Quality Standard section — never the rules restated. \"Standard defaults\" is not an answer for Q1–Q11. N/A only with reason. Breaking an item → ### Conventions and overrides.",
    "",
    "- **Q1 Completeness & IA:** <REPLACE: orientation model; one-name-per-concept; where search/filter/sort appears past a screenful>",
    "- **Q2 Design system:** <REPLACE: tokens + extensions; semantic colour roles used; icon source; schemes resolved>",
    "- **Q3 Layout & composition:** <REPLACE: alignment rule; density per region; numeric alignment, truncation, pagination point>",
    "- **Q4 Interaction:** <REPLACE: affordance-state source; each destructive action + what its confirmation names; undo vs confirm; keyboard map; constrained vs validated>",
    "- **Q5 State & feedback:** <REPLACE: per-screen state coverage; double-submit guard; ~100ms acknowledgment; how success reads back>",
    "- **Q6 Motion:** <REPLACE: durations/easing; which transitions; reduced-motion behavior>",
    "- **Q7 Content:** <REPLACE: voice in one line; error-copy pattern — what happened + next step; terminology>",
    "- **Q8 Accessibility:** <REPLACE: contrast source + app-added colours checked; focus flow per composite interaction; target sizes; assistive announcements>",
    "- **Q9 Responsiveness:** <REPLACE: width range per User Characteristics; each breakpoint + what changes; touch posture>",
    "- **Q10 Performance:** <REPLACE: how each screen holds A-1; what is bounded/virtualized; assets>",
    "- **Q11 Caching & freshness:** <REPLACE: static policy; data policy; in-flight dedupe; write invalidation>",
    "- **Q12 Data integrity:** <REPLACE: each invariant + the boundary enforcing it>",
    "- **Q13 API:** <REPLACE: app endpoints beyond the adapter + contract, or \"adapter surface only\">",
    "- **Q14 Architecture:** <REPLACE: where UI/logic/data live; shared widgets existing exactly once>",
    "- **Q15 Resilience:** <REPLACE: timeout values; retry policy; unreachable-backend behavior>",
    "- **Q16 Security & privacy:** <REPLACE: authMode posture; never-logged data; closed defaults>",
    "- **Q17 Observability:** <REPLACE: log schema + events; error-line contents; health meaning>",
    "- **Q18 Version control:** <REPLACE: commit-unit convention>",
    "",
    "### Conventions and overrides",
    "<REPLACE: overrides — item number + factual reason + revisit condition — and mirrored global rules, or \"None.\">",
    "",
    "## Process Flows",
    "<REPLACE: mermaid where a lifecycle exists, or \"None — reason\">",
    "",
    "## Operations Design",
    "| Operation | Module | Entity | appliesWhen | Params | Flags |",
    "| --- | --- | --- | --- | --- | --- |",
    "| <REPLACE: one row per operation, matching operations.json exactly> | | | | | |",
    "",
  ].join("\n");
}

/** The tasks template — same marker rule as the requirements template. */
export function tasksTemplate(name: string): string {
  return [
    `# Tasks: ${name}`,
    "",
    "Created only after ### Approval carries a real date. Every task cites what it",
    "implements; tick on completion; never delete or batch-tick; ## Changes work",
    "appends here citing the entry date.",
    "",
    "## Build",
    "- [ ] T-1 (<REPLACE: F-ID or Q-entry>): <REPLACE: the work, named so a stranger could verify it happened — quality work (motion, focus flow, narrow-width, resilience) gets tasks like features>",
    "",
    "## Verification",
    "- [ ] All build tasks ticked.",
    "- [ ] Quality Conformance sweep: every Q-entry true in the running app (Q1–Q9 walked incl. narrow width + keyboard-only; Q10–Q15 at A-1 volume; Q16–Q18 by inspection).",
    "- [ ] Self-review against QUALITY.md.",
    "- [ ] walk-verify pass — <REPLACE: verdict, defects found, fixes — written when verification ran>",
    "",
  ].join("\n");
}
