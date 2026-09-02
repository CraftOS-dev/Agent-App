/**
 * Bundle the framework skills INTO the `agent-app` package so a globally-installed
 * CLI can hand them to any harness (`agent-app skills --install <dir>`) without a
 * repo checkout. Runs on `prepack`/`prepublishOnly`; the copy under
 * `framework/cli/skills/` is a build artifact (git-ignored).
 *
 * Skills are the framework's knowledge half (spec section 5.2). Shipping them
 * with the binary is what makes "an agent with the skills and the files needs
 * nothing from any host" true for a plain `npm i -g agent-app`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "..", "skills");
const dest = resolve(here, "..", "skills");

if (!existsSync(src)) {
  console.error(`bundle-skills: source skills dir not found at ${src}`);
  process.exit(1);
}

const indexPath = join(src, "index.json");
if (!existsSync(indexPath)) {
  console.error(`bundle-skills: ${indexPath} missing — the index is how agents select a skill`);
  process.exit(1);
}

// Fail the pack rather than ship an index pointing at skills that aren't there:
// a broken index is worse than no skills, because selection is meant to be
// deterministic.
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const missing = (index.skills ?? []).filter((s) => !existsSync(join(src, s.path)));
if (missing.length > 0) {
  console.error(`bundle-skills: index lists missing skill(s): ${missing.map((s) => s.path).join(", ")}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

console.log(`bundle-skills: ${index.skills.length} skill(s) → ${dest}`);
