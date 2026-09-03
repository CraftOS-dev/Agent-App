/**
 * Bundle the blueprint toolkits INTO the `agent-app` package so a globally-installed
 * CLI can scaffold from them (`agent-app <dir> scaffold --blueprint <id>`) without a repo
 * checkout. Runs on `prepack`/`prepublishOnly`; the copy under
 * `framework/cli/toolkits/` is a build artifact (git-ignored).
 *
 * Only directories carrying an `a2app.toolkit.json` are bundled.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  if (!existsSync(join(dir, "a2app.toolkit.json"))) continue; // blueprints only, not @a2app/kit
  cpSync(dir, join(dest, name), { recursive: true });
  n += 1;
  console.log(`bundled blueprint: ${name}`);
}
console.log(`bundle-blueprints: ${n} blueprint(s) → ${dest}`);
