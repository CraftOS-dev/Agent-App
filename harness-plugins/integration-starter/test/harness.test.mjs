/**
 * The engine's contract with the framework CLIs: the harness route a plugin
 * registers in the machine's `harnesses.json`, the argv each tool builds, how
 * `install --events` is read, the kickoffs, and the passthrough's verb router.
 *
 * The harness file belongs to the user, so what is pinned there is mostly what
 * the helper must NOT do: overwrite an entry that is already there, drop
 * another harness, touch `default`, or rewrite a file it could not read.
 *
 * The router copies the CLI's command table, so it is checked against the
 * CLI itself: when `framework/cli` is built, every command module it has is
 * offered to the built `agent-app`, and which binary and scope accept it must
 * be what the engine routes it to.
 *
 * Runs against the compiled engine (`dist/`), standard library only. No network.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const home = mkdtempSync(join(tmpdir(), "a2app-starter-home-"));
process.env.A2APP_HOME = home;
const file = join(home, "harnesses.json");

const engine = await import("../dist/index.js");
const { a2appTools, binFor, buildKickoffPrompt, FRAMEWORK_BLUEPRINTS, FRAMEWORK_VERBS, harnessesFile, parseInstallEvent, registerA2AppPlugin, registerHarnessProfile, REGISTRY_VERBS } = engine;

const profile = { id: "myharness", name: "My Harness", routes: [{ mode: "headless", command: "myharness", args: ["run", "{prompt}"] }] };
const read = () => JSON.parse(readFileSync(file, "utf8"));

// The fake CLIs, under the names the tools run them by.
const bin = mkdtempSync(join(tmpdir(), "a2app-starter-bin-"));
for (const name of ["agent-app", "a2app"]) copyFileSync(join(here, "fake-cli.mjs"), join(bin, `${name}.mjs`));
const FAKE = { cli: join(bin, "a2app.mjs"), framework: join(bin, "agent-app.mjs") };

/** Run a tool against the fake CLIs; the fake echoes the binary and argv it was run with. */
async function call(name, args) {
  const tool = a2appTools(FAKE.cli, FAKE.framework).find((t) => t.name === name);
  assert.ok(tool, `the engine exposes ${name}`);
  const r = await tool.handler(args);
  assert.ok(r.json, `${name}: the fake answered JSON (exit ${r.code}, ${r.stderr})`);
  return { bin: r.json.bin, argv: r.json.argv, result: r };
}

/** Run the built CLI and resolve its exit code. */
function exitOf(entry, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, A2APP_HOME: home }, stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => done(code));
  });
}

