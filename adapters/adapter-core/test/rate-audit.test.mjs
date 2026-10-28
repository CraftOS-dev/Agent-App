/**
 * A rate-limit refusal is audited by caller, and the audit ring is persisted:
 * a token must appear there only as its hash, never as itself.
 */
import { createHash } from "node:crypto";
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};

const TOKEN = "a2a_rate_audit_token_secret_value_0123456789abc";
const app = createA2App(
  new MemoryBinding({ appId: "rate_audit", appName: "Rate Audit", entities: { notes: { module: "desk", fields: [{ name: "title", type: "string" }], seed: [] } } }),
  {
    modules: [{ name: "desk" }],
    rateLimits: { data: 1, ops: 1 },
    credentials: [{ token: TOKEN, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
  },
);
const get = () => app.handle({ method: "GET", path: "/api/collections/notes/records", query: {}, headers: { "x-a2app-token": TOKEN }, body: undefined });

await get();
check("the second request in the window is refused", (await get()).status, 429);
const entry = app.store.auditTail(5).find((e) => e.target === "rate:data");
check("the refusal is audited by the token's hash", entry?.credentialId, "token:" + createHash("sha256").update(TOKEN).digest("hex"));
check("…and the token itself is nowhere in the audit", JSON.stringify(app.store.auditTail(50)).includes(TOKEN), false);

if (failures.length) {
  console.log(`rate audit: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("rate audit: all checks passed");
