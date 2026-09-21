/**
 * Stage the installable OpenClaw plugin into `dist/`.
 *
 * OpenClaw installs a plugin by copying its folder, rejects node_modules symlinks
 * that escape it, and never installs dependencies for a local-dir install, so the
 * artifact must be self-contained: the entry is bundled with the shared engine
 * inlined (only `openclaw/plugin-sdk/*` stays external), the generated
 * package.json declares it via `openclaw.extensions` (OpenClaw ignores `main`),
 * and the manifest and repo-root skills/ are copied in so `./skills` resolves
 * inside the plugin root.
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
  define: { "process.env.A2APP_PLUGIN_BUILD": JSON.stringify(new Date().toISOString()) },
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
