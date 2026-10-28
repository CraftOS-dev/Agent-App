/**
 * The user ceiling and the credential store (spec/v0_2/auth.md §2–3, §9):
 * tokens are kept only as hashes, every request is limited to the credential's
 * scopes intersected with what its person may do now, and a credential that
 * stopped working says why.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const ORIGIN = "http://127.0.0.1:9951";
const ADMIN = "admin-token-ceiling";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const dir = mkdtempSync(join(tmpdir(), "a2app-ceiling-"));
const storePath = join(dir, "state.json");

function makeApp(adminToken = ADMIN) {
  return createA2App(
    new MemoryBinding({
      appId: "ceiling",
      appName: "Ceiling",
      authMode: "multi-user",
      entities: {
        notes: {
          module: "desk",
          ownedBy: "owner",
          fields: [
            { name: "title", type: "string", required: true },
            { name: "owner", type: "string", readOnly: true },
          ],
          seed: [],
        },
      },
    }),
    {
      modules: [{ name: "desk" }],
      allowedOrigins: [ORIGIN],
      storePath,
      credentials: [{ token: adminToken, credentialId: "cred_local", agentName: "local", principal: "owner", scopes: ["*"], admin: true }],
      // Members may read and nothing else; owners may do everything.
      permissionsOf: (p) => (p.role === "owner" ? ["*"] : ["data:notes:read"]),
    },
  );
}

let app = makeApp();
const call = (method, path, headers = {}, body) => app.handle({ method, path, query: {}, headers, body });
const as = (token) => ({ "x-a2app-token": token });

/** An account, made the way the app makes them: invite, then accept. */
async function account(name, role) {
  const invite = (await call("POST", "/api/_a2app/invites", as(ADMIN), { role })).json;
  const accepted = await call("POST", `/api/_a2app/invites/${invite.code}`, { origin: ORIGIN }, { name, login: name.toLowerCase(), password: "a long enough password" });
  return { id: accepted.json.id, cookie: accepted.headers["set-cookie"].split(";")[0] };
}

