/**
 * agent-app <dir> export [--out <file.zip>]
 *
 * Write the app as a package (framework packaging §6): one zip, one top-level
 * folder named after the app, and nothing §1 says a package never carries —
 * no credentials, no runtime state, no data directory (no accounts, sessions or
 * records ever leave in a package), no dependencies, no version control, and no
 * build output the app's or its toolkit's ignore rules name. The app's
 * `.a2app/toolkit.json` goes in reduced to its `id`: where the toolkit sits on
 * this machine means nothing on another.
 *
 * The zip installs elsewhere with `agent-app install --from <file.zip>`.
 */
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags } from "../lib/args.js";
import { shellRef } from "../lib/delivery.js";
import { readJsonFile } from "../lib/json.js";
import { log } from "../lib/log.js";
import { exclusionRules, slugify, walkPackage } from "../lib/package.js";
import { formatBytes, PackageRefusedError } from "../lib/packageErrors.js";
import { loadProject, UsageError } from "../lib/project.js";
import { PACKAGE_LIMIT } from "../lib/sources.js";
import { isToolkitId, projectToolkit } from "../lib/toolkit.js";
import { writeZip, type ZipSource } from "../lib/zip.js";

export async function run(args: string[], app: string): Promise<number> {
  const flags = parseFlags(args, { values: ["out"] });
  if (flags.positionals.length > 0) throw new UsageError(`export takes no arguments (got ${flags.positionals.join(" ")})`);
  const project = loadProject(app);
  const folder = slugify(project.manifest.name ?? "app");
  const out = resolve(flags.values.get("out") ?? `${folder}.zip`);
  if (existsSync(out)) throw new UsageError(`${out} already exists — choose another --out, or remove it first`);
  const partial = `${out}.partial-${process.pid}`;

  // The toolkit this app recorded is its own, on this machine: trusted here for
  // where its data directory and build output are.
  const rules = exclusionRules(project.dir, projectToolkit(project.dir));
  const sources: ZipSource[] = [{ name: `${folder}/`, directory: true }];
  let files = 0;
  let bytes = 0;
  walkPackage(project.dir, rules, (rel, abs, kind) => {
    // The archive being written may sit inside the app itself.
    if (resolve(abs) === out || resolve(abs) === partial) return;
    const name = `${folder}/${rel}`;
    if (kind === "directory") {
      sources.push({ name: `${name}/`, directory: true });
      return;
    }
    if (kind !== "file") throw new PackageRefusedError(`${rel} is ${kind === "link" ? "a link" : "not a regular file"} — a package holds only files and folders`);
    if (rel === ".a2app/toolkit.json") {
      const id = (readJsonFile(abs) as { id?: unknown }).id;
      if (!isToolkitId(id)) {
        log.warn(".a2app/toolkit.json names no toolkit id; the package goes without it and installs only with --blueprint");
        return;
      }
      sources.push({ name, data: Buffer.from(JSON.stringify({ id }, null, 2) + "\n") });
    } else {
      bytes += statSync(abs).size;
      if (bytes > PACKAGE_LIMIT) throw new PackageRefusedError(`the app is over the ${formatBytes(PACKAGE_LIMIT)} a package may hold`);
      sources.push({ name, file: abs });
    }
    files += 1;
  });

  let written;
  try {
    written = await writeZip(partial, sources);
    renameSync(partial, out);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  log.ok(`exported "${project.manifest.name}" to ${out} (${files} files, ${formatBytes(written.bytes)})`);
  log.info(`install it elsewhere with: agent-app install --from ${shellRef(out)}`);
  log.raw(JSON.stringify({ ok: true, file: out, sha256: written.sha256, bytes: written.bytes, files }, null, 2));
  return 0;
}
