/**
 * A record write whose body is not a JSON object carries no fields: a create
 * misses its required fields, an update changes nothing — and neither reaches
 * the binding as a number or a string.
 */
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};

const TOKEN = "body-shape-token";
const app = createA2App(
  new MemoryBinding({ appId: "body_shape", appName: "Body Shape", entities: { notes: { module: "desk", fields: [{ name: "title", type: "string", required: true }], seed: [] } } }),
  { modules: [{ name: "desk" }], credentials: [{ token: TOKEN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }] },
);
const call = (method, path, body) => app.handle({ method, path, query: {}, headers: { "x-a2app-token": TOKEN }, body });

const note = (await call("POST", "/api/collections/notes/records", { title: "Kept" })).json;
for (const body of [5, true, "", [1, 2]]) {
  check(`a create with ${JSON.stringify(body)} misses its required fields`, (await call("POST", "/api/collections/notes/records", body)).json.code, "missing_required");
  const updated = await call("PATCH", `/api/collections/notes/records/${note.id}`, body);
  check(`an update with ${JSON.stringify(body)} changes nothing`, [updated.status, updated.json.title], [200, "Kept"]);
}

if (failures.length) {
  console.log(`body shape: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("body shape: all checks passed");
