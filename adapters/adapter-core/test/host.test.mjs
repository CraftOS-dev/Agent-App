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

/* ------------------------------------------- reached at a public URL (#39) */

// Behind a TLS proxy the app receives its public name in Host, and the View's
// requests carry the public origin. Both must be the app's own — and nothing
// else becomes so.
const proxied = createA2App(
  new MemoryBinding({
    appId: "host_public",
    appName: "Host Public",
    entities: { notes: { module: "desk", fields: [{ name: "title", type: "string", required: true }], seed: [] } },
  }),
  {
    modules: [{ name: "desk", summary: "notes" }],
    allowedOrigins: ["http://127.0.0.1:9932"],
    publicUrl: "https://crm.example.com",
  },
);
const ask = async (headers, method = "GET") =>
  (await proxied.handle({ method, path: method === "GET" ? "/api/_a2app" : "/api/collections/notes/records", query: {}, headers, body: { title: "x" } }))
    .status;
check("the public host is served", await ask({ host: "crm.example.com" }), 200);
check("…with an explicit port too", await ask({ host: "crm.example.com:443" }), 200);
check("another host is still refused", await ask({ host: "evil.example.com" }), 403);
check("the public origin is the app's own (View write)", await ask({ host: "crm.example.com", origin: "https://crm.example.com" }, "POST"), 200);
check("an http origin on the public name is not", await ask({ host: "crm.example.com", origin: "http://crm.example.com" }, "POST"), 403);

/* -------------------------------------------------------- networkPolicy */

const { networkPolicy } = await import("../dist/index.js");
const refused = (env) => {
  try {
    networkPolicy(env);
    return false;
  } catch {
    return true;
  }
};
check("loopback by default", JSON.stringify(networkPolicy({})), JSON.stringify({ host: "127.0.0.1", publicUrl: null }));
check("an https public URL is reduced to its origin", networkPolicy({ publicUrl: "https://crm.example.com/some/path" }).publicUrl, "https://crm.example.com");
check("a non-loopback bind needs a public URL", refused({ host: "0.0.0.0" }), true);
check("…an https one", refused({ host: "0.0.0.0", publicUrl: "http://localhost:8080" }), true);
check("a non-loopback bind behind https is allowed", refused({ host: "0.0.0.0", publicUrl: "https://crm.example.com" }), false);
check("a plain-http public name is refused", refused({ publicUrl: "http://crm.example.com" }), true);
check("a plain-http tunnel to loopback is allowed", refused({ publicUrl: "http://localhost:9000" }), false);
check("a public URL that is not a URL is refused", refused({ publicUrl: "crm.example.com" }), true);
check("…nor an http(s) one", refused({ publicUrl: "ftp://crm.example.com" }), true);

if (failures.length) {
  console.log(`host validation: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("host validation: all checks passed");
