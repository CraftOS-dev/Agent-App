/**
 * The Agent Apps tab's backend, as OpenClaw drives it, against the starter's
 * fake CLIs (copied as `agent-app.mjs` and `a2app.mjs`) in a throwaway home.
 *
 * OpenClaw's plugin SDK resolves only inside OpenClaw, so the plugin is
 * bundled here with esbuild (the build's own tool) against a stand-in for
 * `definePluginEntry`, then registered with a fake of the API surface it uses.
 * The routes are called the way the gateway calls them: a request stream and
 * a response object.
 *
 * Pinned: the page carries the install steps and its script parses; the
 * marketplace and import routes (catalogue, inspect, upload, install jobs);
 * a source that is not a package going to the importer skill in a new app's
 * session; and Connect (the sign-in job, its confirmation, a connected app's
 * row and session, disconnect).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "a2app-openclaw-"));
for (const name of ["agent-app", "a2app"]) copyFileSync(resolve(here, "../../integration-starter/test/fake-cli.mjs"), join(base, `${name}.mjs`));
Object.assign(process.env, {
  A2APP_HOME: join(base, "home"),
  AGENT_APP_CLI: join(base, "agent-app.mjs"),
  A2APP_CLI: join(base, "a2app.mjs"),
  TMPDIR: base,
  TEMP: base,
  TMP: base,
});

// The plugin, bundled against a stand-in SDK.
const sdk = join(base, "plugin-entry.mjs");
writeFileSync(sdk, "export const definePluginEntry = (entry) => entry;\n");
const bundle = join(base, "plugin.mjs");
await build({
  entryPoints: [resolve(here, "../src/index.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "error",
  banner: { js: "import { createRequire as __a2appCreateRequire } from 'node:module';\nconst require = __a2appCreateRequire(import.meta.url);" },
  plugins: [{ name: "openclaw-sdk", setup: (b) => b.onResolve({ filter: /^openclaw\/plugin-sdk\// }, () => ({ path: sdk })) }],
});
const entry = (await import(pathToFileURL(bundle).href)).default;

// The API surface the plugin registers into.
const routes = new Map();
const hooks = new Map();
const runs = [];
entry.register({
  logger: { info() {}, warn() {} },
  on: (hook, fn) => hooks.set(hook, fn),
  registerCommand() {},
  registerCli() {},
  registerHttpRoute: (route) => routes.set(route.path, route),
  session: { controls: { registerControlUiDescriptor() {} } },
  runtime: {
    subagent: {
      run: async (p) => {
        runs.push(p);
        return { runId: `run-${runs.length}` };
      },
      waitForRun: () => new Promise(() => {}), // the agent is still working
      getSessionMessages: async () => ({ messages: [] }),
      deleteSession: async () => {},
    },
  },
});
hooks.get("gateway_start")();

/** Call a route as the gateway does: a request stream, a response that records what was sent. */
async function call(path, { method = "GET", body, raw, token, headers = {} } = {}) {
  const route = [...routes.values()].find((r) => path.startsWith(r.path));
  const data = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0));
  const req = Readable.from(data.length ? [data] : []);
  Object.assign(req, { method, url: path, headers: { ...(token ? { "x-a2app-token": token } : {}), "content-length": String(data.length), ...headers } });
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.text = String(text ?? ""); },
  };
  await route.handler(req, res);
  return { status: res.statusCode, headers: res.headers, text: res.text, json: res.headers["content-type"] === "application/json" ? JSON.parse(res.text) : null };
}

