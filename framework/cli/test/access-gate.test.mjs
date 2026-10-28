/**
 * The access gate (`validate` on a running multi-user app): sign-in must be on,
 * and nothing may be readable without it. A backend route that answers a
 * stranger — a public collection rule — fails the gate, naming the entity.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { a2appMiddleware, createA2App, MemoryBinding } from "@a2app/adapter-core";

const here = dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(resolve(here, "..", "dist", "lib", p)).href;
const { runAccessGate } = await import(dist("gate.js"));
const { loadProject } = await import(dist("project.js"));
const ADMIN = "admin-token-access-gate";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const port = await new Promise((done) => {
  const s = createNetServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});
const app = createA2App(
  new MemoryBinding({ appId: "gate_app", appName: "Gate", authMode: "multi-user", entities: { notes: { module: "desk", fields: [{ name: "title", type: "string" }], seed: [] } } }),
  {
    modules: [{ name: "desk" }],
    credentials: [{ token: ADMIN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
  },
);

// `leak` stands in for a backend whose own routes skip sign-in (a PocketBase
// collection with public rules): records answer anyone, and there is no session.
let leak = false;
const mw = a2appMiddleware(app);
const server = createServer((req, res) => {
  const stranger = !req.headers["x-a2app-token"];
  if (leak && stranger && (req.url.startsWith("/api/collections/notes/records") || req.url === "/api/_a2app/session")) {
    const records = req.url.startsWith("/api/collections/");
    res.writeHead(records ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(records ? { items: [], page: 1 } : { code: "not_found" }));
    return;
  }
  mw(req, res, () => {
    res.writeHead(404);
    res.end("{}");
  });
});

function appDir(authMode) {
  const dir = mkdtempSync(join(tmpdir(), "a2app-access-gate-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "gate_app", name: "Gate", agentAppVersion: "0.1.0", adapterVersion: "0.1.0", authMode, modules: [{ name: "desk" }], pipeline: { install: "", build: "", start: "", health: "/api/_a2app" }, port }));
  writeFileSync(join(dir, ".agent-token"), ADMIN + "\n");
  return dir;
}
const multi = appDir("multi-user");
const single = appDir("none");

try {
  const down = await runAccessGate(loadProject(multi));
  check("an app that is not running is unchecked, not passed", [down.errors.length, down.unchecked.length], [0, 1]);

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  check("a multi-user app that requires sign-in passes", await runAccessGate(loadProject(multi)), { errors: [], unchecked: [] });

  leak = true;
  const leaky = await runAccessGate(loadProject(multi));
  check("one that lets strangers in fails", leaky.errors.length, 1);
  ok("…saying sign-in is not on", /sign-in is not on/.test(leaky.errors[0]?.message));
  ok("…and naming the entity anyone can read", /anyone can read "notes"/.test(leaky.errors[0]?.message));

  check("a single-user app is not asked to sign anyone in", await runAccessGate(loadProject(single)), { errors: [], unchecked: [] });
} finally {
  server.close();
  rmSync(multi, { recursive: true, force: true });
  rmSync(single, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`access gate: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("access gate: all checks passed");
