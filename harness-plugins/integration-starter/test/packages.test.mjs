/**
 * Packages from a harness: the manager routes (`PackageApi`), install jobs
 * followed through `--events`, uploads — and the real install path through the
 * engine's tools.
 *
 * The routes are checked against the fake CLI (what they ask of it, and how
 * they read its answers). Then, when `framework/cli` is built, the tools drive
 * the real CLI against a marketplace that is a local directory: catalogue,
 * install with `--no-start`, list, export, inspect the export, and the same
 * install through a job, step by step. No network.
 *
 * Runs against the compiled engine (`dist/`), standard library only.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const base = mkdtempSync(join(tmpdir(), "a2app-starter-pkg-"));
const home = join(base, "home");
mkdirSync(home);
process.env.A2APP_HOME = home;
// Uploads go to the temporary directory: this run's own, so nothing is left behind.
for (const k of ["TMPDIR", "TEMP", "TMP"]) process.env[k] = base;
for (const k of ["A2APP_MARKETPLACE", "A2APP_MARKETPLACE_REF", "A2APP_TOKEN", "AGENT_APP_OPEN_CMD"]) delete process.env[k];

const { a2appTools, INSTALL_STEPS, isUpload, PackageApi, saveUpload, UPLOAD_LIMIT, uploadsDir } = await import("../dist/index.js");

const bin = join(base, "bin");
mkdirSync(bin);
for (const name of ["agent-app", "a2app"]) copyFileSync(join(here, "fake-cli.mjs"), join(bin, `${name}.mjs`));
const FAKE = join(bin, "agent-app.mjs");

/** Poll a job until it ends, as a page would. */
async function settle(api, id, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = api.job(id);
    assert.equal(reply.status, 200);
    if (reply.body.job.done) return reply.body.job;
    assert.ok(Date.now() < deadline, "the install did not end");
    await new Promise((r) => setTimeout(r, 50));
  }
}

