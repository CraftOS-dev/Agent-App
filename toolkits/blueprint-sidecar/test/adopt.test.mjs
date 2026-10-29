/**
 * Adopt a foreign app end to end, the way an agent following
 * reference/blueprint.md would, through the real CLIs:
 *
 *   scaffold --blueprint blueprint-sidecar → the app's source into upstream/ →
 *   sidecar.json, operations.json, modules (resealed) and the spec →
 *   validate → serve → `a2app <dir>` walks to the module and runs both
 *   operations → validate again, measuring the running app → stop.
 *
 * The foreign app (fixtures/notes-app) is a plain Node HTTP server with two
 * routes; it is never edited. Sign-in must work through the sidecar exactly as
 * on any other blueprint: on a single-user app and again on a multi-user one,
 * the account page is served and an agent gets its own credential with
 * `a2app <dir> login`, approved by the person, held to its scopes.
 *
 * No network: `npm install` resolves the sidecar from this repository (the
 * scaffold links it) and runs offline. Needs the CLI and @a2app/reverse-proxy
 * built (`pnpm -r build`).
 *
 * Run: node test/adopt.test.mjs
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const AGENT_APP = join(repo, "framework", "cli", "dist", "agent-app.js");
const A2APP = join(repo, "framework", "cli", "dist", "a2app.js");
const SIDECAR_BIN = join(repo, "adapters", "reverse-proxy", "dist", "bin.js");
const FIXTURE = join(here, "fixtures", "notes-app", "server.mjs");

for (const built of [AGENT_APP, A2APP, SIDECAR_BIN]) {
  if (!existsSync(built)) {
    console.error(`adopt: ${built} is not built — run \`pnpm -r build\` first`);
    process.exit(1);
  }
}

const failures = [];
let passed = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const root = mkdtempSync(join(tmpdir(), "a2app-adopt-"));
const home = join(root, "home");
const app = join(root, "notes");
mkdirSync(home);

// Nothing the calling shell exports about apps (a PORT, a token, a home) leaks
// in; a throwaway framework home, so this run registers nothing in the real
// one; no browser; npm offline, so the install below cannot reach a registry.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PORT$|A2APP_)/i.test(k))),
  A2APP_HOME: home,
  AGENT_APP_OPEN_CMD: "",
  npm_config_offline: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

function run(bin, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { env, cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const agentApp = (...args) => run(AGENT_APP, [app, ...args]);
const a2app = (...args) => run(A2APP, [app, ...args]);

/** The JSON document a command ends its stdout with. */
function resultOf(stdout) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.lastIndexOf("{");
  try {
    return start < 0 ? JSON.parse(stdout.trim()) : JSON.parse(lines.slice(start).join("\n"));
  } catch {
    return null;
  }
}

const writeJson = (file, value) => writeFileSync(join(app, file), JSON.stringify(value, null, 2) + "\n");
const readJson = (file) => JSON.parse(readFileSync(join(app, file), "utf8"));

const answers = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

