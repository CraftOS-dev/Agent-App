/**
 * A miss inside the adapter's namespaces is the adapter's to answer; the rest of
 * /api/ stays the host's.
 *
 * Wired the way a blueprint wires it — the adapter first, the static View as the
 * fallthrough — because the contract lives in the seam between the two.
 *
 * Run: node test/unknown-route.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createA2App, MemoryBinding, createStaticView } from "../dist/index.js";
import { a2appMiddleware, createA2AppServer } from "../dist/http.js";

const dir = mkdtempSync(join(tmpdir(), "a2app-unknown-route-"));
writeFileSync(join(dir, "index.html"), "<!doctype html><p>view</p>");

const app = createA2App(
  new MemoryBinding({
    appId: "unknown_route_test",
    appName: "Unknown Route Test",
    entities: { notes: { module: "desk", fields: [{ name: "title", type: "string" }], seed: [] } },
  }),
  { modules: [{ name: "desk", summary: "notes" }] },
);

const server = createA2AppServer(app, createStaticView(dir).handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const send = (method, path) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: "{}" }),
  });

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

await check("POST to an unknown /api/_a2app route is a 404 that names the real routes", async () => {
  const res = await send("POST", "/api/_a2app/operate");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, "not_found");
  assert.equal(body.ok, false);
  assert.match(body.message, /POST \/api\/ops\/<name>/);
  assert.match(body.message, /\/api\/_a2app\/describe/);
});

await check("the adapter, not the View, answers every miss under its namespaces", async () => {
  const paths = ["/api/_a2app/does-not-exist", "/api/ops", "/api/ops/a/b", "/api/collections/notes", "/api/collections"];
  for (const path of paths) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const res = await send(method, path);
      assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`);
      // The View's 404 has the same code; only the adapter's names the routes.
      assert.match((await res.json()).message, /\/api\/_a2app\/describe/, `${method} ${path}`);
    }
  }
});

await check("the routes that exist still answer", async () => {
  assert.equal((await send("GET", "/api/_a2app/describe")).status, 200);
  assert.equal((await (await send("POST", "/api/ops/nope")).json()).code, "unknown_operation");
});

await check("a POST to a real static file is still a 405", async () => {
  const res = await send("POST", "/index.html");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

await check("the rest of /api/ is still the host's", async () => {
  const mw = a2appMiddleware(app);
  const host = createServer((req, res) =>
    mw(req, res, () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ host: true }));
    }),
  );
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${host.address().port}/api/custom`, { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).host, true);
  } finally {
    host.close();
  }
});

server.close();
rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nunknown route: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nunknown route: all checks passed");
