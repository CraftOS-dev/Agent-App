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

/** The system-owned minimum for an app that vendors nothing (section 4.2): the
 *  canon is never empty, and `manifest.json` is always system-owned. */
const NON_VENDORING_SYSTEM_PATHS = ["manifest.json"];

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const tk = projectToolkit(project.dir);
  if (tk === null) {
    // A non-vendoring stack (an app whose adapter is a library dependency, or one
    // assembled by hand) has no toolkit to re-vendor from, but section 4.2 still
    // requires it to carry a canon — and this command is the only writer, so
    // refusing here left such an app permanently unable to establish one. There
    // is nothing to copy; the canon is still recorded.
    writeSystemHashes(project.dir, NON_VENDORING_SYSTEM_PATHS);
    log.ok("toolkit-sync: no toolkit to vendor from — recorded the framework-file canon");
    log.raw(JSON.stringify({ ok: true, vendored: 0, canon: NON_VENDORING_SYSTEM_PATHS }, null, 2));
    return 0;
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
