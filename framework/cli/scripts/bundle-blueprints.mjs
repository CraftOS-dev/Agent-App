/**
 * Bundle the blueprint toolkits INTO the `agent-app` package so a globally-installed
 * CLI can scaffold from them (`agent-app <dir> scaffold --blueprint <id>`) without a repo
 * checkout. Runs on `prepack`/`prepublishOnly`; the copy under
 * `framework/cli/toolkits/` is a build artifact (git-ignored).
 *
 * Only directories carrying an `a2app.toolkit.json` are bundled.
 *
 * npm never packs a file named `.gitignore` (it reads it as the package's own
 * ignore rules), so each one is also written as `_gitignore` beside it. The CLI
 * copies that back as `.gitignore` when it vendors a template (`unpackName` in
 * src/lib/toolkit.ts); without it, an app scaffolded from an installed CLI got
 * none of its stack's rules, and its export shipped the PocketBase binary.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTree } from "./copy-tree.mjs";

/** Write every `.gitignore` under `dir` again as `_gitignore`, the name npm packs. */
function keepIgnoreFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) keepIgnoreFiles(path);
    else if (entry.isFile() && entry.name === ".gitignore") copyFileSync(path, join(dir, "_gitignore"));
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "..", "toolkits");
const dest = resolve(here, "..", "toolkits");

if (!existsSync(src)) {
  console.error(`bundle-blueprints: source toolkits dir not found at ${src}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

let n = 0;
for (const name of readdirSync(src)) {
  const dir = join(src, name);
  if (!existsSync(join(dir, "a2app.toolkit.json"))) continue; // blueprints only, not @craftos/agent-app-kit
  copyTree(dir, join(dest, name));
  keepIgnoreFiles(join(dest, name));
  n += 1;
  console.log(`bundled blueprint: ${name}`);
}
console.log(`bundle-blueprints: ${n} blueprint(s) → ${dest}`);
