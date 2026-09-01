/**
 * a2app create <dir> [--blueprint <id|path>] [--name "..."] [--port N]
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
import { log } from "../lib/log.js";

const AGENT_APP_VERSION = "0.1.0";

export async function run(args: string[]): Promise<number> {
  const dirArg = args.find((a) => !a.startsWith("--"));
  if (dirArg === undefined) {
    throw new UsageError("Usage: a2app create <dir> [--blueprint <id|path>] [--name \"...\"] [--port N]");
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
  const port = flag(args, "port");
  if (port !== undefined) manifest.port = Number(port);
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

  writeSystemHashes(dir, systemPaths);

  log.ok(`Created Agent App "${name}" (id ${manifest.id as string}) at ${dir}`);
  log.raw(JSON.stringify({ ok: true, id: manifest.id, dir, adapterVersion }, null, 2));
  return 0;
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