/** A credential placed straight in the store (minting comes with #34). */
function credential(token, principal, extra = {}) {
  const id = `cred_${principal}_${Object.keys(extra).join("_") || "plain"}_${token.length}`;
  app.store.putGrant({
    credentialId: id,
    tokenHash: sha(token),
    principal,
    agentName: "test agent",
    scopes: ["*"],
    createdAt: new Date().toISOString(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    task: null,
    admin: false,
    ...extra,
  });
  return id;
}

const alice = await account("Alice", "owner");
const bob = await account("Bob", "member");

/* ------------------------------------------------------- hashed at rest */

const disk = readFileSync(storePath, "utf8");
ok("the admin token is not on disk", !disk.includes(ADMIN));
ok("…its hash is", disk.includes(sha(ADMIN)));

/* ------------------------------------------------- refusals, by reason */

check("an unknown token is refused, even for a read", (await call("GET", "/api/collections/notes/records", as("nonsense"))).json.code, "credential_invalid");
const revokedId = credential("tok-revoked", bob.id, { revokedAt: new Date().toISOString() });
check("a revoked credential says so", (await call("GET", "/api/collections/notes/records", as("tok-revoked"))).json.code, "credential_revoked");
credential("tok-expired", bob.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
const expired = await call("GET", "/api/collections/notes/records", as("tok-expired"));
check("an expired credential says so", [expired.status, expired.json.code], [401, "token_expired"]);
ok("…and how to get a new one", typeof expired.json.how === "string" && expired.json.how.includes("login"));

const task = app.store.enqueueTask({ event: null, capability: "triage", payload: { n: 1 } });
credential("tok-task", alice.id, { task: task.id });
check("a task credential works while its task is open", (await call("GET", "/api/collections/notes/records", as("tok-task"))).status, 200);
app.store.saveTask({ ...task, status: "completed" });
check("…and is revoked once the task is over", (await call("GET", "/api/collections/notes/records", as("tok-task"))).json.code, "credential_revoked");
check("a credential for a principal that never existed is refused", (await call("GET", "/api/collections/notes/records", as((credential("tok-ghost", "usr_nobody"), "tok-ghost")))).json.code, "principal_inactive");

/* --------------------------------------------------------- the ceiling */

credential("tok-bob", bob.id, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
check("a member's agent may read", (await call("GET", "/api/collections/notes/records", as("tok-bob"))).status, 200);
const write = await call("POST", "/api/collections/notes/records", as("tok-bob"), { title: "x" });
check("…but a `*` grant cannot exceed its person", [write.status, write.json.code], [403, "insufficient_scope"]);
const who = (await call("GET", "/api/_a2app/whoami", as("tok-bob"))).json;
check("whoami reports the effective scopes", who.scopes, ["data:notes:read"]);
check("…the person", [who.principal, who.principalName, who.role], [bob.id, "Bob", "member"]);
ok("…and when the credential expires", typeof who.expiresAt === "string" && Date.parse(who.expiresAt) > Date.now());
check("the person is held to it too", (await call("POST", "/api/collections/notes/records", { origin: ORIGIN, cookie: bob.cookie }, { title: "x" })).json.code, "insufficient_scope");
ok("use is recorded", app.store.grantById(credentialIdOf("tok-bob"))?.lastUsedAt !== null);

/* -------------------------------------------------- whose records */

credential("tok-alice", alice.id);
const aliceNote = (await call("POST", "/api/collections/notes/records", as("tok-alice"), { title: "Alice's note" })).json;
check("an agent acting for Alice writes as Alice", aliceNote.owner, alice.id);
check("an agent acting for Bob cannot read Alice's records", (await call("GET", `/api/collections/notes/records/${aliceNote.id}`, as("tok-bob"))).status, 404);
check("…or list them", (await call("GET", "/api/collections/notes/records", as("tok-bob"))).json.items.length, 0);

/* --------------------------------------------------- deactivation */

await call("PATCH", `/api/_a2app/users/${bob.id}`, { origin: ORIGIN, cookie: alice.cookie }, { active: false });
check("deactivating Bob stops his agent on the next request", (await call("GET", "/api/collections/notes/records", as("tok-bob"))).json.code, "principal_inactive");
await call("PATCH", `/api/_a2app/users/${bob.id}`, { origin: ORIGIN, cookie: alice.cookie }, { active: true });
check("…and reactivating him restores it", (await call("GET", "/api/collections/notes/records", as("tok-bob"))).status, 200);

/* ------------------------------------------------------- managers */

check("an agent's credential is not a manager", (await call("GET", "/api/_a2app/users", as("tok-alice"))).json.code, "not_a_manager");
check("the admin credential is", (await call("GET", "/api/_a2app/users", as(ADMIN))).status, 200);

/* ---------------------------------------- restart, rotation, legacy */

app = makeApp("rotated-admin-token");
check("credentials survive a restart", (await call("GET", "/api/collections/notes/records", as("tok-alice"))).status, 200);
check("…and so does a revocation", (await call("GET", "/api/collections/notes/records", as("tok-revoked"))).json.code, "credential_revoked");
check("a rotated .agent-token replaces the old one", (await call("GET", "/api/_a2app/users", as(ADMIN))).json.code, "credential_invalid");
check("…with the new one in force", (await call("GET", "/api/_a2app/users", as("rotated-admin-token"))).status, 200);

const legacy = JSON.parse(readFileSync(storePath, "utf8"));
legacy.grants.push({ token: "legacy-plaintext", credentialId: "cred_legacy", agentName: "old", principal: "owner", scopes: ["*"] });
writeFileSync(storePath, JSON.stringify(legacy));
app = makeApp("rotated-admin-token");
check("a pre-0.2 plaintext grant is not carried over", (await call("GET", "/api/collections/notes/records", as("legacy-plaintext"))).json.code, "credential_invalid");
ok("…nor written back to disk", !readFileSync(storePath, "utf8").includes("legacy-plaintext"));
check("revoked credentials are listed nowhere they could be reused", app.store.grantById(revokedId)?.revokedAt !== null, true);

function credentialIdOf(token) {
  return app.store.grantByTokenHash(sha(token))?.credentialId;
}

rmSync(dir, { recursive: true, force: true });

if (failures.length) {
  console.log(`ceiling: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("ceiling: all checks passed");
