/**
 * Build the installable OpenClaw plugin into `dist/`.
 *
 * OpenClaw installs a plugin by COPYING its folder, rejects node_modules
 * symlinks that escape it, and never installs dependencies for a local-dir
 * install — so the installable artifact must be self-contained. This script
 * stages exactly that:
 *
 *   dist/index.js            src/index.ts bundled with the shared engine
 *                            (@a2app/integration-starter) inlined; only the
 *                            host-provided `openclaw/plugin-sdk/*` stays external
 *   dist/package.json        generated from this package.json; declares the
 *                            entry via `openclaw.extensions` (OpenClaw does not
 *                            read `main`)
 *   dist/openclaw.plugin.json  copied manifest
 *   dist/skills/             copied from the repo-root skills/ (the single
 *                            source of truth) so the manifest's `./skills`
 *                            resolves inside the plugin root
 *
 * Install with: openclaw plugins install ./harness-plugins/openclaw/dist
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginDir));
const dist = join(pluginDir, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(pluginDir, "src", "index.ts")],
  outfile: join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["openclaw/*"],
});

const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: pkg.type,
      engines: pkg.engines,
      openclaw: { extensions: ["./index.js"] },
    },
    null,
    2,
  ) + "\n",
);

cpSync(join(pluginDir, "openclaw.plugin.json"), join(dist, "openclaw.plugin.json"));
cpSync(join(repoRoot, "skills"), join(dist, "skills"), { recursive: true });

process.stdout.write("openclaw plugin staged: install with `openclaw plugins install ./harness-plugins/openclaw/dist`\n");
