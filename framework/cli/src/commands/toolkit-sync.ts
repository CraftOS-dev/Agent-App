/**
 * agent-app <dir> toolkit-sync — re-vendor the toolkit's system files and re-record
 * the ownership canon. The single writer of the canon; it records exactly the
 * files it just wrote.
 */
import { join } from "node:path";
import { writeSystemHashes } from "../lib/canon.js";
import { writeFileAtomic } from "../lib/home.js";
import { mergeManifest, type Manifestish } from "../lib/manifest.js";
import { loadProject } from "../lib/project.js";
import { adapterVersionOf, projectToolkit, vendorPaths } from "../lib/toolkit.js";
import { log } from "../lib/log.js";
import { readJsonFile } from "../lib/json.js";

/** The system-owned minimum for an app that vendors nothing (section 4.2): the
 *  canon is never empty, and `manifest.json` is always system-owned. */
const NON_VENDORING_SYSTEM_PATHS = ["manifest.json"];

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const tk = projectToolkit(project.dir);
  const manifestPath = join(project.dir, "manifest.json");
  if (tk === null) {
    // A non-vendoring stack (an app whose adapter is a library dependency, or one
    // assembled by hand) has no toolkit to re-vendor from, but section 4.2 still
    // requires it to carry a canon — and this command is the only writer, so
    // refusing here left such an app permanently unable to establish one. There
    // is nothing to copy; the canon is still recorded. Note that with no trusted
    // toolkit there is nothing to restore a tampered `pipeline` FROM, so this
    // branch canonizes the manifest exactly as it stands.
    writeSystemHashes(project.dir, NON_VENDORING_SYSTEM_PATHS);
    log.ok("toolkit-sync: no toolkit to vendor from — recorded the framework-file canon");
    log.raw(JSON.stringify({ ok: true, vendored: 0, canon: NON_VENDORING_SYSTEM_PATHS }, null, 2));
    return 0;
  }

  // Read the app's manifest BEFORE vendoring: `manifest.json` is one of the
  // toolkit's system paths, so the copy below overwrites it with the template's
  // — which carries the blueprint's placeholder id, no port, and the blueprint's
  // modules. Losing those would destroy the app, so the app's own keys are
  // merged back over the freshly vendored template afterwards.
  const existing = readJsonFile(manifestPath) as Manifestish;

  const written = vendorPaths(tk, project.dir, tk.manifest.systemPaths);
  const version = adapterVersionOf(tk);

  // The vendored template is the trusted side for executable configuration
  // (`pipeline`); the app is the trusted side for identity and modules. Merging
  // here is also what lets an author edit their modules and reseal: the canon is
  // recorded AFTER this write, so the manifest it hashes is the merged one.
  const template = readJsonFile(manifestPath) as Manifestish;
  const merged = mergeManifest(template, existing, version);
  writeFileAtomic(manifestPath, JSON.stringify(merged, null, 2) + "\n");

  writeSystemHashes(project.dir, tk.manifest.systemPaths);
  log.ok(`toolkit-sync: ${written.length} system file(s) vendored, adapter ${version}, canon recorded`);
  for (const f of written) log.raw(`  ${f}`);
  return 0;
}
