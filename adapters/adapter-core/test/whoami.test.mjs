/**
 * whoami answers whoever the app will actually serve.
 *
 * The conformance suite covers the single-user side, where an uncredentialled
 * caller reads records and whoami must say so. The multi-user side cannot live
 * there: that harness boots one reference app, and it is `authMode: "none"`.
 * This is the other half — an app where refusing an uncredentialled caller is
 * the honest answer, so the 401 has to survive, and has to keep carrying the
 * `how` that tells the caller where a credential comes from.
 *
 * Standard library only, run directly.
 */
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => {
  if (!cond) failures.push(label);
};

const entities = {
  notes: { module: "desk", fields: [{ name: "title", type: "string", required: true }], seed: [] },
};
const operations = [
  { name: "count-notes", description: "Count them.", destructive: false, readOnly: true, module: "desk", params: {} },
  { name: "wipe-notes", description: "Delete them all.", destructive: true, module: "desk", params: {} },
];

const build = (authMode) =>
  createA2App(new MemoryBinding({ appId: "whoami_test", appName: "Whoami Test", entities, authMode }), {
    modules: [{ name: "desk", summary: "notes" }],
    operations,
    credentialHint: "Ask the owner.",
  });

const call = (app, path, headers = {}) =>
  app.handle({ method: "GET", path, headers, query: {}, body: undefined });

/* ------------------------------------------------- multi-user: 401 stands */

const multi = build("multi-user");
const refused = await call(multi, "/api/_a2app/whoami");
check("multi-user: an uncredentialled whoami is refused", refused.status, 401);
check("multi-user: with the credential code", refused.json.code, "agent_token_required");
check("multi-user: and the hint the write path sends", refused.json.how, "Ask the owner.");

/* ------------------------------------------- single-user: the truthful answer */

const single = build("none");
const answered = await call(single, "/api/_a2app/whoami");
check("single-user: an uncredentialled whoami is answered", answered.status, 200);
check("single-user: the caller is named as anonymous", answered.json.credentialId, "anonymous");
check("single-user: with no agent name to report", answered.json.agentName, null);

// The set matters, not the order: reads and the readOnly operation, and nothing
// that changes anything. Anything else here would be whoami promising a write
// that `authorize` goes on to refuse.
const scopes = answered.json.scopes;
ok("single-user: the entity is readable", scopes.includes("data:notes:read"));
ok("single-user: the readOnly operation is runnable", scopes.includes("op:count-notes"));
ok("single-user: the entity is NOT writable", !scopes.includes("data:notes:write"));
ok("single-user: the state-changing operation is NOT runnable", !scopes.includes("op:wipe-notes"));
check("single-user: nothing else is claimed", scopes.length, 2);

/* ------------------------------ whoami and describe cannot disagree */

// The whole point of deriving whoami's scopes from the same Access describe
// uses: one caller must not be told two different things about itself.
const described = await call(single, "/api/_a2app/describe");
check("describe agrees: the caller is read-only, not full", described.json.modules[0].access, "read-only");

/* ------------------------------------------- a credential still reports itself */

const withGrant = createA2App(
  new MemoryBinding({ appId: "whoami_test", appName: "Whoami Test", entities, authMode: "none" }),
  {
    modules: [{ name: "desk", summary: "notes" }],
    operations,
    credentials: [
      { token: "t_ro", credentialId: "cred_ro", agentName: "reader", principal: "owner", scopes: ["data:notes:read"] },
    ],
  },
);
const asGrant = await call(withGrant, "/api/_a2app/whoami", { "x-a2app-token": "t_ro" });
check("a credentialled caller reports its own grant", asGrant.status, 200);
check("by credential id", asGrant.json.credentialId, "cred_ro");
check("with its agent name", asGrant.json.agentName, "reader");
check("and exactly its granted scopes", asGrant.json.scopes, ["data:notes:read"]);

/* ---------------------------------------------------------------- report */

if (failures.length > 0) {
  console.error(`whoami: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("whoami: all checks passed");
