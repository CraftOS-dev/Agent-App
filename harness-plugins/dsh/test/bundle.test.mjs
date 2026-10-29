/**
 * The dsh bundle's host half, as dsh drives it, against the starter's fake
 * CLIs (copied as `agent-app.mjs` and `a2app.mjs`) in a throwaway home.
 *
 * dsh's packages resolve only inside dsh's toolchain, so the host half is
 * bundled here with esbuild (the build's own tool) against stand-ins for
 * `defineTool` and `createUserMessage`, and `apply(ctx)` runs against a fake of
 * the Cordis context it uses: tools, logger, effects, and the late `webServer`
 * injection that mounts the manager.
 *
 * Pinned: every tool is run by the engine's tool of the same name (so each
 * reaches the binary that owns it, never one guessed from its argv); the
 * manager page carries its panels; and the marketplace and import routes, with
 * a source that is not a package going to the importer skill in a new app's
 * session.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "a2app-dsh-"));
for (const name of ["agent-app", "a2app"]) copyFileSync(resolve(here, "../../integration-starter/test/fake-cli.mjs"), join(base, `${name}.mjs`));
Object.assign(process.env, {
  A2APP_HOME: join(base, "home"),
  AGENT_APP_CLI: join(base, "agent-app.mjs"),
  A2APP_CLI: join(base, "a2app.mjs"),
  TMPDIR: base,
  TEMP: base,
  TMP: base,
});

// The host half, bundled against stand-ins for dsh's own packages.
const stubs = {
  "@deepseek-ai/dsh-tools": "export const defineTool = (tool) => tool;\n",
  "@deepseek-ai/dsh-llm": "export const createUserMessage = (message) => message;\n",
};
const stubFiles = {};
for (const [name, code] of Object.entries(stubs)) {
  stubFiles[name] = join(base, `${name.split("/")[1]}.mjs`);
  writeFileSync(stubFiles[name], code);
}
const bundle = join(base, "host.mjs");
await build({
  entryPoints: [resolve(here, "../src/index.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "error",
  banner: { js: "import { createRequire as __a2appCreateRequire } from 'node:module';\nconst require = __a2appCreateRequire(import.meta.url);" },
  plugins: [{ name: "dsh", setup: (b) => b.onResolve({ filter: /^@deepseek-ai\/dsh-(tools|llm)$/ }, (a) => ({ path: stubFiles[a.path] })) }],
});
const host = await import(pathToFileURL(bundle).href);

// The Cordis context `apply` uses, and the dsh services the manager reads.
const tools = new Map();
const routes = [];
const followups = [];
const agents = new Map();
const services = {
  agents: {
    get: (sessionId) => agents.get(sessionId),
    async create({ sessionId }) {
      const agent = { followup: (message) => followups.push({ sessionId, text: message.content[0].text }), steer() {} };
      agents.set(sessionId, agent);
      return { agent, dispose() {} };
    },
    resume: async () => assert.fail("no session exists yet"),
  },
  sessions: { get: () => undefined },
};
const scoped = { get: (name) => services[name], webServer: { register: (route) => (routes.push(route), () => {}) } };
host.apply({
  logger: { info() {}, warn() {} },
  tools: { register: (tool) => tools.set(tool.name, tool) },
  effect: (fn) => fn(),
  inject: (deps, fn) => (deps.includes("webServer") ? fn(scoped) : undefined),
});

/** Call a manager route as dsh's web server does. */
async function call(path, { method = "GET", body, raw, token, headers = {} } = {}) {
  const route = routes.find((r) => path.startsWith(r.path));
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
const run = async (name, args) => JSON.parse(await tools.get(name).execute(args));

try {
  /* ── The tools ── */
  assert.equal(tools.size, 19, "the 14 build+operate tools and 5 for packages");
  for (const name of ["agent_app_list_apps", "agent_app_catalogue", "agent_app_inspect", "agent_app_install", "agent_app_export"]) assert.ok(tools.has(name), name);
  for (const tool of tools.values()) {
    for (const [key, spec] of Object.entries(tool.parameters)) {
      if (spec.type === "object") assert.equal(spec.additionalProperties, true, `${tool.name}.${key}: dsh's DSL wants additionalProperties on an object`);
    }
  }
  // Each reaches the binary that owns it: an app module named like a build verb is still operated with a2app.
  let out = await run("agent_app_describe", { dir: "./crm", path: "validate/runs" });
  assert.deepEqual([out.bin, out.argv], ["a2app", ["./crm", "validate", "runs"]]);
  out = await run("agent_app_run_operation", { dir: "./crm", path: "promote", operation: "go", fields: { n: 1 } });
  assert.deepEqual([out.bin, out.argv], ["a2app", ["./crm", "promote", "go", "--n", "1"]]);
  out = await run("agent_app_validate", { dir: "./crm", noBuild: true });
  assert.deepEqual([out.bin, out.argv], ["agent-app", ["./crm", "validate", "--no-build"]]);
  out = await run("agent_app_install", { id: "kanban-board", set: { APP_TITLE: "Team" }, noStart: true });
  assert.deepEqual([out.bin, out.trust, out.argv], ["agent-app", "catalogued", ["install", "kanban-board", "--set", "APP_TITLE=Team", "--no-start"]]);
  out = await run("agent_app_export", { dir: "./crm", out: "crm.zip" });
  assert.deepEqual(out.argv, ["./crm", "export", "--out", "crm.zip"]);
  const rejected = await tools.get("agent_app_get").execute({ dir: "./crm", entity: "deals", id: "BAD" });
  assert.match(rejected, /"ok": false/);
  assert.match(rejected, /rejected by the guard/, "a failed call carries what the CLI said, too");
  assert.equal(tools.get("agent_app_install").description, (await import(pathToFileURL(resolve(here, "../../integration-starter/dist/index.js")).href)).a2appTools().find((t) => t.name === "agent_app_install").description);

  /* ── The manager ── */
  const page = await call("/agent-app/home");
  const cfg = JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(page.text)[1]);
  assert.equal(cfg.steps.length, 11);
  const script = /<script>\n([\s\S]*)<\/script><\/body>/.exec(page.text)[1];
  assert.doesNotThrow(() => new Function(script), "the page's script parses");
  for (const panel of ["Marketplace", "Import", "/catalogue?search=", "/install?job=", "/import/agent", "/upload"]) assert.ok(script.includes(panel), panel);
  const api = (path, opts = {}) => call(`/agent-app/api${path}`, { token: cfg.token, ...opts });

  let r = await api("/catalogue?search=board");
  assert.deepEqual([r.status, r.json.argv], [200, ["catalogue", "--search", "board"]]);
  r = await api("/inspect", { method: "POST", body: { id: "kanban-online", source: "github:acme/market@main" } });
  assert.deepEqual(r.json.report.argv, ["inspect", "kanban-online", "--source", "github:acme/market@main"]);
  r = await api("/upload", { method: "POST", raw: Buffer.from("PK zip") });
  const file = r.json.file;
  r = await api("/install", { method: "POST", body: { from: file } });
  let job = r.json.job;
  while (!job.done) {
    await new Promise((d) => setTimeout(d, 20));
    job = (await api(`/install?job=${job.id}`)).json.job;
  }
  assert.deepEqual([job.ok, job.result.trust], [true, "untrusted"]);
  assert.ok(!existsSync(file), "the upload is removed once installed");

  r = await api("/import/agent", { method: "POST", body: { action: "import", from: "./living-ui-app", name: "Kanban", requirement: "Keep the columns." } });
  assert.equal(r.status, 200, r.text);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].sessionId, "agent-app:kanban");
  assert.match(followups[0].text, /^Convert the app at `\.\/living-ui-app` into a new Agent App\./);
  assert.match(followups[0].text, /Keep the columns\./);
  assert.ok(followups[0].text.endsWith(`Create the app at \`${r.json.path}\` — pass that directory to every agent-app command.`));
  r = await api("/apps");
  assert.deepEqual(r.json.rows.map((row) => [row.name, row.building]), [["Kanban", true]]);
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("✓ dsh: 19 tools, each run by the engine's own (so by the binary that owns it); the manager's panels and its marketplace, import and agent hand-off routes");