try {
  /* ── The harness route ── */
  assert.equal(harnessesFile(), file, "the helper writes the file the bridge reads");

  // A machine with no file gets one, in the framework's format.
  let r = registerHarnessProfile(profile);
  assert.equal(r.status, "registered");
  assert.deepEqual(read(), { version: 1, harnesses: [profile] });

  // Loading again changes nothing, and a user's edit to the entry survives.
  const edited = { ...profile, routes: [{ mode: "headless", command: "/opt/myharness", args: ["{prompt}"] }] };
  writeFileSync(file, JSON.stringify({ version: 1, harnesses: [edited] }));
  r = registerHarnessProfile(profile);
  assert.equal(r.status, "kept");
  assert.deepEqual(read().harnesses, [edited], "an existing entry with the same id is never overwritten");

  // Another harness's entry and the user's default are preserved.
  const other = { id: "other", routes: [{ mode: "subscribe" }] };
  writeFileSync(file, JSON.stringify({ version: 1, default: "other", harnesses: [other] }));
  r = registerHarnessProfile(profile);
  assert.equal(r.status, "registered");
  assert.deepEqual(read(), { version: 1, default: "other", harnesses: [other, profile] });

  // A file that cannot be read is left exactly as it was.
  writeFileSync(file, "{ not json");
  r = registerHarnessProfile(profile);
  assert.equal(r.status, "refused");
  assert.equal(readFileSync(file, "utf8"), "{ not json");

  writeFileSync(file, JSON.stringify({ version: 1, harnesses: { id: "x" } }));
  r = registerHarnessProfile(profile);
  assert.equal(r.status, "refused");
  assert.deepEqual(read(), { version: 1, harnesses: { id: "x" } });

  /* ── The tools ── */
  const names = a2appTools().map((t) => t.name);
  assert.equal(names.length, 22, "17 build+operate tools and 5 for packages");
  assert.equal(new Set(names).size, names.length, "tool names are unique");
  for (const name of ["agent_app_poll_tasks", "agent_app_next_task", "agent_app_task_progress", "agent_app_complete_task"]) {
    assert.ok(names.includes(name), `the engine exposes ${name}`);
  }

  // Each package tool shells the build binary with the CLI's own argv.
  assert.deepEqual((await call("agent_app_list_apps", {})).result.json.apps, [], "the registry, from agent-app list --json");
  let c = await call("agent_app_catalogue", {});
  assert.equal(c.bin, "agent-app");
  assert.deepEqual(c.argv, ["catalogue"], "no --json: catalogue always prints JSON, and refuses the flag");
  c = await call("agent_app_catalogue", { search: "kanban board", source: "github:acme/market@dev" });
  assert.deepEqual(c.argv, ["catalogue", "--search", "kanban board", "--source", "github:acme/market@dev"]);
  c = await call("agent_app_inspect", { id: "kanban-board", source: "./market" });
  assert.deepEqual(c.argv, ["inspect", "kanban-board", "--source", "./market"]);
  c = await call("agent_app_inspect", { from: "https://github.com/acme/board/tree/main/app" });
  assert.deepEqual(c.argv, ["inspect", "--from", "https://github.com/acme/board/tree/main/app"]);
  c = await call("agent_app_install", { id: "kanban-board", set: { APP_TITLE: 'Team "A" & co', SUBTITLE: "x" }, name: "Team", noStart: true });
  assert.deepEqual(c.argv, ["install", "kanban-board", "--name", "Team", "--set", 'APP_TITLE=Team "A" & co', "--set", "SUBTITLE=x", "--no-start"]);
  assert.equal(c.bin, "agent-app");
  assert.equal(c.result.json.trust, "catalogued", "the tool returns the CLI's result as it is");
  c = await call("agent_app_install", { from: "./board.zip", into: "./board", open: true, source: undefined, set: null });
  assert.deepEqual(c.argv, ["install", "--from", "./board.zip", "--into", "./board", "--open"]);
  c = await call("agent_app_export", { dir: "./board" });
  assert.deepEqual([c.bin, c.argv], ["agent-app", ["./board", "export"]]);
  c = await call("agent_app_export", { dir: "./board", out: "out/board.zip" });
  assert.deepEqual(c.argv, ["./board", "export", "--out", "out/board.zip"]);

  // A refusal reaches the caller as the CLI reported it.
  const refused = await a2appTools(FAKE.cli, FAKE.framework).find((t) => t.name === "agent_app_install").handler({ from: "./living-ui-app" });
  assert.equal(refused.code, 1);
  assert.deepEqual([refused.json.step, refused.json.kind, refused.json.routes], ["inspect", "living-ui", ["convert"]]);
  const usage = await a2appTools(FAKE.cli, FAKE.framework).find((t) => t.name === "agent_app_install").handler({ id: "x", from: "y" });
  assert.deepEqual([usage.code, usage.json], [2, null], "a usage error prints no JSON, only its message");
  assert.match(usage.stderr, /not both/);

  // A harness with a display embeds what an install serves, and suppresses the CLI's opener.
  const shown = [];
  const ctx = { registerTool() {}, registerDisplay: (tab) => shown.push(tab) };
  const registered = registerA2AppPlugin(ctx, { cliBin: FAKE.cli, frameworkBin: FAKE.framework });
  const installed = await registered.find((t) => t.name === "agent_app_install").handler({ id: "kanban-board", open: true });
  assert.ok(!installed.json.argv.includes("--open"), "the display shows it, so the CLI opens nothing");
  assert.deepEqual(shown, [{ id: "agent-app:0123456789ab", label: "Installed App", url: "http://127.0.0.1:8123/" }]);

  /* ── install --events ── */
  assert.deepEqual(parseInstallEvent('{"event":"step","step":"gate","status":"skipped","reason":"--no-start"}'), {
    event: "step",
    step: "gate",
    status: "skipped",
    reason: "--no-start",
  });
  assert.deepEqual(parseInstallEvent('{"event":"result","ok":false,"step":"acquire","error":"nope"}'), { event: "result", ok: false, step: "acquire", error: "nope" });
  for (const line of ["", "▸ acquire", "{not json", "[]", '{"event":"step","step":"gate","status":"paused"}', '{"event":"step","status":"done"}', '{"event":"result"}']) {
    assert.equal(parseInstallEvent(line), null, `not an event: ${JSON.stringify(line)}`);
  }

  /* ── Kickoffs ── */
  const kick = (body) => buildKickoffPrompt(body);
  let k = kick({ action: "install", id: "kanban-board" });
  assert.equal(k.activity, "importer");
  assert.match(k.prompt, /marketplace app `kanban-board`/);
  assert.match(k.prompt, /no walk-verify is owed/);
  k = kick({ action: "install", from: "./board.zip" });
  assert.match(k.prompt, /agent-app inspect --from/);
  assert.match(k.prompt, /walk-verifies/);
  k = kick({ action: "import", from: "./crm-src", requirement: "Keep the pipeline view." });
  assert.equal(k.activity, "importer");
  assert.match(k.prompt, /^Convert the app at `.\/crm-src` into a new Agent App\./);
  assert.match(k.prompt, /Keep the pipeline view\./);
  assert.match(k.prompt, /reference\/source\//);
  k = kick({ action: "adopt", id: "plain-site", source: "github:acme/market" });
  assert.match(k.prompt, /^Adopt the marketplace app `plain-site` from the marketplace `github:acme\/market`/);
  assert.match(k.prompt, /blueprint-sidecar/);
  for (const action of ["install", "import", "adopt"]) {
    assert.equal(kick({ action }).kind, "error", `${action} names a source`);
    assert.equal(kick({ action, id: "a", from: "b" }).kind, "error", `${action} names one source`);
  }
  assert.equal(kick({ action: "build", name: "CRM", requirement: "Track deals." }).activity, "creator");

  /* ── The router ── */
  // `bridge` is a build-side verb: a hand-typed `<dir> bridge` goes to agent-app.
  assert.equal(binFor(["./app", "bridge", "start"]), "agent-app");
  assert.equal(binFor(["./app", "tasks", "next"]), "a2app");
  // A registry verb stands first and takes no app: `install --from x` is not an app named "install".
  assert.equal(binFor(["install", "--from", "./board.zip"]), "agent-app");
  assert.equal(binFor(["catalogue"]), "agent-app");
  assert.equal(binFor(["./app", "export", "--out", "a.zip"]), "agent-app");
  assert.equal(binFor(["./app", "login"]), "a2app", "login asks the person in the app: an a2app command");
  assert.equal(binFor(["./app"]), "a2app", "a bare app is the walk's root screen");

  const cliEntry = join(repo, "framework", "cli", "dist", "agent-app.js");
  const commandsDir = join(repo, "framework", "cli", "src", "commands");
  if (existsSync(cliEntry) && existsSync(commandsDir)) {
    // Every command module the CLI dispatches to, offered to the built binary:
    // as a registry verb (`agent-app <verb> --help`) and as an app verb
    // (`agent-app <dir> <verb> --help`). Help is answered (exit 0) only where
    // the verb belongs; anywhere else the CLI names the right place (exit 2).
    const verbs = readdirSync(commandsDir).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
    const asked = await Promise.all(
      verbs.map(async (verb) => ({ verb, registry: (await exitOf(cliEntry, [verb, "--help"])) === 0, app: (await exitOf(cliEntry, ["./app", verb, "--help"])) === 0 })),
    );
    const framework = new Set(asked.filter((v) => v.registry || v.app).map((v) => v.verb));
    const registry = new Set(asked.filter((v) => v.registry).map((v) => v.verb));
    assert.deepEqual([...FRAMEWORK_VERBS].sort(), [...framework].sort(), "FRAMEWORK_VERBS is exactly the verbs agent-app accepts");
    assert.deepEqual([...REGISTRY_VERBS].sort(), [...registry].sort(), "REGISTRY_VERBS is exactly the verbs that take no app");
    for (const { verb, registry: standsAlone } of asked) {
      const typed = standsAlone ? [verb, "--help"] : ["./app", verb, "--help"];
      assert.equal(binFor(typed), framework.has(verb) ? "agent-app" : "a2app", `${typed.join(" ")} is routed to its owner`);
    }
  } else {
    console.log("  (router vs the CLI's command table: skipped — build framework/cli to check it)");
  }

  /* ── The toolkits the build form offers ── */
  const toolkits = join(repo, "toolkits");
  if (existsSync(toolkits)) {
    const shipped = readdirSync(toolkits).filter((d) => existsSync(join(toolkits, d, "a2app.toolkit.json")));
    assert.deepEqual([...FRAMEWORK_BLUEPRINTS].sort(), shipped.sort(), "FRAMEWORK_BLUEPRINTS lists every toolkit the framework ships");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
}

console.log("✓ engine: harness registration rules; 22 tools with the CLI's argv; install events; importer kickoffs; the router matches the CLI's command table");
