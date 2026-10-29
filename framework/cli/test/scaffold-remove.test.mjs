/**
 * Creating an app and deleting one, at the two ends of its life:
 *
 *  - `scaffold` builds on a blueprint the agent names, and the blueprints are
 *    findable from the CLI itself (`agent-app blueprints`);
 *  - `remove` keeps what cannot be rebuilt — the data AND the backups someone
 *    took on purpose, which live inside the app — before it deletes the app.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_APP = resolve(here, "..", "dist", "agent-app.js");

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

function cli(args, home) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [AGENT_APP, ...args], { env: { ...process.env, A2APP_HOME: home }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      let result = null;
      try {
        result = JSON.parse(stdout);
      } catch {
        /* no JSON result */
      }
      done({ code, out: stdout + stderr, result });
    });
  });
}

const home = mkdtempSync(join(tmpdir(), "a2app-scaffold-home-"));
const base = mkdtempSync(join(tmpdir(), "a2app-scaffold-"));
try {
  /* ------------------------------------------------------------- blueprints */
  const listed = await cli(["blueprints"], home);
  const ids = (listed.result?.blueprints ?? []).map((b) => b.id);
  ok("blueprints lists what scaffold can build on", listed.code === 0 && ids.includes("blueprint-base") && ids.includes("blueprint-react-node"));
  ok("…each with what it is built with", (listed.result?.blueprints ?? []).every((b) => typeof b.description === "string" && b.description !== ""));

  /* --------------------------------------------- scaffold needs a blueprint */
  const bare = join(base, "bare");
  const refused = await cli([bare, "scaffold"], home);
  ok("scaffold without --blueprint is a usage error naming the choices", refused.code === 2 && refused.out.includes("blueprint-react-node"));
  ok("…that creates nothing", !existsSync(bare));

  /* ------------------------------------------------ remove keeps its backups */
  const dir = join(base, "keep-me");
  const made = await cli([dir, "scaffold", "--blueprint", "blueprint-base", "--name", "Keep Me"], home);
  check("scaffold on a named blueprint succeeds", made.code, 0);
  ok("…with the blueprint's own .gitignore", readFileSync(join(dir, ".gitignore"), "utf8").includes(".agent-token"));

  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "db.txt"), "live");
  mkdirSync(join(dir, ".a2app", "backups", "2026-01-01T00-00-00-000Z-1-0"), { recursive: true });
  writeFileSync(join(dir, ".a2app", "backups", "2026-01-01T00-00-00-000Z-1-0", "db.txt"), "taken on purpose");

  const asked = await cli([dir, "remove"], home);
  ok("remove without --yes says it keeps the data and the backups", asked.code === 2 && asked.result?.hasData === true && asked.result?.hasBackups === true);
  const removed = await cli([dir, "remove", "--yes"], home);
  check("remove --yes removes the app", [removed.code, existsSync(dir)], [0, false]);
  const data = removed.result?.dataBackup;
  const backups = removed.result?.backups;
  ok("…keeping its data out of the app", typeof data === "string" && readFileSync(join(data, "db.txt"), "utf8") === "live");
  ok(
    "…and the backups that lived inside it",
    typeof backups === "string" && readFileSync(join(backups, "2026-01-01T00-00-00-000Z-1-0", "db.txt"), "utf8") === "taken on purpose",
  );
} finally {
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`scaffold/remove: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("scaffold/remove: all checks passed");