/** Where the sidecar said the adopted app answers, in its latest boot. */
function upstreamUrl() {
  const lines = readFileSync(join(app, ".a2app", "serve.log"), "utf8").split(/\r?\n/);
  const started = lines.flatMap((l) => {
    try {
      const parsed = JSON.parse(l);
      return parsed.evt === "upstream" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  return started.at(-1)?.url ?? null;
}

/**
 * Whether the agent was refused an operation outside its scopes. The walk may
 * refuse it itself — a module screen fetched with the agent's credential does
 * not list what that credential cannot run — or, from a screen cached under
 * another credential, relay the app's refusal; both are refusals. The app's own
 * answer is then checked directly with the stored credential, whatever the
 * walk did.
 */
async function refused(base, operation, body) {
  const walked = await a2app("notes", operation, ...Object.entries(body).flatMap(([k, v]) => [`--${k}`, v]));
  ok(
    `the walk refuses ${operation} (${walked.all.trim().slice(-300)})`,
    walked.code === 1 && new RegExp(`does not hold op:${operation}|"${operation}" is not here`).test(walked.all),
  );
  const stored = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")).credentials.find((c) => c.origin === base);
  const direct = await fetch(`${base}/api/ops/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-a2app-token": stored.token },
    body: JSON.stringify(body),
  }).then(async (r) => [r.status, (await r.json()).code]);
  check(`…and so does the app (${operation})`, direct, [403, "insufficient_scope"]);
}

/** An agent signs in: `login`, the person approves on the account page (as
 *  `asPerson` headers), the agent finishes with the confirmation code. */
async function signInAgent(base, asPerson, scopes) {
  const started = await a2app("login", "--name", "notes agent", "--scopes", scopes, "--expires", "1d");
  const userCode = started.all.match(/approves code ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})/)?.[1];
  ok(`login asks the person to approve a code (${started.all.slice(-300)})`, started.code === 0 && userCode);
  ok("…on the account page served through the sidecar", started.all.includes(`${base}/_a2app/account#approve/`));
  const decided = await fetch(`${base}/api/_a2app/auth/device/${userCode}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...asPerson },
    body: JSON.stringify({ approve: true }),
  }).then((r) => r.json());
  check("the person approves it", decided.status, "approved");
  const confirmed = await a2app("login", "--confirm", decided.confirmation);
  check("the agent finishes with the confirmation code", confirmed.code, 0);
  return resultOf((await a2app("whoami")).stdout);
}

/** A spec an adopting agent writes: the launch and the operations, never the
 *  adopted app's own features. */
const REQUIREMENTS = `# Requirements: Notes

PART A — REQUIREMENTS (SRS).

## Introduction

### Purpose
A small notes server, adopted as-is: it keeps notes in memory, and agents add and find notes through the sidecar.

### Scope
**Goals**
1. The notes server runs unchanged from upstream/ behind the sidecar.
2. An agent can add a note and find notes by text.

**Core functionalities:** add note · find notes

### Approval
Approved by the user: 2026-10-29

## Product Description

### Product Perspective
A plain Node HTTP server, adopted unchanged; authMode none, a personal tool.

### User Characteristics
One person and the agents they send.

### Constraints
- C-1: upstream/ is never edited.

### Assumptions
- A-1: Volume ceiling: 60 calls per minute.

## Features

### Launch
- F-APP-1: The app starts from upstream/ behind the sidecar, and serve reports it up once GET /notes answers.

### Module: notes
- F-NOTES-1: The agent can add a note with add-note, which reaches POST /notes.
- F-NOTES-2: The agent can find notes by text with list-notes, which reaches GET /notes.

## Non-Functional Requirements
- N-1: Each operation answers within the sidecar's 30 s default.

## Data Requirements
- The app keeps its notes in memory; they are not mapped, and agents reach them only through the operations.

## External Interfaces
- **Human (browser):** the account page at /_a2app/account.
- **Agent (A2App):** module notes, operations exactly as declared in ## Operations Design; no entities.

## Out of Scope
- Changing the adopted app's code or features.

## Quality of Life
- None.

PART B — TECHNICAL SPECIFICATION.

## System Overview
Node HTTP server started as node server.mjs; module notes → add-note, list-notes.

## UI Design
- N/A — the adopted app has no UI, and adoption adds no screen.

## Quality Conformance
- **Q1 Completeness & IA:** one module, notes, for the app's one route prefix.
- **Q2 Design system:** N/A — no screen added.
- **Q3 Layout & composition:** N/A — no screen added.
- **Q4 Interaction:** no destructive operation.
- **Q5 State & feedback:** an agent gets each result or an error envelope.
- **Q6 Motion:** N/A — no screen added.
- **Q7 Content:** one-line descriptions; the app's refusals relayed as upstream_error.
- **Q8 Accessibility:** N/A — no screen added.
- **Q9 Responsiveness:** N/A — no screen added.
- **Q10 Performance:** in-memory; well inside the default timeout.
- **Q11 Caching & freshness:** no caching.
- **Q12 Data integrity:** text is a required string, checked before forwarding.
- **Q13 API:** adapter surface only.
- **Q14 Architecture:** upstream/ unchanged; sidecar.json maps the two operations.
- **Q15 Resilience:** health GET /notes; 503 when the app is down.
- **Q16 Security & privacy:** authMode none; loopback only.
- **Q17 Observability:** the sidecar's JSON log in .a2app/serve.log.
- **Q18 Version control:** one commit per mapping change.

### Conventions and overrides
None.

## Process Flows
None — the app's flows are its own.

## Operations Design
| Operation | Module | Route | Params | Flags |
| --- | --- | --- | --- | --- |
| add-note | notes | POST /notes | text | — |
| list-notes | notes | GET /notes | q? | readOnly |
`;

const TASKS = `# Tasks: Notes

## Build
- [x] T-1 (F-APP-1): The source is in upstream/, unchanged.
- [x] T-2 (F-NOTES-1): add-note declared and mapped.
- [x] T-3 (F-NOTES-2): list-notes declared and mapped.

## Verification
- [x] All build tasks ticked.
`;

let serving = false;
try {
  /* ------------------------------------------------------------ scaffold */

  const scaffolded = await agentApp("scaffold", "--blueprint", "blueprint-sidecar", "--name", "Notes", "--port", "8106");
  check(`scaffold from the blueprint (${scaffolded.stderr.slice(-400)})`, scaffolded.code, 0);
  const port = resultOf(scaffolded.stdout)?.port;
  const base = `http://127.0.0.1:${port}`;
  const canon = readJson(".a2app/system-hashes.json");
  check("the canon holds the system files", Object.keys(canon).sort(), ["a2app-account.html", "manifest.json"]);
  ok("the sidecar dependency is linked to this repository", readJson("package.json").dependencies["@a2app/reverse-proxy"].startsWith("file:"));
  check("the manifest's pipeline starts the sidecar", readJson("manifest.json").pipeline.start, "node node_modules/@a2app/reverse-proxy/dist/bin.js");

  /* --------------------------------------------------------------- adopt */

  mkdirSync(join(app, "upstream"));
  copyFileSync(FIXTURE, join(app, "upstream", "server.mjs"));
  writeJson("sidecar.json", {
    upstream: { command: ["node", "server.mjs"], cwd: "upstream", port: "auto", env: { PORT: "{port}" }, health: "/notes" },
    operations: {
      "list-notes": { method: "GET", path: "/notes" },
      "add-note": { method: "POST", path: "/notes" },
    },
  });
  writeJson("operations.json", {
    operations: [
      { name: "list-notes", description: "List the notes, or those containing q.", module: "notes", destructive: false, readOnly: true, idempotent: true, params: { q: { type: "string", description: "text to look for" } } },
      { name: "add-note", description: "Add a note.", module: "notes", destructive: false, params: { text: { type: "string", required: true } } },
    ],
  });
  const manifest = readJson("manifest.json");
  manifest.modules = [{ name: "notes", summary: "the notes the app keeps" }];
  writeJson("manifest.json", manifest);
  check("modules are resealed with toolkit-sync", (await agentApp("toolkit-sync")).code, 0);
  writeFileSync(join(app, "reference", "requirements.md"), REQUIREMENTS);
  writeFileSync(join(app, "reference", "tasks.md"), TASKS);

  const validated = await agentApp("validate");
  check(`validate passes the adoption (${validated.all.slice(-1500)})`, validated.code, 0);
  ok("…running the sidecar check as its gate step", /sidecar\.json valid; operations resolve/.test(validated.stderr));

  /* ---------------------------------------------------------------- serve */

  const served = await agentApp("serve");
  serving = served.code === 0;
  check(`serve brings it up (${served.all.slice(-1500)})`, served.code, 0);
  check("…at the app's own port", resultOf(served.stdout)?.url, base);
  const upstream = upstreamUrl();
  ok("…with the adopted app running behind it", upstream && (await answers(`${upstream}/notes`)));
  check("the foreign app's own code is untouched", readFileSync(join(app, "upstream", "server.mjs")).equals(readFileSync(FIXTURE)), true);

  /* ----------------------------------------------------------------- walk */

  const rootScreen = await a2app();
  check("a2app <dir> answers", rootScreen.code, 0);
  ok(`…listing the module with its two operations (${rootScreen.stdout})`, /notes\s+the notes the app keeps\s+0 entities, 2 ops/.test(rootScreen.stdout));
  const moduleScreen = await a2app("notes");
  ok(`the module screen lists both operations (${moduleScreen.stdout})`, /add-note/.test(moduleScreen.stdout) && /list-notes/.test(moduleScreen.stdout));
  const added = await a2app("notes", "add-note", "--text", "adopted as-is");
  check(`add-note runs at the module (${added.all})`, added.code, 0);
  check("…reaching the app, which stored the note", JSON.parse(added.stdout).result.text, "adopted as-is");
  const found = await a2app("notes", "list-notes", "--q", "adopted");
  check("list-notes runs at the module, with its query", JSON.parse(found.stdout).result.map((n) => n.text), ["adopted as-is"]);

  const measured = await agentApp("validate");
  check(`validate passes against the running app (${measured.all.slice(-1500)})`, measured.code, 0);
  check("…with nothing left unchecked", resultOf(measured.stdout)?.unchecked, []);

  /* --------------------------------------------- single-user sign-in */

  const page = await fetch(`${base}/_a2app/account`);
  check("the account page is served through the sidecar", [page.status, page.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  ok("…the framework's own page", (await page.text()) === readFileSync(join(app, "a2app-account.html"), "utf8"));

  // On a single-user app the person is the owner, at the app's own page.
  const reader = await signInAgent(base, { origin: base }, "op:list-notes");
  check("the agent acts for the owner, with the scopes approved", [reader?.principal, reader?.scopes], ["owner", ["op:list-notes"]]);
  check("…runs what they cover", (await a2app("notes", "list-notes")).code, 0);
  await refused(base, "add-note", { text: "not allowed" });
  check("logout revokes it", (await a2app("logout")).code, 0);

  /* ----------------------------------------------------------------- stop */

  check("stop ends the app", (await agentApp("stop")).code, 0);
  serving = false;
  check("…the sidecar is down", await answers(`${base}/api/_a2app`), false);
  check("…and the adopted app with it", await answers(`${upstream}/notes`), false);

  /* --------------------------------------------- multi-user sign-in */

  const multi = readJson("manifest.json");
  multi.authMode = "multi-user";
  writeJson("manifest.json", multi);
  check("switching to multi-user is resealed", (await agentApp("toolkit-sync")).code, 0);
  const reserved = await agentApp("serve");
  serving = reserved.code === 0;
  check(`serve brings the multi-user app up (${reserved.all.slice(-800)})`, reserved.code, 0);
  check("it says it is multi-user", (await fetch(`${base}/api/_a2app`).then((r) => r.json())).authMode, "multi-user");
  check("…and asks a stranger to sign in", (await fetch(`${base}/api/_a2app/session`).then((r) => r.json())).code, "sign_in_required");
  check("…on the account page", (await fetch(`${base}/_a2app/account`)).status, 200);

  const admin = { "content-type": "application/json", "x-a2app-token": readFileSync(join(app, ".agent-token"), "utf8").trim() };
  const invite = await fetch(`${base}/api/_a2app/invites`, { method: "POST", headers: admin, body: JSON.stringify({ role: "member" }) }).then((r) => r.json());
  const joined = await fetch(`${base}/api/_a2app/invites/${invite.code}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: "Mo", login: "mo", password: "a long enough password" }),
  });
  check("a person joins by invite", joined.status, 201);
  const mo = (await joined.json()).id;
  const session = { origin: base, cookie: joined.headers.get("set-cookie").split(";")[0] };

  const writer = await signInAgent(base, session, "op:add-note");
  check("the agent acts for the person who approved it", [writer?.principal, writer?.scopes], [mo, ["op:add-note"]]);
  const byAgent = await a2app("notes", "add-note", "--text", "from Mo's agent");
  check(`…runs what its scopes cover (${byAgent.all})`, byAgent.code, 0);
  check("…as an operation the app carried out", JSON.parse(byAgent.stdout).result.text, "from Mo's agent");
  await refused(base, "list-notes", {});

  const gated = await agentApp("validate");
  check(`validate passes the running multi-user app, sign-in on (${gated.all.slice(-1500)})`, gated.code, 0);
  check("…with nothing left unchecked", resultOf(gated.stdout)?.unchecked, []);

  check("logout revokes the agent's credential", (await a2app("logout")).code, 0);
  check("stop ends it again", (await agentApp("stop")).code, 0);
  serving = false;
} finally {
  if (serving) await agentApp("stop");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures.length) {
  console.log(`adopt: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log(`adopt: all ${passed} checks passed`);
