/**
 * Stage the installable dsh bundle into `dist/`.
 *
 * A dsh bundle is a normally-resolvable npm package whose `dsh.bundle.patch`
 * manifest field points at a `cordis.patch.yml`, with a host half (`main` →
 * `lib/index.js`, a Cordis `apply(ctx)`) and a browser half (`./client` →
 * `lib/client.js`, contributed to the module loader). This stages both, the
 * generated manifest, the patch, and the skills into a self-contained `dist/`:
 *
 *   - lib/index.js   host bundle, engine (@a2app/integration-starter) inlined;
 *                    cordis + @deepseek-ai/* stay external (host-provided).
 *   - lib/client.js  browser bundle wrapped in dsh's module-loader closure
 *                    (`window.__ModuleLoader__.load({ id, factory })`); the
 *                    frozen platform module table (react, cordis, ui-slots, …)
 *                    stays external, everything else is inlined.
 *
 * Install with: dsh plugin --profile <name> add ./harness-plugins/dsh/dist
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginDir));
const dist = join(pluginDir, "dist");
const lib = join(dist, "lib");

/** Bundle name; also the module-loader id the client factory registers under. */
const BUNDLE_NAME = "dsh-agent-app";

/** Host-provided browser modules (dsh's frozen platform module table). */
const PLATFORM_MODULES = [
  "react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives",
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });

// Host half: ESM for Node; inline the shared engine, keep dsh SDK external.
await build({
  entryPoints: [join(pluginDir, "src", "index.ts")],
  outfile: join(lib, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["cordis", "@deepseek-ai/*"],
  define: { "process.env.A2APP_PLUGIN_BUILD": JSON.stringify(new Date().toISOString()) },
});

// Browser half: CJS wrapped in dsh's module-loader closure; platform table external.
await build({
  entryPoints: [join(pluginDir, "src", "client", "index.ts")],
  outfile: join(lib, "client.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: PLATFORM_MODULES,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(BUNDLE_NAME)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: "return module.exports; } });" },
});

const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify(
    {
      name: BUNDLE_NAME,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: pkg.type,
      main: "lib/index.js",
      exports: {
        ".": { default: "./lib/index.js" },
        "./client": { default: "./lib/client.js" },
        "./cordis.patch.yml": "./cordis.patch.yml",
        "./package.json": "./package.json",
      },
      files: ["lib", "skills", "cordis.patch.yml"],
      engines: pkg.engines,
      dsh: {
        bundle: { patch: "./cordis.patch.yml" },
        client: {
          inject: ["@deepseek-ai/dsh-client-ui-slots"],
          platform: "web",
          immediately: true,
        },
      },
      peerDependencies: { "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-tools": "*" },
    },
    null,
    2,
  ) + "\n",
);

cpSync(join(pluginDir, "cordis.patch.yml"), join(dist, "cordis.patch.yml"));
const skills = join(repoRoot, "skills");
if (existsSync(skills)) cpSync(skills, join(dist, "skills"), { recursive: true });

process.stdout.write("dsh bundle staged: install with `dsh plugin --profile <name> add ./harness-plugins/dsh/dist`\n");
