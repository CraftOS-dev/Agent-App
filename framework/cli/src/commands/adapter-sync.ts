/**
 * agent-app <dir> adapter-sync — deliver/update ONLY the adapter files, no rebuild.
 * Runs on every launch: it is the only path that reaches apps a user already
 * has. Idempotent, non-fatal, never touches app-authored code.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonPaths, fileMatchesCanon, writeSystemHashes } from "../lib/canon.js";
import { writeFileAtomic } from "../lib/home.js";
import { loadProject } from "../lib/project.js";
import { adapterVersionOf, projectToolkit, vendorPaths } from "../lib/toolkit.js";
import { log } from "../lib/log.js";
import { readJsonFile } from "../lib/json.js";

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const tk = projectToolkit(project.dir);
  if (tk === null) {
    log.warn("no toolkit recorded — skipping adapter-sync (app starts with its existing adapter)");
    return 0; // non-fatal
  }
  const adapterPaths = tk.manifest.adapterPaths ?? tk.manifest.systemPaths;
  // Warn before overwriting an adapter file that drifted from the canon: it is a
  // system-owned file, so a local edit is unexpected — but surfacing it (rather
  // than silently clobbering) means a legitimate change is never lost quietly.
  for (const rel of adapterPaths) {
    if (existsSync(join(project.dir, rel)) && fileMatchesCanon(project.dir, rel) === false) {
      log.warn(`overwriting locally-modified system file ${rel} with the toolkit's version`);
    }
  }
  const written = vendorPaths(tk, project.dir, adapterPaths);
  if (written.length === 0) {
    log.warn("no adapter files found in the toolkit — nothing to sync");
    return 0;
  }
  const version = adapterVersionOf(tk);
  const manifestPath = join(project.dir, "manifest.json");
  const manifest = readJsonFile(manifestPath) as Record<string, unknown>;
  const previous = manifest.adapterVersion ?? "none";
  manifest.adapterVersion = version;
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  // Re-canonize the full system set so the freshly written adapter files match
  // canon (only when a canon already exists).
  if (canonPaths(project.dir).length > 0) {
    writeSystemHashes(project.dir, tk.manifest.systemPaths);
  }
  log.ok(`adapter ${previous} → ${version} (${written.length} file(s), no rebuild required)`);
  for (const f of written) log.raw(`  ${f}`);
  return 0;
}
