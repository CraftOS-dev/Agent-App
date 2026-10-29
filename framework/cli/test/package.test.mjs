/**
 * The package rules (framework packaging §1–§3, §5) as libraries: what a
 * package never carries, what kind of tree it is, how placeholders are written,
 * what a catalogue may say, how sources are parsed, and how downloads are
 * bounded. The CLI-level install test drives the same code end to end; this
 * file pins each rule on its own, where a failure names the rule.
 *
 * Standard library only, run directly. No network: downloads go to a local
 * HTTP server.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isIgnored, parseIgnore } from "../dist/lib/ignore.js";
import { classify, exclusionRules, findPlaceholders, slugify, strippable, substitutePlaceholders } from "../dist/lib/package.js";
import { compatibility, matchesSearch, parseGithubShorthand, validateCatalogue } from "../dist/lib/marketplace.js";
import { parseFrom } from "../dist/lib/sources.js";
import { downloadBytes, downloadToFile, USER_AGENT } from "../dist/lib/download.js";
import { PackageRefusedError, SourceNotFoundError, SourceUnreachableError } from "../dist/lib/packageErrors.js";
import { installedToolkit, isToolkitId, resolveToolkit } from "../dist/lib/toolkit.js";
import { UsageError } from "../dist/lib/project.js";

const base = mkdtempSync(join(tmpdir(), "a2app-package-"));
let n = 0;
const fresh = () => {
  const dir = join(base, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (root, rel, content = "x") => {
  const file = join(root, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------ ignore rules */

test("ignore rules: the patterns stacks actually write", () => {
  const rules = parseIgnore(
    [
      "# comment",
      "",
      "node_modules/",
      "dist/",
      "/public/",
      "*.py[cod]",
      "pb/pocketbase",
      "**/cache/",
      "logs/**",
      "*.log",
      "!keep.log",
      "\\#literal",
      "trailing   ",
    ].join("\n"),
  );
  const cases = [
    ["node_modules", true, true],
    ["ui/node_modules", true, true],
    ["node_modules", false, false], // a FILE named node_modules: the rule is folders-only
    ["dist", true, true],
    ["public", true, true],
    ["app/public", true, false], // anchored to the root
    ["x/y.pyc", false, true],
    ["x/y.py", false, false],
    ["pb/pocketbase", false, true],
    ["other/pb/pocketbase", false, false],
    ["a/b/cache", true, true],
    ["cache", true, true],
    ["logs/today.txt", false, true],
    ["server.log", false, true],
    ["keep.log", false, false],
    ["#literal", false, true],
    ["trailing", false, true],
  ];
  for (const [path, dir, want] of cases) assert.equal(isIgnored(rules, path, dir), want, `${path}${dir ? "/" : ""}`);
});

/* ------------------------------------------------------- never carried (§1) */

