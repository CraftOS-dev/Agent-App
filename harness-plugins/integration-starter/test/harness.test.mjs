/**
 * The plugin's half of the app→agent ladder: registering a harness route in the
 * machine's `harnesses.json`, and the task tools an agent takes work with.
 *
 * The file belongs to the user, so what is pinned here is mostly what the
 * helper must NOT do: overwrite an entry that is already there, drop another
 * harness, touch `default`, or rewrite a file it could not read.
 *
 * Runs against the compiled engine (`dist/`), standard library only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "a2app-starter-home-"));
process.env.A2APP_HOME = home;
const file = join(home, "harnesses.json");

const { a2appTools, binFor, harnessesFile, registerHarnessProfile } = await import("../dist/index.js");

const profile = { id: "myharness", name: "My Harness", routes: [{ mode: "headless", command: "myharness", args: ["run", "{prompt}"] }] };
const read = () => JSON.parse(readFileSync(file, "utf8"));

try {
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

  // The task tools an agent takes work with, each shelling the operate binary.
  const names = a2appTools().map((t) => t.name);
  for (const name of ["agent_app_poll_tasks", "agent_app_next_task", "agent_app_task_progress", "agent_app_complete_task"]) {
    assert.ok(names.includes(name), `the engine exposes ${name}`);
  }
  // `bridge` is a build-side verb: a hand-typed `<dir> bridge` goes to agent-app.
  assert.equal(binFor(["./app", "bridge", "start"]), "agent-app");
  assert.equal(binFor(["./app", "tasks", "next"]), "a2app");
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("✓ harness registration: writes once, keeps edits and other entries, never rewrites an unreadable file; task tools present");
