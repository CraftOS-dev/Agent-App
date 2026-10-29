/**
 * The runnable sidecar: an app directory with `sidecar.json` in, a running
 * foreign app with an A2App surface in front of it out.
 *
 * Covers the declarations the gate checks (`a2app-sidecar --check` and the
 * loader behind it), the launch contract a real run honours — the app's port
 * and data directory, the admin credential, the account page, a durable state
 * store, an environment that keeps the framework's values from the foreign app
 * — and every way a launch can fail, each of which must leave nothing running.
 * Finally, the app's lifetime is tied to the sidecar's in both directions:
 * stopping the sidecar stops the app, and an app that goes away takes the
 * surface down with it.
 *
 * Run: node test/sidecar.test.mjs (after tsc)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdoptedApp, startSidecar } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, "..", "dist", "bin.js");
const FOREIGN_APP = join(here, "fixtures", "foreign-app.mjs");

const failures = [];
let passed = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const root = mkdtempSync(join(tmpdir(), "a2app-sidecar-test-"));
const running = new Set();

// The launch contract each run sets is the whole of it: whatever the shell
// running this test exports (a PORT, an A2APP_HOST) must not leak in.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PORT$|A2APP_)/i.test(k)));

/** The status a GET answers with under a given Host header (fetch cannot set one). */
const statusUnderHost = (url, hostHeader) =>
  new Promise((done) => {
    const target = new URL(url);
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, headers: { host: hostHeader } }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on("error", () => done(0));
    req.end();
  });

const freePort = () =>
  new Promise((done) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

/** Whether anything answers HTTP at this URL. */
const answers = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

/* -------------------------------------------------------- an adopted app */

const OPERATIONS = [
  { name: "list-notes", description: "List the notes, or those containing q.", module: "notes", destructive: false, readOnly: true, params: { q: { type: "string" } } },
  { name: "add-note", description: "Add a note.", module: "notes", destructive: false, params: { text: { type: "string", required: true } } },
  { name: "launch-info", description: "What the app was started with.", module: "notes", destructive: false, readOnly: true, params: {} },
];
const SIDECAR = {
  upstream: {
    command: ["node", "app.mjs", "--greeting", "hi {port}"],
    cwd: "upstream",
    port: "auto",
    env: { PORT: "{port}", GREETING: "hello", NOTES_DIR: "{dataDir}" },
    health: "/health",
  },
  operations: {
    "list-notes": { method: "GET", path: "/notes" },
    "add-note": { method: "POST", path: "/notes" },
    "launch-info": { method: "get", path: "/launch" },
  },
};
const clone = (v) => JSON.parse(JSON.stringify(v));

/** An app directory as an adopting agent leaves it: framework files, the
 *  account page, sidecar.json, and the foreign source in upstream/. */
function makeApp({ authMode = "none", operations = OPERATIONS, sidecar = SIDECAR, modules = [{ name: "notes", summary: "notes the app keeps" }], port = 8106 } = {}) {
  const dir = mkdtempSync(join(root, "app-"));
  mkdirSync(join(dir, "upstream"));
  copyFileSync(FOREIGN_APP, join(dir, "upstream", "app.mjs"));
  const manifest = {
    id: "sidecar_test",
    name: "Sidecar Test",
    agentAppVersion: "0.1.0",
    adapterVersion: "0.1.0",
    authMode,
    modules,
    port,
    pipeline: { install: "npm install", build: "npm run build --if-present", start: "a2app-sidecar", health: "/api/_a2app" },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "operations.json"), JSON.stringify({ operations }, null, 2));
  writeFileSync(join(dir, "sidecar.json"), JSON.stringify(sidecar, null, 2));
  writeFileSync(join(dir, "a2app-account.html"), "<!doctype html><title>Account</title><p>account page</p>");
  return dir;
}