test("sanitize lists everything §1 says a package never carries, and nothing else", () => {
  const root = fresh();
  const tk = resolveToolkit("blueprint-react-node");
  // Kept: the framework files and the app's own code.
  for (const rel of ["manifest.json", "operations.json", "AGENT_APP.md", "reference/requirements.md", ".a2app/toolkit.json", ".a2app/system-hashes.json", "src/App.jsx", "server.mjs"]) {
    put(root, rel);
  }
  // Never carried.
  const strip = [
    ".agent-token",
    ".superuser",
    ".principal",
    "nested/.principal",
    "keys/api.secret",
    ".tunnel-secret",
    ".lan-secret",
    ".a2app/serve.json",
    ".a2app/serve.log",
    ".a2app/serve.lock",
    ".a2app/dev.json",
    ".a2app/dev/db.sqlite",
    ".a2app/bridge.json",
    ".a2app/bridge.log",
    ".a2app/backups/2026/db.sqlite",
    ".a2app/gate-pass.json",
    ".a2app/describe-cache.json",
    ".a2app/lifecycle.lock",
    ".a2app/public/index.html",
    "logs/app.log",
    "data/db.sqlite", // the toolkit's lifecycle.dataDir
    "node_modules/x/index.js",
    "ui/node_modules/y/index.js",
    ".git/config",
    "dist/assets/app.js", // build output, from the toolkit template's .gitignore
  ];
  for (const rel of strip) put(root, rel);
  const listed = strippable(root, exclusionRules(root, tk));
  assert.deepEqual(
    listed.sort(),
    [
      ".a2app/backups/",
      ".a2app/bridge.json",
      ".a2app/bridge.log",
      ".a2app/describe-cache.json",
      ".a2app/dev.json",
      ".a2app/dev/",
      ".a2app/gate-pass.json",
      ".a2app/lifecycle.lock",
      ".a2app/public/",
      ".a2app/serve.json",
      ".a2app/serve.lock",
      ".a2app/serve.log",
      ".agent-token",
      ".git/",
      ".lan-secret",
      ".principal",
      ".superuser",
      ".tunnel-secret",
      "data/",
      "dist/",
      "keys/api.secret",
      "logs/",
      "nested/.principal",
      "node_modules/",
      "ui/node_modules/",
    ].sort(),
  );
});

test("the package's own ignore rules never re-include what the toolkit's exclude", () => {
  const root = fresh();
  put(root, ".gitignore", "!dist/\n.env\n");
  put(root, "dist/app.js");
  put(root, ".env", "SECRET=1");
  put(root, "src/main.js");
  const listed = strippable(root, exclusionRules(root, resolveToolkit("blueprint-react-node")));
  assert.deepEqual(listed.sort(), [".env", "dist/"]);
});

/* ---------------------------------------------------------------- classify */

test("classification is by manifest structure", () => {
  const agentApp = fresh();
  put(agentApp, "manifest.json", JSON.stringify({ agentAppVersion: "0.1.0", modules: [{ name: "core" }] }));
  assert.equal(classify(agentApp).kind, "agent-app");

  const livingUi = fresh();
  put(livingUi, "manifest.json", JSON.stringify({ livingUIVersion: 2, name: "Kanban" }));
  assert.equal(classify(livingUi).kind, "living-ui");
  assert.deepEqual(classify(livingUi).routes, ["convert"]);

  const numeric = fresh();
  put(numeric, "manifest.json", JSON.stringify({ agentAppVersion: 2, modules: [] }));
  assert.equal(classify(numeric).kind, "living-ui", "a numeric agentAppVersion is CraftBot's, even beside modules");

  const none = fresh();
  put(none, "index.js");
  assert.equal(classify(none).kind, "foreign");
  assert.deepEqual(classify(none).routes, ["adopt", "convert"]);

  const notJson = fresh();
  put(notJson, "manifest.json", "{ nope");
  assert.equal(classify(notJson).kind, "foreign");

  const other = fresh();
  put(other, "manifest.json", JSON.stringify({ name: "a web app manifest", icons: [] }));
  assert.equal(classify(other).kind, "foreign");
});

/* ------------------------------------------------------------ placeholders */

test("placeholders are escaped per file type, and binary files are never touched", () => {
  const root = fresh();
  put(root, "config.json", '{ "title": "{{APP_TITLE}}", "id": "{{PROJECT_ID}}" }');
  put(root, "index.html", "<title>{{APP_TITLE}}</title>");
  put(root, "README.md", "# {{APP_TITLE}}");
  put(root, "plain.txt", "id={{PROJECT_ID}}");
  const binary = Buffer.from([0x00, 0x7b, 0x7b, 0x41, 0x50, 0x50, 0x5f, 0x54, 0x49, 0x54, 0x4c, 0x45, 0x7d, 0x7d]); // NUL + {{APP_TITLE}}
  writeFileSync(join(root, "image.bin"), binary);
  const value = `Team "A" <b>&</b>`;
  const result = substitutePlaceholders(root, new Map([["APP_TITLE", value], ["PROJECT_ID", "abc123"]]), new Set());
  assert.equal(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).title, value);
  assert.equal(readFileSync(join(root, "index.html"), "utf8"), "<title>Team &quot;A&quot; &lt;b&gt;&amp;&lt;/b&gt;</title>");
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Team &quot;A&quot; &lt;b&gt;&amp;&lt;/b&gt;");
  assert.equal(readFileSync(join(root, "plain.txt"), "utf8"), "id=abc123");
  assert.deepEqual(readFileSync(join(root, "image.bin")), binary);
  assert.deepEqual([...result.keys].sort(), ["APP_TITLE", "PROJECT_ID"]);
});

