/**
 * agent-app <dir> toolkit-sync — re-vendor the toolkit's system files and re-record
 * the ownership canon. The single writer of the canon; it records exactly the
 * files it just wrote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSystemHashes } from "../lib/canon.js";
import { writeFileAtomic } from "../lib/home.js";
import { loadProject } from "../lib/project.js";
import { adapterVersionOf, projectToolkit, vendorPaths } from "../lib/toolkit.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const tk = projectToolkit(project.dir);
  if (tk === null) {
    log.error("no toolkit recorded for this app (.a2app/toolkit.json missing) — nothing to sync");
    return 1;
  }
  const written = vendorPaths(tk, project.dir, tk.manifest.systemPaths);
  const version = adapterVersionOf(tk);
  // Stamp adapter version into the manifest, then canonize (the manifest is a
  // system-owned path, so its hash is recorded AFTER this write).
  const manifestPath = join(project.dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.adapterVersion = version;
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeSystemHashes(project.dir, tk.manifest.systemPaths);
  log.ok(`toolkit-sync: ${written.length} system file(s) vendored, adapter ${version}, canon recorded`);
  for (const f of written) log.raw(`  ${f}`);
  return 0;
}
