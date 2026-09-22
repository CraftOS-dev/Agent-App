/**
 * Safe-evolve artifact class (framework spec 7.2) — the suite obligation stated
 * in conformance/README.md: fresh-DB replay, live-data-never-cloned, routed
 * operate traffic, the validate→promote gate pass, pre-promote backup, dev
 * destroyed on promote success, and restore's capture-first contract.
 *
 * Drives the REAL `agent-app`/`a2app` CLIs over one scaffolded react-node app
 * (the runnable blueprint: plain Node, adapter linked from the repo, no
 * network). The checks are one ordered story — the same story the modify skill
 * tells an agent — because the invariants are about the ORDER: what promote
 * refuses before validate, what validate proves only while dev is up, what
 * exists after promote succeeds.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CheckResult, SuiteResult } from "./runner.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "a2app-conf-evolve-home-"));

function run(entry: string, args: string[], cwd?: string): Promise<{ exit: number; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, A2APP_HOME: TEST_HOME },
      ...(cwd !== undefined ? { cwd } : {}),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolvePromise({ exit: code ?? -1, out }));
    child.on("error", (e) => resolvePromise({ exit: -1, out: String(e) }));
  });
}

/** `npm install` in the app dir — offline: the scaffold links the repo's own
 *  adapter as a `file:` dependency. Shell-spawned because npm is `npm.cmd` on
 *  Windows and a bare spawn cannot find it. */
function npmInstall(dir: string): Promise<{ exit: number; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("npm install --no-audit --no-fund --loglevel=error", {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolvePromise({ exit: code ?? -1, out }));
    child.on("error", (e) => resolvePromise({ exit: -1, out: String(e) }));
  });
}