test("an unsafe value for a file with no escaping rule is refused, naming the file and key, with nothing written", () => {
  for (const value of [`it's`, `a"b`, "a\\b", "a`b", "$(rm)", "<x>", "a\nb"]) {
    const root = fresh();
    put(root, "a.json", '{ "t": "{{APP_TITLE}}" }');
    put(root, "start.sh", "echo {{APP_TITLE}}");
    assert.throws(
      () => substitutePlaceholders(root, new Map([["APP_TITLE", value]]), new Set()),
      (err) => err instanceof PackageRefusedError && /start\.sh/.test(err.message) && /APP_TITLE/.test(err.message),
      JSON.stringify(value),
    );
    assert.equal(readFileSync(join(root, "a.json"), "utf8"), '{ "t": "{{APP_TITLE}}" }', "no file changes on a refusal");
  }
});

test("skipped files (the toolkit's system files) keep their bytes; tokens are listed", () => {
  const root = fresh();
  put(root, "server.mjs", "const t = '{{PROJECT_NAME}}';");
  put(root, "app.js", "const t = '{{PROJECT_NAME}}';");
  put(root, "node_modules/x.js", "{{IGNORED_TOKEN}}");
  assert.deepEqual(findPlaceholders(root, exclusionRules(root, null)), ["{{PROJECT_NAME}}"]);
  substitutePlaceholders(root, new Map([["PROJECT_NAME", "Kanban"]]), new Set(["server.mjs"]));
  assert.equal(readFileSync(join(root, "server.mjs"), "utf8"), "const t = '{{PROJECT_NAME}}';");
  assert.equal(readFileSync(join(root, "app.js"), "utf8"), "const t = 'Kanban';");
});

test("app folder names", () => {
  assert.equal(slugify("Kanban Board"), "kanban-board");
  assert.equal(slugify("  Café — Ünïcode!  "), "cafe-unicode");
  assert.equal(slugify("日本"), "app");
});

/* --------------------------------------------------------------- catalogue */

test("a catalogue is validated per entry; a bad entry is dropped, not the catalogue", () => {
  const { catalogue, warnings } = validateCatalogue({
    version: "1.0.0",
    apps: [
      { id: "good", name: "Good", folder: "good/", tags: ["a"] },
      { id: "no-folder", name: "x" },
      { id: "escape", name: "x", folder: "../outside" },
      { id: "bad-key", name: "x", folder: "f", customizable: [{ key: "lower", label: "x" }] },
      { id: "good", name: "Duplicate", folder: "dup" },
      "not an object",
    ],
  });
  assert.deepEqual(catalogue.apps.map((a) => a.id), ["good"]);
  assert.equal(catalogue.apps[0].folder, "good", "a trailing slash is dropped");
  assert.equal(warnings.length, 5);
  assert.throws(() => validateCatalogue({ apps: "nope" }), PackageRefusedError);
  assert.throws(() => validateCatalogue([]), PackageRefusedError);
});

