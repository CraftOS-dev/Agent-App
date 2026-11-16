/**
 * Files the framework writes into an app it creates or installs, beside the
 * framework files: the ignore rules that keep runtime artifacts out of a
 * repository, and the harness-facing guides that tell an agent what the app is.
 * `scaffold` and `install` both write them, from here, so the two never drift.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARRIED_FRAMEWORK_FILES, CREDENTIAL_NAMES, NEVER_CARRIED_DIRS, SECRET_SUFFIX } from "./package.js";

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
export function writeHarnessGuides(dir: string, name: string): void {
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
        // The stack map comes first: before writing any code, an agent reads
        // `reference/blueprint.md` to learn this stack's file ownership, schema
        // API, operation wiring, UI kit, and gate — so the contract is never
        // reverse-engineered from source.
        "- `reference/blueprint.md` — YOUR STACK'S MAP: files you own vs. system-owned, schema/migration API, operations, UI kit, gate. Read this before writing code.",
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
        "a2app . data <entity> create --<field> \"…\"   # raw record access: list|get|create|update|delete",
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
        "agent-app . dev          # boot the candidate on a hidden port, fresh migration-replayed DB (--install the first time)",
        "agent-app . validate     # the gate — must pass; measures the dev instance, records the pass",
        'agent-app . commit --message "<what and why>"   # walk-verify verifies a commit',
        "# walk-verify: a verifier agent that is NOT the builder loads the walk-verify",
        "# skill and drives every reference/requirements.md Feature against the dev URL.",
        "agent-app . stop         # promote refuses while the live app is serving",
        "agent-app . promote      # requires the gate pass; backup, apply to live, destroy dev",
        "agent-app . serve        # bring the changed app back up",
        "```",
        "",
        "While the dev instance is up, every `a2app` operate command targets IT — test",
        "data lands in its disposable database, never in live data.",
        "",
        "The app is its own git repository. Commit each coherent change — a feature, a",
        "fix, a refactor — with a message saying what and why, and always before a",
        "verification: the history is how a change is reviewed, rolled back and verified.",
        "",
        "Never build against the live app, never edit an applied migration, never drop a",
        "collection holding user data, and never write a system-owned file listed in",
        "`.a2app/system-hashes.json` — the gate fails on drift. In `manifest.json` the",
        "keys `name`, `authMode`, `modules`, `appVersion` and `capabilities` are yours",
        "(and `pipeline` where the blueprint has you write it); every other key is locked.",
        "",
      ].join("\n"),
    );
  }
  const claude = join(dir, "CLAUDE.md");
  if (!existsSync(claude)) {
    writeFileSync(claude, `See [AGENTS.md](AGENTS.md) — it applies in full.\n`);
  }
}

/**
 * The framework's state in `.a2app/`: all of it is runtime (serve and dev
 * records, logs, the gate pass, caches, backups) except the files a package
 * carries, which are part of the app. Ignoring it as a whole is what keeps a
 * `dev` or a `validate` from leaving the tree dirty, so the commit walk-verify
 * verifies is the tree that ran.
 */
const FRAMEWORK_STATE = [".a2app/*", ...[...CARRIED_FRAMEWORK_FILES].map((name) => `!.a2app/${name}`)];

/**
 * What a package never carries (packaging §1) is never committed either: every
 * credential wherever it sits, `*.secret` included, and the dependency trees
 * the pipeline reinstalls. `.git/` is git's own.
 */
const NEVER_COMMITTED = [
  ...CREDENTIAL_NAMES,
  `*${SECRET_SUFFIX}`,
  ...[...NEVER_CARRIED_DIRS].filter((name) => name !== ".git").map((name) => `${name}/`),
];

/**
 * Guarantee the ignore rules that keep runtime artifacts out of a repository.
 *
 * Blueprints ship their own `.gitignore` (packed as `_gitignore`, since npm
 * strips the real name from a tarball), but an imported or adopted app may carry
 * none, and an older one may lack a rule added since. Without these the next
 * `git add -A` publishes the agent token, the principal password, every other
 * secret and the live database, so the rules the framework depends on are
 * written here, from the CLI, on every path.
 *
 * Existing lines are kept and only missing ones appended: a blueprint's own
 * rules (the PocketBase binary, __pycache__, build output) are none of the
 * framework's business, and re-running must not churn the file.
 */
export function ensureIgnoreRules(dir: string, dataDir?: string): void {
  const rules = [...NEVER_COMMITTED];
  // The database lives wherever the toolkit says it does, so the rule follows
  // the declaration rather than assuming "data/".
  if (dataDir !== undefined && dataDir.trim() !== "") {
    rules.push(dataDir.trim().replace(/[\/]+$/, "") + "/");
  }
  const file = join(dir, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = rules.filter((rule) => !present.has(rule));
  // A negation only re-includes what a rule ABOVE it ignored, so the framework
  // state goes in as one block, in order, whenever any line of it is missing.
  if (!FRAMEWORK_STATE.every((rule) => present.has(rule))) missing.push(...FRAMEWORK_STATE);
  if (missing.length === 0) return;
  const header = [
    "# Written by agent-app: credentials, dependencies, framework state and the",
    "# live database are runtime artifacts and must never be committed.",
  ];
  const prefix = existing.trim() === "" ? "" : existing.replace(/\s*$/, "") + "\n\n";
  writeFileSync(file, prefix + [...header, ...missing, ""].join("\n"));
}
