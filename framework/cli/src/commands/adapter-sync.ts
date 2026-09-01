/**
 * a2app adapter-sync <dir> — deliver/update ONLY the adapter files, no rebuild.
 * Runs on every launch: it is the only path that reaches apps a user already
 * has. Idempotent, non-fatal, never touches app-authored code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonPaths, writeSystemHashes } from "../lib/canon.js";
import { loadProject, UsageError } from "../lib/project.js";
import { adapterVersionOf, projectToolkit, vendorPaths } from "../lib/toolkit.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: a2app adapter-sync <dir>");
  const project = loadProject(dir);
  const tk = projectToolkit(project.dir);
  if (tk === null) {
    log.warn("no toolkit recorded — skipping adapter-sync (app starts with its existing adapter)");
    return 0; // non-fatal
  }
  const adapterPaths = tk.manifest.adapterPaths ?? tk.manifest.systemPaths;
  const written = vendorPaths(tk, project.dir, adapterPaths);
  if (written.length === 0) {
    log.warn("no adapter files found in the toolkit — nothing to sync");
    return 0;
  }
  const version = adapterVersionOf(tk);
  const manifestPath = join(project.dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const previous = manifest.adapterVersion ?? "none";
  manifest.adapterVersion = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  // Re-canonize the full system set so the freshly written adapter files match
  // canon (only when a canon already exists).
  if (canonPaths(project.dir).length > 0) {
    writeSystemHashes(project.dir, tk.manifest.systemPaths);
  }
  log.ok(`adapter ${previous} → ${version} (${written.length} file(s), no rebuild required)`);
  for (const f of written) log.raw(`  ${f}`);
  return 0;
}