test("compatibility comes only from what an entry lists", () => {
  assert.deepEqual(compatibility({ id: "a", name: "a", folder: "a" }), { compatible: null });
  assert.equal(compatibility({ id: "a", name: "a", folder: "a", livingUIVersion: 2 }).compatible, false);
  assert.equal(compatibility({ id: "a", name: "a", folder: "a", agentAppVersion: 2 }).compatible, false);
  assert.deepEqual(compatibility({ id: "a", name: "a", folder: "a", toolkit: "blueprint-react-node", agentAppVersion: "0.1.3" }), { compatible: true });
  const missing = compatibility({ id: "a", name: "a", folder: "a", toolkit: "blueprint-nope" });
  assert.equal(missing.compatible, false);
  assert.match(missing.reason, /blueprint-nope/);
  assert.equal(compatibility({ id: "a", name: "a", folder: "a", agentAppVersion: "0.2.0" }).compatible, false, "0.x minors are separate lines");
});

test("search: every word, case-insensitively, in id, name, description or tags", () => {
  const entry = { id: "kanban-online", name: "Kanban Online", description: "Multi-user board", folder: "k", tags: ["Productivity"] };
  assert.equal(matchesSearch(entry, []), true);
  assert.equal(matchesSearch(entry, ["KANBAN"]), true);
  assert.equal(matchesSearch(entry, ["board", "productivity"]), true);
  assert.equal(matchesSearch(entry, ["board", "invoice"]), false);
});

/* ----------------------------------------------------------------- sources */

test("sources parse by how they are written, then by what is on disk", () => {
  delete process.env["A2APP_MARKETPLACE_REF"];
  assert.deepEqual(parseFrom("github:CraftOS-dev/apps"), { kind: "github", owner: "CraftOS-dev", repo: "apps", ref: "main", path: [] });
  assert.deepEqual(parseFrom("github:o/r@dev/apps/kanban"), { kind: "github", owner: "o", repo: "r", ref: "dev", path: ["apps", "kanban"] });
  assert.deepEqual(parseFrom("https://github.com/o/r"), { kind: "github", owner: "o", repo: "r", ref: "main", path: [] });
  assert.deepEqual(parseFrom("https://github.com/o/r.git"), { kind: "github", owner: "o", repo: "r", ref: "main", path: [] });
  assert.deepEqual(parseFrom("https://github.com/o/r/tree/v2/apps/x"), { kind: "github", owner: "o", repo: "r", ref: "v2", path: ["apps", "x"] });
  assert.deepEqual(parseFrom("git+https://example.com/a/b.git#release"), { kind: "git", url: "https://example.com/a/b.git", ref: "release" });
  assert.deepEqual(parseFrom("git+ssh://git@example.com/a/b.git"), { kind: "git", url: "ssh://git@example.com/a/b.git", ref: null });
  const dir = fresh();
  put(dir, "pkg.zip", "PK");
  assert.deepEqual(parseFrom(dir), { kind: "folder", dir: resolve(dir) });
  assert.deepEqual(parseFrom(join(dir, "pkg.zip")), { kind: "zip", file: resolve(dir, "pkg.zip") });
  for (const bad of [
    "github:o",
    "github:o/r/../x",
    "github:o/r@../x",
    "github:o/r@-x",
    "git+--upload-pack=evil",
    "git+https://e.com/r#ref with space",
    "https://gitlab.com/o/r",
    "http://github.com/o/r",
    "https://github.com/o/r/blob/main/x",
    join(dir, "missing"),
  ]) {
    assert.throws(() => parseFrom(bad), UsageError, bad);
  }
  assert.throws(() => parseGithubShorthand("github:o/r/apps", false), UsageError, "a marketplace is a whole repository");
});

