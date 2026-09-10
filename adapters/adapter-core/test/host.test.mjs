/**
 * Host validation, exercised over a raw socket.
 *
 * This cannot live in the conformance suite: that harness drives the CLI and
 * fetch, and fetch forbids setting `Host` — the header this rule is about. A
 * rebinding attacker is a browser and sets it implicitly, so the only faithful
 * client here is one that writes the request itself.
 */
import { createServer, request } from "node:http";
import { createA2App, MemoryBinding } from "../dist/index.js";
import { a2appMiddleware } from "../dist/http.js";

const failures = [];
const check = (label, got, want) => {
  if (got !== want) failures.push(`${label}\n    expected: ${want}\n    actual:   ${got}`);
};

const app = createA2App(
  new MemoryBinding({
    appId: "host_test",
    appName: "Host Test",
    entities: { notes: { module: "desk", fields: [{ name: "title", type: "string", required: true }], seed: [] } },
  }),
  {
    modules: [{ name: "desk", summary: "notes" }],
    allowedOrigins: ["http://localhost:9931", "http://127.0.0.1:9931"],
  },
);

const mw = a2appMiddleware(app);
const server = createServer((req, res) =>
  mw(req, res, () => { res.writeHead(404); res.end("{}"); }),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const get = (hostHeader) =>
  new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/_a2app", method: "GET", headers: { host: hostHeader } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", () => resolve(-1));
    req.end();
  });

check("a rebound foreign host is refused", await get("evil.example.com"), 403);
check("a foreign host with the right port is still refused", await get(`evil.example.com:${port}`), 403);
check("the loopback address is served", await get(`127.0.0.1:${port}`), 200);
check("the loopback name is served", await get(`localhost:${port}`), 200);
check("an IPv6 loopback literal is served", await get(`[::1]:${port}`), 200);
check("another 127.x address is served", await get(`127.0.0.2:${port}`), 200);
// A host that only starts with an allowed name must not pass.
check("a lookalike host is refused", await get("localhost.evil.example.com"), 403);

server.close();

if (failures.length) {
  console.log(`host validation: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("host validation: all checks passed");
