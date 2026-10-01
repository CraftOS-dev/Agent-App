/**
 * The Pi extension that makes Pi reachable from `agent-app <dir> bridge`.
 *
 * Loads the extension the way Pi does (default export, called with the API)
 * against a throwaway framework home, and pins the rules for a file that
 * belongs to the user: write the "pi" profile once, keep what is already there,
 * and never rewrite a file that could not be read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "a2app-pi-home-"));
process.env.A2APP_HOME = home;
const file = join(home, "harnesses.json");

const { default: activate } = await import("../extensions/a2app-bridge.ts");

/** A stand-in for Pi's API that records what the extension would show. */
function fakePi() {
  const notes = [];
  return {
    notes,
    on(event, handler) {
      assert.equal(event, "session_start");
      handler({}, { ui: { notify: (message, type) => notes.push({ message, type }) } });
    },
  };
}

try {
  let pi = fakePi();
  activate(pi);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    version: 1,
    harnesses: [{ id: "pi", name: "Pi", routes: [{ mode: "headless", command: "pi", args: ["-p", "{prompt}"] }] }],
  });
  assert.equal(pi.notes.length, 1);
  assert.equal(pi.notes[0].type, "info");

  // Every later start is silent and leaves the entry, including a user's edit.
  const edited = { version: 1, default: "pi", harnesses: [{ id: "pi", routes: [{ mode: "headless", command: "/opt/pi", args: ["-p", "{prompt}"] }] }] };
  writeFileSync(file, JSON.stringify(edited));
  pi = fakePi();
  activate(pi);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), edited);
  assert.equal(pi.notes.length, 0);

  // An unreadable file is left exactly as it was, and the user is told.
  writeFileSync(file, "{ not json");
  pi = fakePi();
  activate(pi);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
  assert.equal(pi.notes[0]?.type, "warning");
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("✓ pi extension: registers the pi route once, keeps existing entries, never rewrites an unreadable file");
