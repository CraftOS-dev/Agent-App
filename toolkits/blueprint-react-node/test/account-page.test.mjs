/**
 * The account page (`/_a2app/account`) is one file, shipped by every starter.
 * It speaks only the protocol (spec/v0_2/auth.md §4, §7, §8), so every stack
 * serves the same bytes. This one is the source; the others are copies, and a
 * copy that drifts is a page that behaves differently on one stack.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const toolkits = resolve(here, "..", "..");
const source = readFileSync(resolve(here, "..", "template", "a2app-account.html"));

const failures = [];
for (const kit of readdirSync(toolkits)) {
  const manifest = join(toolkits, kit, "a2app.toolkit.json");
  if (!existsSync(manifest) || kit === "blueprint-react-node") continue;
  const { template, adapterPaths = [] } = JSON.parse(readFileSync(manifest, "utf8"));
  if (!adapterPaths.includes("a2app-account.html")) continue;
  const copy = join(toolkits, kit, template, "a2app-account.html");
  if (!existsSync(copy)) failures.push(`${kit}: declares a2app-account.html but ships none`);
  else if (!readFileSync(copy).equals(source)) failures.push(`${kit}: a2app-account.html differs from blueprint-react-node's — copy it again`);
}

if (failures.length > 0) {
  console.error(`✗ account page: ${failures.length} problem(s)\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("✓ account page: every starter ships the same one");
