/**
 * agent-app <dir> scaffold --blueprint <id|path> [--name "..."] [--port N] [--auth-mode none|multi-user]
 *
 * Scaffold a new Agent App: vendor the blueprint, assign a fresh identity, stamp
 * versions, write the ownership canon, and provision the agent credential.
 * Credentials are runtime artifacts — never copied from a blueprint.
 *
 * `<dir>` is the app being created, so it is the target here rather than an
 * existing app — same first-positional slot as every other command (spec 5.1).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeSystemHashes } from "../lib/canon.js";
import { flag, hasFlag } from "../lib/args.js";
import { mintAgentToken, stripCredentials } from "../lib/credential.js";
import { writeFileAtomic } from "../lib/home.js";
import { linkLocalPackages } from "../lib/localPackages.js";
import { AGENT_APP_VERSION } from "../lib/manifest.js";
import { UsageError } from "../lib/project.js";
import { ensureIgnoreRules, writeHarnessGuides } from "../lib/scaffoldFiles.js";
import {
  adapterVersionOf,
  availableToolkits,
  recordProjectToolkit,
  resolveToolkit,
  vendorPaths,
  type ResolvedToolkit,
} from "../lib/toolkit.js";
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
  // Every app is built on a blueprint (`blueprint-base` is the one with no
  // stack). Without one there is nothing to build on, so the choice is asked
  // for by name rather than made silently.
  const blueprintId = flag(args, "blueprint");
  if (blueprintId === undefined) {
    const ids = availableToolkits().map((t) => t.manifest.id);
    throw new UsageError(
      `scaffold needs --blueprint <id>: one of ${ids.join(", ")}. ` +
        `\`agent-app blueprints\` says what each is built with.`,
    );
  }
  let tk: ResolvedToolkit;
  try {
    tk = resolveToolkit(blueprintId);
  } catch (err) {
    // An unknown blueprint is a usage mistake (exit 2), not a rejection.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  mkdirSync(dir, { recursive: true });

  // From here on, unwind on failure: a partial scaffold must not leak a registry
  // entry / claimed port, nor leave a half-written app that reads as "present".
  let reserved = false;
  try {
    vendorPaths(tk, dir, allTemplateFiles(tk));
    ensureIgnoreRules(dir, tk.manifest.lifecycle?.dataDir);
    recordProjectToolkit(dir, tk);
    const systemPaths = tk.manifest.systemPaths;
    const adapterVersion = adapterVersionOf(tk);
    log.step(`scaffolded from blueprint "${tk.manifest.id}"`);

    // Fresh identity + stamped versions, merged over the blueprint's manifest.
    const manifestPath = join(dir, "manifest.json");
    const manifest = existsSync(manifestPath)
      ? (readJsonFile(manifestPath) as Record<string, unknown>)
      : {};
    manifest.id = randomBytes(6).toString("hex");
    manifest.name = name;
    manifest.agentAppVersion = AGENT_APP_VERSION;
    manifest.adapterVersion = adapterVersion;
    // `multi-user` gives the app accounts, sign-in and per-person records
    // (spec/v0_2/auth.md); `none` is a personal tool with one principal. The
    // manifest is system-owned, so this is the moment to choose.
    const authMode = flag(args, "auth-mode") ?? manifest.authMode ?? "none";
    if (authMode !== "none" && authMode !== "multi-user") {
      throw new UsageError(`--auth-mode is "none" or "multi-user" (got "${String(authMode)}")`);
    }
    manifest.authMode = authMode;
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
        blueprint: tk.manifest.id,
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
    for (const dep of linkLocalPackages(dir, tk.source)) {
      log.step(`linked ${dep.name} ${dep.from} -> ${dep.to} (not published; resolved from the toolkit's repo)`);
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

/** Every file under the toolkit template — the scaffold copies the whole app, not
 *  only the system paths (which is what toolkit-sync re-vendors later). */
function allTemplateFiles(_tk: ResolvedToolkit): string[] {
  // vendorPaths copies directories recursively; "." copies the whole template.
  return ["."];
}