async function identify(port: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/api/_a2app`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { a2app?: boolean; app?: { id?: string } };
    return body?.a2app === true && typeof body.app?.id === "string" ? body.app.id : null;
  } catch {
    return null;
  }
}

export async function runSafeEvolveClass(
  frameworkEntry: string | null,
  operateEntry: string | null,
): Promise<SuiteResult> {
  const results: CheckResult[] = [];
  const check = (name: string, failures: string[]): void => {
    results.push({ name, ok: failures.length === 0, failures });
  };
  const done = (): SuiteResult => {
    const passed = results.filter((r) => r.ok).length;
    return { class: "Safe-evolve", name: "Dev environment, gate pass, promote, restore (framework 7.2)", results, passed, failed: results.length - passed };
  };

  if (!frameworkEntry || !operateEntry) {
    check("safe-evolve class", ["(skipped: CLI unavailable)"]);
    return done();
  }

  const base = mkdtempSync(join(tmpdir(), "a2app-evolve-"));
  const appDir = join(base, "app");

  // ── setup: scaffold the runnable blueprint and link its adapter ──────────
  const scaffolded = await run(frameworkEntry, [appDir, "scaffold", "--blueprint", "blueprint-react-node", "--name", "safe-evolve probe"]);
  if (scaffolded.exit !== 0) {
    check("setup: scaffold blueprint-react-node", [`scaffold exit ${scaffolded.exit}: ${scaffolded.out.trim().slice(0, 300)}`]);
    return done();
  }
  const installed = await npmInstall(appDir);
  if (installed.exit !== 0) {
    check("setup: npm install (file:-linked adapter, offline)", [`npm exit ${installed.exit}: ${installed.out.trim().slice(0, 300)}`]);
    return done();
  }
  const appId = (JSON.parse(readFileSync(join(appDir, "manifest.json"), "utf8")) as { id: string }).id;
  const devJson = join(appDir, ".a2app", "dev.json");
  // The blueprint's store is SQLite (data/db.sqlite). The update/restore rounds
  // below need a real live database to exist, so they build one through the
  // app's OWN better-sqlite3 (resolved from the app's node_modules — the
  // harness carries no database dependency of its own).
  const liveDb = join(appDir, "data", "db.sqlite");
  const appRequire = createRequire(join(appDir, "package.json"));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const AppDatabase = appRequire("better-sqlite3") as new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown };
    close(): void;
  };
  const writeLiveRow = (id: string, title: string): void => {
    mkdirSync(join(appDir, "data"), { recursive: true });
    const db = new AppDatabase(liveDb);
    db.exec(
      "CREATE TABLE IF NOT EXISTS records (entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (entity, id))",
    );
    db.prepare("INSERT OR REPLACE INTO records (entity, id, data) VALUES (?, ?, ?)").run(
      "tasks",
      id,
      JSON.stringify({ id, title }),
    );
    db.close(); // last connection closing checkpoints the WAL into the main file
  };

  // ── promote with no gate pass must refuse ────────────────────────────────
  {
    const failures: string[] = [];
    const res = await run(frameworkEntry, [appDir, "promote"]);
    if (res.exit !== 1) failures.push(`expected exit 1, got ${res.exit}`);
    if (!/gate pass/.test(res.out)) failures.push(`refusal does not name the gate pass: ${res.out.trim().slice(0, 200)}`);
    check("promote refuses without a gate pass (7.2: edit → dev → validate → promote is structural)", failures);
  }

  // ── dev boots the candidate: hidden port, fresh DB, identity-verified ────
  let devPort = 0;
  {
    const failures: string[] = [];
    const res = await run(frameworkEntry, [appDir, "dev"]);
    if (res.exit !== 0) failures.push(`dev exit ${res.exit}: ${res.out.trim().slice(0, 400)}`);
    if (!existsSync(devJson)) failures.push("no .a2app/dev.json record written");
    else {
      const rec = JSON.parse(readFileSync(devJson, "utf8")) as { port: number; bootDir: string; healthy: boolean };
      devPort = rec.port;
      if (rec.healthy !== true) failures.push("dev record not marked healthy");
      if ((await identify(rec.port)) !== appId) failures.push(`hidden port ${rec.port} does not answer as the app`);
      const devDb = join(rec.bootDir, "data", "db.sqlite");
      if (!existsSync(devDb)) failures.push("dev boot dir holds no fresh database");
    }
    if (existsSync(liveDb)) failures.push("dev boot created a LIVE database — live data must be untouched");
    check("dev boots the candidate on a hidden port with a fresh database (live untouched)", failures);
  }

  // ── operate traffic routes to the dev instance ───────────────────────────
  {
    const failures: string[] = [];
    const res = await run(operateEntry, [appDir, "data", "tasks", "create", "--title", "conformance probe"]);
    if (res.exit !== 0) failures.push(`routed create exit ${res.exit}: ${res.out.trim().slice(0, 200)}`);
    if (!existsSync(devJson)) {
      failures.push("no dev record — cannot check where the write landed");
    } else {
      const rec = JSON.parse(readFileSync(devJson, "utf8")) as { bootDir: string };
      const devDb = join(rec.bootDir, "data", "db.sqlite");
      if (!existsSync(devDb)) failures.push("dev boot dir holds no database after a routed write");
      // The record must be readable back through the routed path. (The raw
      // SQLite bytes may still sit in the WAL sidecar while the dev server
      // holds the connection, so a byte-grep of db.sqlite would be flaky.)
      const listed = await run(operateEntry, [appDir, "data", "tasks", "list"]);
      if (listed.exit !== 0 || !listed.out.includes("conformance probe")) {
        failures.push("routed read does not see the test record on the dev instance");
      }
    }
    if (existsSync(liveDb)) failures.push("test record reached the live data directory (threat B2)");
    check("operate commands target the dev instance while it is up (test data never reaches live)", failures);
  }

  // ── validate with dev up records a promotable pass ───────────────────────
  {
    const failures: string[] = [];
    const res = await run(frameworkEntry, [appDir, "validate"]);
    if (res.exit !== 0) failures.push(`validate exit ${res.exit}: ${res.out.trim().slice(0, 400)}`);
    if (!/"promotable": true/.test(res.out)) failures.push("pass not marked promotable with the dev instance up");
    check("validate measures the dev instance and records a promotable gate pass", failures);
  }

  // ── an edit after validate invalidates the pass ──────────────────────────
  {
    const failures: string[] = [];
    appendFileSync(join(appDir, "a2app.schema.mjs"), "\n// edited after validate (conformance)\n");
    const res = await run(frameworkEntry, [appDir, "promote"]);
    if (res.exit !== 1) failures.push(`expected exit 1 after post-validate edit, got ${res.exit}`);
    if (!/changed since/.test(res.out)) failures.push(`refusal does not name the stale pass: ${res.out.trim().slice(0, 200)}`);
    check("promote refuses when the code changed since the last validate", failures);
  }

  // ── first promote: no backup needed, dev destroyed ───────────────────────
  {
    const failures: string[] = [];
    const revalidated = await run(frameworkEntry, [appDir, "validate"]);
    if (revalidated.exit !== 0) failures.push(`re-validate exit ${revalidated.exit}`);
    const res = await run(frameworkEntry, [appDir, "promote"]);
    if (res.exit !== 0) failures.push(`promote exit ${res.exit}: ${res.out.trim().slice(0, 400)}`);
    if (!/first install/.test(res.out)) failures.push("first-vs-update not decided structurally (expected the first-install path)");
    if (existsSync(devJson)) failures.push("dev record survived a successful promote — the dev environment must be destroyed");
    if (devPort !== 0 && (await identify(devPort)) === appId) failures.push("dev instance still answering after promote");
    check("promote succeeds on a fresh pass: first-install path, dev environment destroyed", failures);
  }

  // ── update round: live DB exists → mandatory pre-promote backup ──────────
  {
    const failures: string[] = [];
    writeLiveRow("rec_live", "pre-existing live row");
    const liveBytes = readFileSync(liveDb, "latin1");
    const dev = await run(frameworkEntry, [appDir, "dev"]);
    if (dev.exit !== 0) failures.push(`dev exit ${dev.exit}`);
    if (readFileSync(liveDb, "latin1") !== liveBytes) failures.push("dev boot modified the live database");
    const validated = await run(frameworkEntry, [appDir, "validate"]);
    if (validated.exit !== 0) failures.push(`validate exit ${validated.exit}`);
    const res = await run(frameworkEntry, [appDir, "promote"]);
    if (res.exit !== 0) failures.push(`promote exit ${res.exit}: ${res.out.trim().slice(0, 400)}`);
    if (!/pre-promote backup/.test(res.out)) failures.push("no pre-promote backup reported with a live database present");
    const backupsDir = join(appDir, ".a2app", "backups");
    if (!existsSync(backupsDir)) failures.push("no backups directory after a pre-promote backup");
    check("update promote takes the mandatory pre-promote backup and applies to the existing live DB", failures);
  }

  // ── restore: capture-first, then the backup's bytes are live ─────────────
  {
    const failures: string[] = [];
    const backedUp = await run(frameworkEntry, [appDir, "backup"]);
    if (backedUp.exit !== 0) failures.push(`backup exit ${backedUp.exit}`);
    const backupIdMatch = /"backup": "([^"]+)"/.exec(backedUp.out);
    writeLiveRow("rec_x", "post-backup write");
    const res = await run(frameworkEntry, [appDir, "restore", ...(backupIdMatch ? [backupIdMatch[1] as string] : [])]);
    if (res.exit !== 0) failures.push(`restore exit ${res.exit}: ${res.out.trim().slice(0, 300)}`);
    if (!/pre-restore snapshot/.test(res.out)) failures.push("restore did not report the capture-first snapshot");
    if (readFileSync(liveDb, "latin1").includes("post-backup write")) failures.push("restore did not bring the backup's bytes back");
    check("restore captures current state first and restores the named backup", failures);
  }

  // ── stop --dev abandons a candidate ──────────────────────────────────────
  {
    const failures: string[] = [];
    const dev = await run(frameworkEntry, [appDir, "dev"]);
    if (dev.exit !== 0) failures.push(`dev exit ${dev.exit}`);
    const res = await run(frameworkEntry, [appDir, "stop", "--dev"]);
    if (res.exit !== 0) failures.push(`stop --dev exit ${res.exit}: ${res.out.trim().slice(0, 200)}`);
    if (existsSync(devJson)) failures.push("dev record survived stop --dev");
    check("stop --dev tears the candidate down and clears its record", failures);
  }

  return done();
}
