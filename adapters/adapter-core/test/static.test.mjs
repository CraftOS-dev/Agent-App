/**
 * createStaticView — the cache-correctness contract.
 *
 * Every assertion here exists because its absence is silent: a missing validator
 * does not fail, it just serves last week's JavaScript to someone who reloaded
 * and believes they are looking at the new build. That is the failure this file
 * is here to stop coming back.
 *
 * Run: node test/static.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticView } from "../dist/static.js";

const dir = mkdtempSync(join(tmpdir(), "a2app-static-"));
const pub = join(dir, "public");
mkdirSync(pub);
writeFileSync(join(pub, "index.html"), "<!doctype html><p>one</p>");
writeFileSync(join(pub, "app.js"), "console.log(1)\n");
mkdirSync(join(pub, "sub"));
writeFileSync(join(pub, "sub", "deep.css"), "body{color:red}");
writeFileSync(join(dir, "outside.txt"), "not under public");
writeFileSync(join(dir, "mounted.js"), "export const x = 1\n");
writeFileSync(join(dir, "extra.mjs"), "export const schema = {}\n");

const view = createStaticView(pub, {
  aliases: { "/_a2app/update.js": join(dir, "mounted.js") },
  fingerprintPaths: [join(dir, "extra.mjs")],
  versionTtlMs: 0, // no reuse: every assertion below reads the tree as it is now
});

const server = createServer(view.handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (path, init) => fetch(`${base}${path}`, init);

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ------------------------------------------------------------- validators */

await check("every response carries ETag, Last-Modified and Cache-Control", async () => {
  const res = await get("/app.js");
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("etag"), "no ETag — a reload has nothing to revalidate against");
  assert.ok(res.headers.get("last-modified"), "no Last-Modified");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
});

await check("/ serves index.html", async () => {
  const res = await get("/");
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await res.text(), /one/);
});

await check("an unchanged asset is not re-downloaded (304, empty body)", async () => {
  const etag = (await get("/app.js")).headers.get("etag");
  const res = await get("/app.js", { headers: { "if-none-match": etag } });
  assert.equal(res.status, 304);
  assert.equal((await res.text()).length, 0);
  assert.ok(res.headers.get("etag"), "a 304 still carries the validator");
});

await check("a weak or wildcard If-None-Match also matches", async () => {
  const etag = (await get("/app.js")).headers.get("etag");
  assert.equal((await get("/app.js", { headers: { "if-none-match": `W/${etag}` } })).status, 304);
  assert.equal((await get("/app.js", { headers: { "if-none-match": "*" } })).status, 304);
  assert.equal((await get("/app.js", { headers: { "if-none-match": `"other", ${etag}` } })).status, 304);
});

await check("If-Modified-Since revalidates when no ETag is offered", async () => {
  const lm = (await get("/app.js")).headers.get("last-modified");
  assert.equal((await get("/app.js", { headers: { "if-modified-since": lm } })).status, 304);
});

await check("a CHANGED asset re-downloads even against its old validators", async () => {
  const before = await get("/app.js");
  const etag = before.headers.get("etag");
  const lm = before.headers.get("last-modified");
  writeFileSync(join(pub, "app.js"), "console.log(2) // the new build\n");
  const res = await get("/app.js", { headers: { "if-none-match": etag } });
  assert.equal(res.status, 200, "a stale ETag must NOT 304 — this is the stale tab");
  assert.match(await res.text(), /new build/);
  // The dangerous case: an edit inside the same second leaves Last-Modified
  // identical, so a timestamp-only server would answer 304 with the old bytes.
  // ETag compares content, so it does not.
  const same = new Date(lm);
  utimesSync(join(pub, "app.js"), same, same);
  assert.equal((await get("/app.js", { headers: { "if-none-match": etag } })).status, 200);
});

await check("HEAD answers with the headers and no body", async () => {
  const res = await get("/app.js", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("etag"));
  assert.equal((await res.text()).length, 0);
});

/* ----------------------------------------------------------- containment */

await check("a path outside the root is a 404, never a file", async () => {
  for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/sub/../../outside.txt", "/%ZZ"]) {
    const res = await get(path);
    assert.equal(res.status, 404, `${path} escaped containment (status ${res.status})`);
  }
});

await check("a directory is a 404, not a 500", async () => {
  assert.equal((await get("/sub")).status, 404);
});

await check("a sibling whose name merely starts with the root is not reachable", async () => {
  const sibling = createStaticView(join(dir, "pub"), {});
  const srv = createServer(sibling.handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/index.html`);
  assert.equal(res.status, 404, "…/public must not be served from a view rooted at …/pub");
  srv.close();
});

await check("static assets are GET-only", async () => {
  const res = await get("/app.js", { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

/* -------------------------------------------------------------- aliases */

await check("an alias serves a file from outside the View directory", async () => {
  const res = await get("/_a2app/update.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.ok(res.headers.get("etag"), "an aliased file is cached as carefully as any other");
  assert.match(await res.text(), /export const x/);
});

/* -------------------------------------------------------------- version */

await check("version() moves for a View change", async () => {
  const before = view.version();
  writeFileSync(join(pub, "app.js"), "console.log(3)\n");
  assert.notEqual(view.version(), before);
});

await check("version() moves for an added file and for a fingerprintPaths change", async () => {
  let before = view.version();
  writeFileSync(join(pub, "added.css"), "");
  assert.notEqual(view.version(), before, "an added (even empty) file is a change");
  before = view.version();
  writeFileSync(join(dir, "extra.mjs"), "export const schema = { entities: {} }\n");
  assert.notEqual(view.version(), before, "source folded in via fingerprintPaths counts");
  before = view.version();
  writeFileSync(join(dir, "mounted.js"), "export const x = 2\n");
  assert.notEqual(view.version(), before, "an aliased file is code the tab runs");
});

await check("version() does NOT move for a touch, or for a rewrite of identical bytes", async () => {
  const before = view.version();
  const t = new Date(Date.now() + 60_000);
  utimesSync(join(pub, "app.js"), t, t);
  assert.equal(view.version(), before, "a touch is not a new version");
  writeFileSync(join(pub, "app.js"), "console.log(3)\n");
  assert.equal(view.version(), before, "identical bytes are not a new version");
});

await check("version() is stable across reads and shaped av_…", async () => {
  assert.equal(view.version(), view.version());
  assert.match(view.version(), /^av_[0-9a-f]{16}$/);
});

await check("versionSalt separates two otherwise identical trees", async () => {
  const a = createStaticView(pub, { versionSalt: "0.1.0", versionTtlMs: 0 });
  const b = createStaticView(pub, { versionSalt: "0.2.0", versionTtlMs: 0 });
  assert.notEqual(a.version(), b.version());
});

server.close();
rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncreateStaticView: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ncreateStaticView: all checks passed");
