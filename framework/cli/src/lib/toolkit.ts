/**
 * The toolkit contract.
 *
 * Toolkits are NOT part of the framework; nothing here may be required for
 * compliance. But when an app WAS scaffolded from a toolkit, the framework CLI
 * needs a stack-agnostic way to know which files the toolkit owns (to vendor and
 * canonize), which extra gate steps it defines, and how it makes a dev copy /
 * backup. That contract is a single JSON file at the toolkit root:
 *
 *   a2app.toolkit.json
 *   {
 *     "id": "blueprint-pocketbase-react",
 *     "template": "template",                  // dir copied on `scaffold`
 *     "adapterVersionFrom": "pb/pb_hooks/_a2app_lib.js",  // file holding ADAPTER_VERSION
 *     "systemPaths": ["manifest.json", "pb/pb_hooks/_a2app.pb.js", ...],
 *     "adapterPaths": ["pb/pb_hooks/_a2app.pb.js", ...],  // subset re-vendored by adapter-sync
 *     "gate": [ { "name": "migrations (fresh db)", "run": "node scripts/migrate-check.mjs" } ],
 *     "lifecycle": { "dataDir": "pb/pb_data", "dev": "...", "promote": "..." }
 *   }
 *
 * The app records which toolkit it came from in `.a2app/toolkit.json`
 * `{ "id": "...", "source": "<abs path>" }` so sync commands can find it again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInside, assertRealInside, copyTree } from "./fsx.js";

export interface GateStep {
  name: string;
  run: string;
}

export interface ToolkitManifest {
  id: string;
  template?: string;
  adapterVersionFrom?: string;
  systemPaths: string[];
  adapterPaths?: string[];
  gate?: GateStep[];
  lifecycle?: {
    dataDir?: string;
    dev?: string;
    promote?: string;
    backup?: string;
    restore?: string;
  };
}

export interface ResolvedToolkit {
  source: string;
  manifest: ToolkitManifest;
}

const CLI_DIR = dirname(fileURLToPath(import.meta.url));

/** Candidate roots where a bare blueprint id may live. */
function toolkitSearchRoots(): string[] {
  const roots = [process.cwd(), join(process.cwd(), "toolkits")];
  const envRoot = process.env["A2APP_TOOLKITS_DIR"];
  if (envRoot) roots.unshift(envRoot);
  // In-repo dev BEFORE the bundle: dist/lib -> package -> framework -> repo root.
  //
  // Order matters, and having it the other way round was a trap. The bundled
  // copy is a build artifact refreshed only at pack time, so in a checkout it is
  // whatever the last `npm pack` left behind. Searched first, it silently won
  // over the source: you edit `toolkits/<id>/template`, scaffold, and get an app
  // built from the STALE blueprint — with no error, and nothing in the output
  // naming which copy was used. Every symptom then looks like your edit having
  // no effect.
  //
  // A published CLI has no repo above it, so this path simply does not exist
  // there and the bundle still wins.
  roots.push(resolve(CLI_DIR, "..", "..", "..", "..", "toolkits"));
  // Bundled with a published CLI: dist/lib -> package root -> toolkits/
  // (blueprints are copied here by scripts/bundle-blueprints.mjs at pack time).
  roots.push(resolve(CLI_DIR, "..", "..", "toolkits"));
  return roots;
}

/** Resolve a `--blueprint` value (path or bare id) to a toolkit directory. */
export function resolveToolkit(idOrPath: string): ResolvedToolkit {
  const candidates: string[] = [];
  if (isAbsolute(idOrPath) || idOrPath.startsWith(".")) {
    candidates.push(resolve(idOrPath));
  } else {
    for (const root of toolkitSearchRoots()) candidates.push(join(root, idOrPath));
  }
  for (const dir of candidates) {
    const file = join(dir, "a2app.toolkit.json");
    if (existsSync(file)) {
      return { source: dir, manifest: JSON.parse(readFileSync(file, "utf8")) as ToolkitManifest };
    }
  }
  throw new Error(
    `toolkit "${idOrPath}" not found (looked for a2app.toolkit.json in: ${candidates.join(", ")})`,
  );
}

/** Read the toolkit an app was scaffolded from, re-resolving its source. */
export function projectToolkit(projectDir: string): ResolvedToolkit | null {
  const record = join(projectDir, ".a2app", "toolkit.json");
  if (!existsSync(record)) return null;
  const { id, source } = JSON.parse(readFileSync(record, "utf8")) as { id: string; source?: string };
  if (source && existsSync(join(source, "a2app.toolkit.json"))) {
    return { source, manifest: JSON.parse(readFileSync(join(source, "a2app.toolkit.json"), "utf8")) as ToolkitManifest };
  }
  // Source moved — fall back to id resolution.
  try {
    return resolveToolkit(id);
  } catch {
    return null;
  }
}

export function recordProjectToolkit(projectDir: string, tk: ResolvedToolkit): void {
  mkdirSync(join(projectDir, ".a2app"), { recursive: true });
  writeFileSync(
    join(projectDir, ".a2app", "toolkit.json"),
    JSON.stringify({ id: tk.manifest.id, source: tk.source }, null, 2) + "\n",
  );
}

/** Copy a set of paths from the toolkit template into the project. Returns the
 *  list of files actually written. */
export function vendorPaths(tk: ResolvedToolkit, projectDir: string, paths: string[]): string[] {
  const templateRoot = tk.manifest.template ? join(tk.source, tk.manifest.template) : tk.source;
  const written: string[] = [];
  for (const rel of paths) {
    // Contain both ends: a toolkit's declared path list is untrusted (especially
    // on import), so it must neither read outside the template nor write outside
    // the project. assertInside throws on a `../` or absolute escape.
    const src = assertInside(templateRoot, rel, "template path");
    if (!existsSync(src)) continue;
    const dest = assertRealInside(projectDir, rel, "vendored path");
    mkdirSync(dirname(dest), { recursive: true });
    copyTree(src, dest);
    written.push(rel);
  }
  return written;
}

/** The adapter version, read from the toolkit's single source of truth (one
 *  source inside the adapter itself). */
export function adapterVersionOf(tk: ResolvedToolkit): string {
  const rel = tk.manifest.adapterVersionFrom;
  if (!rel) return "0.1.0";
  const templateRoot = tk.manifest.template ? join(tk.source, tk.manifest.template) : tk.source;
  try {
    const src = readFileSync(join(templateRoot, rel), "utf8");
    const m = src.match(/ADAPTER_VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m?.[1] ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}