try {
  // The page: a fresh token, the install steps, and a script that parses.
  const page = await call("/agent-app/home");
  assert.equal(page.status, 200);
  const cfg = JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(page.text)[1]);
  assert.deepEqual(cfg.steps.slice(0, 2), ["acquire", "inspect"]);
  assert.equal(cfg.steps.length, 11);
  assert.ok(cfg.blueprints.includes("blueprint-sidecar"));
  const script = /<script>\n([\s\S]*)<\/script><\/body>/.exec(page.text)[1];
  assert.doesNotThrow(() => new Function(script), "the page's script parses");
  for (const panel of ["Marketplace", "Import", "/catalogue?search=", "/install?job=", "/import/agent", "/upload", "Connect", "/connect?job=", "/connect/confirm", "/app/disconnect", "embed: !OPAQUE"]) {
    assert.ok(script.includes(panel), `the page has ${panel}`);
  }
  const token = cfg.token;
  const api = (path, opts = {}) => call(`/agent-app/api${path}`, { token, ...opts });

  assert.equal((await call("/agent-app/api/catalogue")).status, 401, "the API needs the page's token");

  // Marketplace.
  let r = await api("/catalogue?search=kanban");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.argv, ["catalogue", "--search", "kanban"]);
  r = await api("/catalogue?source=unreachable");
  assert.deepEqual([r.status, r.json.ok], [502, false]);

  // Import: inspect, upload, install as a job.
  r = await api("/inspect", { method: "POST", body: { from: "./foreign-site" } });
  assert.deepEqual([r.json.report.kind, r.json.report.routes], ["foreign", ["adopt", "convert"]]);
  r = await api("/upload", { method: "POST", raw: Buffer.from("PK\u0003\u0004zip"), headers: { "content-type": "application/zip" } });
  assert.equal(r.status, 200);
  const file = r.json.file;
  assert.ok(existsSync(file));
  r = await api("/upload", { method: "POST", raw: Buffer.from("x"), headers: { "content-length": String(600 * 1024 * 1024) } });
  assert.deepEqual([r.status, r.headers.connection], [413, "close"], "a declared size over the limit is refused unread");
  r = await api("/install", { method: "POST", body: { from: file, name: "Board" } });
  assert.equal(r.status, 200);
  let job = r.json.job;
  while (!job.done) {
    await new Promise((d) => setTimeout(d, 20));
    job = (await api(`/install?job=${job.id}`)).json.job;
  }
  assert.deepEqual([job.ok, job.result.name, job.result.trust], [true, "Board", "untrusted"]);
  assert.equal(job.steps.length, 11);
  assert.ok(!existsSync(file), "the upload is removed once installed");
  assert.equal((await api("/install?job=nope")).status, 404);

  // A source that is not a package goes to the importer skill, in a new app's session.
  r = await api("/import/agent", { method: "POST", body: { action: "adopt", from: "./foreign-site" } });
  assert.deepEqual([r.status, r.json.message], [400, "Give the app a name."]);
  r = await api("/import/agent", { method: "POST", body: { action: "adopt", from: "./foreign-site", name: "Old Site" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.path, join(base, "home", "apps", "old-site"));
  await new Promise((d) => setTimeout(d, 600)); // the run is queued for the plugin's runner
  assert.equal(runs.length, 1);
  assert.match(runs[0].message, /^Adopt the app at `\.\/foreign-site` as an Agent App/);
  assert.match(runs[0].message, /\*\*importer\*\* skill/);
  assert.ok(runs[0].message.endsWith(`Create the app at \`${r.json.path}\` — pass that directory to every agent-app command.`));
  assert.equal(runs[0].sessionKey, "subagent:agent-app:old-site");
  r = await api("/apps");
  assert.deepEqual(r.json.rows.map((row) => [row.name, row.building]), [["Old Site", true]]);
  r = await api("/import/agent", { method: "POST", body: { action: "import", id: "kanban-online", source: "github:acme/market@main", name: "Old Site" } });
  assert.match(r.json.message, /already being built/);
  r = await api("/import/agent", { method: "POST", body: { action: "import", id: "kanban-online", source: "github:acme/market@main", name: "Kanban" } });
  assert.equal(r.status, 200);
  await new Promise((d) => setTimeout(d, 600));
  assert.match(runs[1].message, /^Convert the marketplace app `kanban-online` from the marketplace `github:acme\/market@main` into a new Agent App\./);

  // Connect: an app on another machine, approved in its own tab, then a tab and a session of its own.
  const CRM = "http://127.0.0.1:8191";
  assert.equal((await api("/connect", { method: "POST", body: { url: "./my-folder" } })).status, 400, "an address, never a folder");
  r = await api("/connect", { method: "POST", body: { url: `${CRM}/board`, here: true } });
  assert.equal(r.status, 200);
  job = r.json.job;
  while (!job.done) {
    await new Promise((d) => setTimeout(d, 20));
    job = (await api(`/connect?job=${job.id}`)).json.job;
  }
  assert.deepEqual([job.origin, job.ok, job.pending, job.embedded, job.approve.userCode], [CRM, true, true, true, "BCDF-GHJK"]);
  r = await api("/connect/confirm", { method: "POST", body: { url: CRM, code: "GOOD-CODE" } });
  assert.deepEqual([r.status, r.json.result.principalName], [200, "Bob"]);
  r = await api("/connect", { method: "POST", body: { url: CRM, here: true, embed: false } });
  assert.equal(r.json.job.embedded, false, "a frame with no real origin approves in the browser");

  process.env.FAKE_REGISTRY = join(base, "registry.json");
  writeFileSync(process.env.FAKE_REGISTRY, JSON.stringify({ ok: true, apps: [], connected: [
    { origin: CRM, appId: "crm", name: "Team CRM", principal: "usr_bob", principalName: "Bob", expiresAt: null, status: "online" },
  ] }));
  r = await api("/apps");
  const remote = r.json.rows.find((row) => row.remote);
  assert.deepEqual([remote.path, remote.url, remote.status, remote.principalName, remote.embeddable], [CRM, CRM, "online", "Bob", true]);
  r = await api("/session/send", { method: "POST", body: { path: CRM, name: "Team CRM", text: "How many open deals?" } });
  assert.equal(r.status, 200);
  await new Promise((d) => setTimeout(d, 600));
  const crmRun = runs.at(-1);
  assert.equal(crmRun.sessionKey, "subagent:agent-app:127.0.0.1-8191", "keyed by its host, no colon inside the last part");
  assert.equal(crmRun.cwd, join(base, "home", "apps"));
  assert.match(crmRun.message, /^You are working with the Agent App "Team CRM" at http:\/\/127\.0\.0\.1:8191, on another machine/);
  assert.ok(crmRun.message.endsWith("How many open deals?"));
  assert.equal((await api("/app/disconnect", { method: "POST", body: { path: "https://other.example.com" } })).status, 404);
  assert.equal((await api("/app/disconnect", { method: "POST", body: { path: CRM } })).status, 200);
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("✓ openclaw: the page's panels parse; catalogue, inspect, upload and install jobs over the CLI; convert and adopt hand off to the importer skill; connect, a connected app's tab and session, disconnect");
// The plugin's run queue keeps an interval for the gateway's lifetime.
process.exit(0);