/** Run the bin as `pipeline.start` would, collecting its JSON log lines. */
function runBin(dir, env = {}, args = []) {
  const child = spawn(process.execPath, [BIN, ...args, dir], {
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  running.add(child);
  const lines = [];
  let stdout = "";
  let stderr = "";
  let buffered = "";
  child.stdout.on("data", (d) => {
    stdout += d;
    buffered += d;
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      try {
        lines.push(JSON.parse(line));
      } catch {
        /* the app's own output is not ours to parse */
      }
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  let code = null;
  const exited = new Promise((done) =>
    child.on("exit", (c) => {
      code = c;
      running.delete(child);
      done(c);
    }),
  );
  return {
    child,
    lines,
    exited,
    out: () => stdout,
    err: () => stderr,
    /** The first log line `evt`, once it is written; null if the process ends first. */
    async line(evt, ms = 20_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = lines.find((l) => l.evt === evt);
        if (found) return found;
        if (code !== null || Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

/** Boot with the given app, expecting it to fail: its exit code, the failure
 *  line, and the `upstream` line if the app was started before it failed. */
async function bootFails(dir, env = {}) {
  const run = runBin(dir, { PORT: String(await freePort()), A2APP_DATA_DIR: join(dir, "data"), ...env });
  const code = await run.exited;
  return { code, failed: run.lines.find((l) => l.evt === "boot-failed") ?? null, upstream: run.lines.find((l) => l.evt === "upstream") ?? null };
}

try {
  /* ------------------------------------------------- the declarations */

  const good = makeApp();
  const loaded = loadAdoptedApp(good);
  check("a complete adoption loads", loaded.ok, true);
  check("…joining each declaration with its mapping", loaded.app.operations.map((o) => [o.name, o.method, o.path]), [
    ["list-notes", "GET", "/notes"],
    ["add-note", "POST", "/notes"],
    ["launch-info", "GET", "/launch"],
  ]);

  const checked = runBin(good, {}, ["--check"]);
  check("--check passes it", await checked.exited, 0);
  ok("…saying what it checked", /sidecar ok: 3 operation\(s\)/.test(checked.out()));

  const problemsOf = (opts) => {
    const result = loadAdoptedApp(makeApp(opts));
    return result.ok ? [] : result.problems;
  };
  const has = (label, problems, pattern) => ok(`${label} (got: ${problems.join(" | ")})`, problems.some((p) => pattern.test(p)));

  const unmapped = clone(SIDECAR);
  delete unmapped.operations["add-note"];
  has("an operation with no mapping is named", problemsOf({ sidecar: unmapped }), /add-note resolves to no mapping/);

  const extra = clone(SIDECAR);
  extra.operations["drop-all"] = { method: "DELETE", path: "/notes" };
  has("a mapping for an undeclared operation is named", problemsOf({ sidecar: extra }), /drop-all maps an operation operations\.json does not declare/);

  const segment = clone(SIDECAR);
  segment.operations["add-note"].path = "/notes/{folder}";
  has("a path segment that is not a parameter is named", problemsOf({ sidecar: segment }), /\{folder\} is not a parameter of add-note/);

  const optionalSegment = clone(SIDECAR);
  optionalSegment.operations["list-notes"].path = "/notes/{q}";
  has("a path segment filled by an optional parameter is named", problemsOf({ sidecar: optionalSegment }), /list-notes's "q" must be required/);

  const getBody = clone(SIDECAR);
  getBody.operations["list-notes"].send = "body";
  has("a GET with a body is refused", problemsOf({ sidecar: getBody }), /a GET carries no body/);

  const silentPort = clone(SIDECAR);
  silentPort.upstream.env = {};
  silentPort.upstream.command = ["node", "app.mjs"];
  has("an auto port nobody hands over is refused", problemsOf({ sidecar: silentPort }), /"auto" picks a free port at each boot/);

  const ownPort = clone(SIDECAR);
  ownPort.upstream.port = 8106;
  has("the app cannot take the surface's own port", problemsOf({ sidecar: ownPort }), /8106 is the port this app is served on/);

  const nowhere = clone(SIDECAR);
  nowhere.upstream.cwd = "elsewhere";
  has("a missing source directory is named", problemsOf({ sidecar: nowhere }), /"elsewhere\/" does not exist/);

  const outside = clone(SIDECAR);
  outside.upstream.cwd = "../..";
  has("a source directory outside the app is refused", problemsOf({ sidecar: outside }), /must be a directory inside the app/);

  const shell = clone(SIDECAR);
  shell.upstream.command = "node app.mjs";
  has("a command string (shell syntax) is refused", problemsOf({ sidecar: shell }), /must be a non-empty list of strings/);

  const typo = clone(SIDECAR);
  typo.upstream.comand = ["node"];
  has("an unknown key is named, not ignored", problemsOf({ sidecar: typo }), /unknown key "comand"/);

  has("an operation acting on an entity is refused", problemsOf({ operations: [...OPERATIONS.slice(0, 2), { ...OPERATIONS[2], entity: "notes" }] }), /an adopted app has no entities/);
  has("the adapter's own model check runs too", problemsOf({ modules: [{ name: "papers" }] }), /module/);

  const refused = runBin(makeApp({ sidecar: unmapped }), {}, ["--check"]);
  check("--check exits 1 on a problem", await refused.exited, 1);
  ok("…naming it on stderr", /add-note resolves to no mapping/.test(refused.err()));
  check("a usage mistake exits 2", await runBin(good, {}, ["--bogus"]).exited, 2);

  /* -------------------------------------------- a real run, as `serve` does */

  const port = await freePort();
  const dataDir = join(root, "live-data");
  const run = runBin(good, { PORT: String(port), A2APP_DATA_DIR: dataDir, A2APP_TOKEN: "an-agent-credential", A2APP_ENV: "live" });
  const boot = await run.line("boot");
  ok(`the sidecar boots (log: ${run.out().slice(-600)} ${run.err().slice(-600)})`, boot !== null);
  const started = run.lines.find((l) => l.evt === "upstream");
  const base = `http://127.0.0.1:${port}`;
  check("…on the port it was given", boot?.url, base);
  ok("…once the app it started answers", started !== null && started.url === boot?.upstream);

  const identity = await (await fetch(`${base}/api/_a2app`)).json();
  check("it serves the app's identity", [identity.app.id, identity.app.name, identity.authMode], ["sidecar_test", "Sidecar Test", "none"]);
  ok("…with a version marker over what it declares", /^av_[0-9a-f]{16}$/.test(identity.appVersion));

  const token = readFileSync(join(good, ".agent-token"), "utf8").trim();
  ok("a direct run mints the admin credential", token.startsWith("a2app_"));
  const opCall = (name, body) =>
    fetch(`${base}/api/ops/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-a2app-token": token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  check("an operation reaches the app", (await opCall("add-note", { text: "adopted" })).json.result, { id: "1", text: "adopted" });
  check("…and its answer comes back", (await opCall("list-notes", { q: "adopt" })).json.result, [{ id: "1", text: "adopted" }]);
  check("a write needs the credential", (await fetch(`${base}/api/ops/add-note`, { method: "POST", body: "{}" })).status, 401);

  const launch = (await opCall("launch-info", {})).json.result;
  const upstreamPort = new URL(started.url).port;
  check("the app gets {port} in its argv", launch.argv, ["--greeting", `hi ${upstreamPort}`]);
  check("…and its declared environment, tokens filled", [launch.env.PORT, launch.env.GREETING, launch.env.NOTES_DIR], [upstreamPort, "hello", join(dataDir, "upstream")]);
  ok("…its own port, never the surface's", launch.env.PORT !== String(port));
  ok("…its data directory created inside the framework's", existsSync(join(dataDir, "upstream")));
  check("…and none of the framework's variables", ["A2APP_TOKEN", "A2APP_DATA_DIR", "A2APP_ENV"].filter((k) => k in launch.env), []);
  const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  check("…running in its source directory", norm(launch.cwd), norm(join(good, "upstream")));

  const page = await fetch(`${base}/_a2app/account`);
  check("the account page is served", [page.status, page.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  ok("…from the app's own copy", (await page.text()).includes("account page"));
  check("…GET-only", (await fetch(`${base}/_a2app/account`, { method: "POST" })).status, 405);
  const elsewhere = await fetch(`${base}/upstream/app.mjs`);
  check("nothing else in the app directory is reachable", [elsewhere.status, (await elsewhere.json()).code], [404, "not_found"]);
  check("…not even the credential", (await fetch(`${base}/.agent-token`)).status, 404);
  ok("adapter state is kept in the data directory", existsSync(join(dataDir, "a2app-state.json")));
  const logged = run.lines.find((l) => l.evt === "http" && l.path === "/api/ops/list-notes");
  check("each request is logged by path alone", [logged?.method, logged?.status], ["POST", 200]);

  // The app goes away under the sidecar: the surface must not outlive it.
  process.kill(started.pid);
  check("an app that exits takes the sidecar down with it", await run.exited, 1);
  ok("…saying so", run.lines.some((l) => l.evt === "upstream-exit"));
  check("…and the surface is gone", await answers(`${base}/api/_a2app`), false);

  /* -------------------------------------- stopping the sidecar stops the app */

  const inProcess = makeApp({ authMode: "multi-user" });
  const sidecar = await startSidecar({
    dir: inProcess,
    env: { ...baseEnv, PORT: String(await freePort()), A2APP_DATA_DIR: join(inProcess, "data"), A2APP_PUBLIC_URL: "https://notes.example.com" },
    log: () => {},
  });
  check("a multi-user adoption says so", (await (await fetch(`${sidecar.url}/api/_a2app`)).json()).authMode, "multi-user");
  check("…and asks a stranger to sign in", (await (await fetch(`${sidecar.url}/api/_a2app/session`)).json()).code, "sign_in_required");
  check("…on the account page", (await fetch(`${sidecar.url}/_a2app/account`)).status, 200);
  check("it answers under its public URL's host", await statusUnderHost(`${sidecar.url}/api/_a2app`, "notes.example.com"), 200);
  check("…and refuses any other", await statusUnderHost(`${sidecar.url}/api/_a2app`, "evil.example"), 403);
  check("…the account page included", await statusUnderHost(`${sidecar.url}/_a2app/account`, "evil.example"), 403);
  await sidecar.stop();
  check("stop() reports a clean stop", await sidecar.closed, { reason: "stopped" });
  check("…the surface is down", await answers(`${sidecar.url}/api/_a2app`), false);
  check("…and so is the app it started", await answers(`${sidecar.upstreamUrl}/health`), false);

  if (process.platform !== "win32") {
    const signalled = runBin(makeApp(), { PORT: String(await freePort()) });
    const up = await signalled.line("upstream");
    await signalled.line("boot");
    signalled.child.kill("SIGTERM");
    check("SIGTERM stops the sidecar cleanly", await signalled.exited, 0);
    check("…and the app with it", await answers(`${up.url}/health`), false);
  } else {
    // Windows has no SIGTERM to send; `agent-app stop` ends the whole tree
    // (taskkill /T), which the blueprint's end-to-end test covers.
    console.log("  (skipped on Windows: SIGTERM — process trees are ended by taskkill /T)");
  }

  /* ---------------------------------- a launch that fails leaves nothing */

  const quitter = clone(SIDECAR);
  quitter.upstream.command = ["node", "-e", "process.exit(3)", "{port}"];
  const quit = await bootFails(makeApp({ sidecar: quitter }));
  check("an app that exits before answering fails the boot", quit.code, 1);
  ok(`…saying how it ended (${quit.failed?.message})`, /exited with code 3 before answering/.test(quit.failed?.message ?? ""));

  const fixedPort = await freePort();
  const deaf = clone(SIDECAR);
  deaf.upstream.port = fixedPort;
  deaf.upstream.health = "/not-a-health-route";
  deaf.upstream.startTimeoutMs = 1500;
  const timedOut = await bootFails(makeApp({ sidecar: deaf }));
  ok(`an app that never answers its health path fails the boot (${timedOut.failed?.message})`, /did not answer .* within 1500 ms/.test(timedOut.failed?.message ?? ""));
  check("…and is stopped, not left running", await answers(`http://127.0.0.1:${fixedPort}/health`), false);

  const absent = clone(SIDECAR);
  absent.upstream.command = ["a2app-no-such-program", "{port}"];
  const notFound = await bootFails(makeApp({ sidecar: absent }));
  ok(`a program that is not on PATH is named (${notFound.failed?.message})`, /"a2app-no-such-program" is not an executable on PATH/.test(notFound.failed?.message ?? ""));

  const taken = createNetServer();
  await new Promise((r) => taken.listen(0, "127.0.0.1", r));
  const clash = await bootFails(makeApp(), { PORT: String(taken.address().port) });
  await new Promise((r) => taken.close(r));
  ok(`a surface port already in use fails the boot (${clash.failed?.message})`, /EADDRINUSE/.test(clash.failed?.message ?? ""));
  ok("…after the app was started", clash.upstream !== null);
  check("…which is stopped again", await answers(`${clash.upstream?.url}/health`), false);

  const exposed = await bootFails(makeApp(), { A2APP_HOST: "0.0.0.0" });
  ok(`an unsafe network setting is refused (${exposed.failed?.message})`, /A2APP_PUBLIC_URL must name its https address/.test(exposed.failed?.message ?? ""));
  check("…before the app is started", exposed.upstream, null);

  const broken = await bootFails(makeApp({ sidecar: unmapped }));
  check("declaration problems fail the boot, listed", broken.failed?.problems?.some((p) => /add-note resolves to no mapping/.test(p)), true);
} finally {
  for (const child of running) child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures.length) {
  console.log(`sidecar: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log(`sidecar: all ${passed} checks passed`);