try {
  /* ── The routes, against the fake CLI ── */
  const api = new PackageApi(FAKE);

  let reply = await api.catalogue({ search: "kanban", source: "" });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.argv, ["catalogue", "--search", "kanban"], "an empty source is no source");
  assert.equal(reply.body.apps.length, 2);
  reply = await api.catalogue({ source: "unreachable" });
  assert.deepEqual([reply.status, reply.body.ok, reply.body.code], [502, false, 3], "an unreachable marketplace is a 502 with the CLI's message");
  assert.match(reply.body.message, /unreachable/);

  reply = await api.inspect({ from: "./foreign-site" });
  assert.equal(reply.status, 200);
  assert.deepEqual([reply.body.report.kind, reply.body.report.routes], ["foreign", ["adopt", "convert"]]);
  reply = await api.inspect({ id: "kanban-board", source: "github:acme/market@main", extra: "ignored" });
  assert.deepEqual(reply.body.report.argv, ["inspect", "kanban-board", "--source", "github:acme/market@main"]);

  // An install is a job: the reply comes at once, and polls follow its steps.
  process.env.FAKE_STEP_MS = "30";
  assert.equal(api.install({}).status, 400, "nothing to install");
  reply = api.install({ id: "kanban-board", source: "github:acme/market@main", name: "Team", set: { APP_TITLE: "Team board", BAD: 5 } });
  assert.equal(reply.status, 200);
  const started = reply.body.job;
  assert.equal(started.done, false, "the route does not wait for the install");
  assert.equal(started.request, undefined, "a page already has what it sent");
  let midway = null;
  for (;;) {
    const polled = api.job(started.id).body.job;
    if (polled.done) break;
    if (polled.steps.length > 0 && midway === null) midway = polled.steps.map((s) => `${s.step}:${s.status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(midway !== null && midway.length < INSTALL_STEPS.length, "a poll sees the steps as they happen, not only at the end");
  let job = api.job(started.id).body.job;
  assert.deepEqual([job.ok, job.code, job.error], [true, 0, null]);
  assert.deepEqual(job.steps.map((s) => s.step), [...INSTALL_STEPS], "every step, in pipeline order");
  assert.deepEqual(job.steps.find((s) => s.step === "open"), { step: "open", status: "skipped", reason: "pass --open to show it to someone" });
  assert.deepEqual(job.result.argv, ["install", "kanban-board", "--source", "github:acme/market@main", "--name", "Team", "--set", "APP_TITLE=Team board", "--events"]);
  assert.equal(job.result.trust, "catalogued");
  assert.equal(job.result.event, undefined, "the result is the CLI's document, without the event key");
  process.env.FAKE_STEP_MS = "0";

  // A source that is not a package stops at inspect, and the job says what it is and where to take it.
  job = await settle(api, api.install({ from: "./living-ui-app" }).body.job.id);
  assert.deepEqual([job.ok, job.code], [false, 1]);
  assert.deepEqual(job.steps.at(-1), { step: "inspect", status: "failed", error: "a living-ui source is not an Agent App package" });
  assert.deepEqual([job.result.kind, job.result.routes], ["living-ui", ["convert"]]);
  assert.equal(job.error, "a living-ui source is not an Agent App package");

  // A usage error prints no result, only its message.
  job = await settle(api, api.install({ id: "a", from: "b" }).body.job.id);
  assert.deepEqual([job.ok, job.code, job.result], [false, 2, null]);
  assert.match(job.error, /not both/);
  assert.equal(api.job("nope").status, 404);

  // Uploads: bounded, private, swept by the manager once installed.
  const file = await saveUpload(Readable.from([Buffer.from("PK\x03\x04"), Buffer.from("zip bytes")]));
  assert.equal(dirname(file), join(base, "a2app-uploads"));
  assert.ok(isUpload(file) && existsSync(file));
  assert.ok(!isUpload(join(base, "elsewhere.zip")) && !isUpload(uploadsDir()), "only a file inside the uploads folder is one");
  await assert.rejects(saveUpload(Readable.from([Buffer.alloc(1)]), UPLOAD_LIMIT + 1), /512 MiB/, "a declared size over the limit is refused before reading");
  reply = await api.upload(Readable.from([Buffer.alloc(1)]), UPLOAD_LIMIT + 1);
  assert.equal(reply.status, 413);
  reply = await api.upload(Readable.from([Buffer.from("PK")]));
  assert.equal(reply.status, 200);
  job = await settle(api, api.install({ from: reply.body.file }).body.job.id);
  assert.equal(job.ok, true);
  assert.ok(!existsSync(reply.body.file), "an upload is removed once it is installed");

  /* ── The real install path, through the tools ── */
  const cli = join(repo, "framework", "cli", "dist", "agent-app.js");
  if (!existsSync(cli)) {
    console.log("  (the real CLI: skipped — build framework/cli to drive it)");
  } else {
    const tools = Object.fromEntries(a2appTools(join(repo, "framework", "cli", "dist", "a2app.js"), cli).map((t) => [t.name, t]));
    const run = async (name, args) => {
      const r = await tools[name].handler(args);
      assert.equal(r.code, 0, `${name} exited ${r.code}\n${r.stderr}`);
      return r.json;
    };
    // A marketplace that is a local directory: catalogue.json and one app folder,
    // scaffolded on a toolkit this machine has.
    const market = join(base, "market");
    const scaffold = await new Promise((done) => {
      const child = spawn(process.execPath, [cli, join(base, "board-src"), "scaffold", "--blueprint", "blueprint-react-node", "--name", "Board"], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("close", done);
    });
    assert.equal(scaffold, 0, "the CLI scaffolds the app the marketplace serves");
    cpSync(join(base, "board-src"), join(market, "board"), { recursive: true });
    writeFileSync(
      join(market, "catalogue.json"),
      JSON.stringify({
        version: "1.0.0",
        apps: [
          { id: "board", name: "Team Board", description: "Tasks in columns", folder: "board", tags: ["productivity"], toolkit: "blueprint-react-node", agentAppVersion: "0.1.0" },
          { id: "kanban-online", name: "Kanban Online", folder: "kanban-online", livingUIVersion: 2 },
        ],
      }),
    );

    const catalogue = await run("agent_app_catalogue", { source: market });
    assert.deepEqual(
      catalogue.apps.map((a) => [a.id, a.compatible]),
      [
        ["board", true],
        ["kanban-online", false],
      ],
    );
    const installed = await run("agent_app_install", { id: "board", source: market, noStart: true });
    assert.deepEqual([installed.ok, installed.trust, installed.gate.ok, installed.served], [true, "catalogued", true, false]);
    assert.equal(installed.source.catalogueId, "board");
    assert.ok(!installed.next.some((step) => step.includes("walk-verify")), "a marketplace app owes no walk-verify");
    const listed = await run("agent_app_list_apps", {});
    assert.ok(listed.apps.some((a) => a.id === installed.id && resolve(a.path) === resolve(installed.dir)), "the installed app is registered");

    const exported = await run("agent_app_export", { dir: installed.dir, out: join(base, "board.zip") });
    assert.ok(exported.files > 0 && existsSync(exported.file));
    const report = await run("agent_app_inspect", { from: exported.file });
    assert.deepEqual([report.kind, report.installable, report.source.kind], ["agent-app", true, "zip"]);

    // The same pipeline through a job, step by step, as a manager runs it
    // (files only: serving would fetch the app's dependencies, and a test has no network).
    const real = new PackageApi(cli);
    const done = await settle(real, real.install({ from: exported.file, name: "Board Copy", noStart: true }).body.job.id);
    assert.deepEqual([done.ok, done.code, done.error], [true, 0, null], JSON.stringify(done));
    assert.deepEqual(done.steps.map((s) => s.step), [...INSTALL_STEPS], "every step, in pipeline order, from the CLI's own events");
    assert.deepEqual(
      done.steps.map((s) => s.status),
      ["done", "done", "done", "done", "done", "done", "done", "skipped", "done", "skipped", "skipped"],
    );
    assert.deepEqual([done.result.name, done.result.trust], ["Board Copy", "untrusted"]);
    assert.ok(done.result.next.some((step) => step.includes("walk-verify")), "an import owes a walk-verify");
  }
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log("✓ packages: manager routes over the CLI (catalogue, inspect, install jobs from --events, uploads); the real install path through the tools");