test("a package names its toolkit by bare id only, and never from inside itself", () => {
  assert.equal(isToolkitId("blueprint-react-node"), true);
  for (const bad of ["../evil", "./evil", "/abs/evil", "C:\\evil", "a/b", "..", "", 42]) assert.equal(isToolkitId(bad), false, String(bad));
  assert.equal(installedToolkit("../toolkits/blueprint-react-node"), null);
  const real = installedToolkit("blueprint-react-node");
  assert.ok(real !== null);
  // The same id, planted in a tree marked untrusted that is searched first.
  const planted = fresh();
  put(planted, "blueprint-react-node/a2app.toolkit.json", JSON.stringify({ id: "blueprint-react-node", systemPaths: [] }));
  const previous = process.env["A2APP_TOOLKITS_DIR"];
  process.env["A2APP_TOOLKITS_DIR"] = planted;
  try {
    assert.equal(resolveToolkit("blueprint-react-node").source, join(planted, "blueprint-react-node"), "searched first when trusted");
    assert.equal(installedToolkit("blueprint-react-node", [planted]).source, real.source, "skipped when untrusted");
  } finally {
    if (previous === undefined) delete process.env["A2APP_TOOLKITS_DIR"];
    else process.env["A2APP_TOOLKITS_DIR"] = previous;
  }
});

/* --------------------------------------------------------------- downloads */

test("downloads: user agent, redirects, sha256, and every bound enforced while streaming", async () => {
  const body = Buffer.from("archive bytes ".repeat(1000));
  let agent = null;
  const server = createServer((req, res) => {
    agent = req.headers["user-agent"];
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/file" });
      res.end();
    } else if (req.url === "/file") {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    } else if (req.url === "/chunked") {
      // No Content-Length: the cap has to be enforced as bytes arrive.
      res.writeHead(200);
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed || sent > 64 * 1024) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(Buffer.alloc(1024, 97));
        sent += 1024;
      }, 1);
      res.on("close", () => clearInterval(timer));
    } else if (req.url === "/declared-huge") {
      res.writeHead(200, { "content-length": String(600 * 1024 * 1024) });
      res.write("x");
    } else if (req.url === "/slow") {
      res.writeHead(200);
      res.write("x"); // then nothing
    } else if (req.url === "/busy") {
      res.writeHead(503);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const limits = { maxBytes: 1024 * 1024, timeoutMs: 10_000 };
  try {
    const dir = fresh();
    const got = await downloadToFile(`${origin}/redirect`, join(dir, "a.zip"), limits);
    assert.equal(got.bytes, body.length);
    assert.equal(got.sha256, createHash("sha256").update(body).digest("hex"));
    assert.deepEqual(readFileSync(join(dir, "a.zip")), body);
    assert.equal(agent, USER_AGENT);
    assert.match(USER_AGENT, /^agent-app\//);

    await assert.rejects(() => downloadToFile(`${origin}/chunked`, join(dir, "b.zip"), { maxBytes: 4096, timeoutMs: 10_000 }), (e) => e instanceof PackageRefusedError && /past the 4 KiB/.test(e.message));
    assert.throws(() => readFileSync(join(dir, "b.zip")), /ENOENT/, "a refused download leaves no file");
    await assert.rejects(() => downloadBytes(`${origin}/declared-huge`, { maxBytes: 512 * 1024 * 1024, timeoutMs: 10_000 }), (e) => e instanceof PackageRefusedError && /600 MiB/.test(e.message));
    await assert.rejects(() => downloadBytes(`${origin}/missing`, limits), SourceNotFoundError);
    await assert.rejects(() => downloadBytes(`${origin}/busy`, limits), SourceUnreachableError);
    await assert.rejects(() => downloadBytes(`${origin}/slow`, { maxBytes: 1024, timeoutMs: 300 }), (e) => e instanceof SourceUnreachableError && /did not finish/.test(e.message));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  // Nothing listening at all.
  const closed = createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  await assert.rejects(() => downloadBytes(`http://127.0.0.1:${port}/x`, limits), SourceUnreachableError);
});

/* ------------------------------------------------------------------- run */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${String(err?.stack ?? err).split("\n").join("\n    ")}`);
  }
}
rmSync(base, { recursive: true, force: true });
if (failed > 0) {
  console.error(`✗ package rules: ${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`✓ package rules: ${tests.length} passed`);
