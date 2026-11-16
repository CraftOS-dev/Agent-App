/**
 * Every app keeps its history in a git repository (Quality Standard Q18), and
 * the history is what walk-verify verifies:
 *
 *  - `scaffold` starts it, with the scaffold as the first commit;
 *  - `.a2app/` runtime state is ignored, so `validate` leaves the tree clean
 *    and the commit verified is the tree that ran;
 *  - `commit` commits the app's changes, and creates the repository an older
 *    app lacks; the gate fails an app in no repository;
 *  - an app inside another repository is versioned there: nothing nested,
 *    and nothing else staged there swept into its commit.
 *
 * The CLI runs with an empty global git config, so neither the machine's
 * identity nor its hooks or signing reach these commits.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureIgnoreRules } from "../dist/lib/scaffoldFiles.js";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_APP = resolve(here, "..", "dist", "agent-app.js");
const TOOLKITS = resolve(here, "..", "..", "..", "toolkits");

try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  console.log("history: skipped (git is not on PATH)");
  process.exit(0);
}

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const base = mkdtempSync(join(tmpdir(), "a2app-history-"));
const home = join(base, "home");
mkdirSync(home);
const emptyConfig = join(base, "empty.gitconfig");
writeFileSync(emptyConfig, "");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" };

function cli(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [AGENT_APP, ...args], { env: { ...gitEnv, A2APP_HOME: home, A2APP_TOOLKITS_DIR: TOOLKITS }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      let result = null;
      try {
        result = JSON.parse(stdout.slice(stdout.indexOf("{")));
      } catch {
        /* no JSON result */
      }
      done({ code, out: stdout + stderr, result });
    });
  });
}

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const log = (cwd) => git(cwd, "log", "--format=%an|%s").split("\n");

try {
  /* ------------------------------------------- scaffold starts the history */
  const app = join(base, "app");
  // A blueprint whose spec ships filled, so a fresh scaffold passes its gate.
  const made = await cli([app, "scaffold", "--blueprint", "blueprint-react-node", "--name", "Ledger"]);
  check("scaffold succeeds", made.code, 0);
  check("…with the scaffold as the first commit, under the fallback identity", log(app), ["Agent App|Scaffold Ledger on blueprint-react-node"]);
  check("…reported in its result", made.result?.commit, git(app, "rev-parse", "HEAD"));
  check("…the app's own repository", resolve(git(app, "rev-parse", "--show-toplevel")), resolve(app));
  check("the framework files a package carries are committed", git(app, "ls-files", ".a2app").split("\n"), [".a2app/system-hashes.json", ".a2app/toolkit.json"]);
  ok("credentials are not", !git(app, "ls-files").split("\n").includes(".agent-token"));

  /* ------------------------------------- validate leaves the tree as it was */
  const gated = await cli([app, "validate", "--no-build"]);
  check("validate passes, with version control checked", [gated.code, /✓ version control/.test(gated.out)], [0, true]);
  ok("…its runtime state is ignored, so the tree is still the commit", existsSync(join(app, ".a2app", "gate-pass.json")) && git(app, "status", "--porcelain") === "");

  /* ---------------------------------------------------------------- commit */
  writeFileSync(join(app, "AGENT_APP.md"), `${readFileSync(join(app, "AGENT_APP.md"), "utf8")}\nA ledger.\n`);
  writeFileSync(join(app, "notes.md"), "new\n");
  const nudged = await cli([app, "validate", "--no-build"]);
  ok("validate says the work is uncommitted", /2 uncommitted change\(s\)/.test(nudged.out));
  const committed = await cli([app, "commit", "--message", "Describe the ledger"]);
  check("commit commits every changed path", [committed.code, committed.result?.committed, committed.result?.files], [0, true, ["AGENT_APP.md", "notes.md"]]);
  check("…as one commit with the message", log(app)[0], "Agent App|Describe the ledger");
  const again = await cli([app, "commit", "--message", "Nothing"]);
  check("with nothing changed it commits nothing", [again.code, again.result?.committed, again.result?.commit], [0, false, git(app, "rev-parse", "HEAD")]);
  check("a commit needs a message", (await cli([app, "commit"])).code, 2);

  /* -------------------------------- an app from before the history was kept */
  rmSync(join(app, ".git"), { recursive: true, force: true });
  const bare = await cli([app, "validate", "--no-build"]);
  ok("the gate fails an app in no repository, naming the remedy", bare.code === 1 && bare.result?.failures?.some((f) => f.step.startsWith("version control") && f.message.includes("commit --message")));
  const started = await cli([app, "commit", "--message", "Start the history"]);
  check("commit creates its repository and commits the app", [started.code, started.result?.created, log(app)], [0, true, ["Agent App|Start the history"]]);
  check("…and the gate passes again", (await cli([app, "validate", "--no-build"])).code, 0);

  /* ------------------------------------ an app inside another repository */
  const mono = join(base, "mono");
  mkdirSync(mono);
  git(mono, "init", "-q");
  writeFileSync(join(mono, "other.txt"), "theirs\n");
  git(mono, "add", "other.txt");
  const inner = join(mono, "apps", "board");
  const nested = await cli([inner, "scaffold", "--blueprint", "blueprint-base"]);
  check("an app inside a repository gets none of its own", [nested.code, nested.result?.commit, existsSync(join(inner, ".git"))], [0, null, false]);
  const scoped = await cli([inner, "commit", "--message", "Add the board"]);
  ok("its commit takes only the app's paths", scoped.code === 0 && git(mono, "show", "--name-only", "--format=", "HEAD").split("\n").every((p) => p.startsWith("apps/board/")));
  check("…leaving what else was staged there staged", git(mono, "diff", "--cached", "--name-only"), "other.txt");

  /* ---------------------------------------- ignore rules on an older app */
  const old = join(base, "old");
  mkdirSync(old);
  writeFileSync(join(old, ".gitignore"), "node_modules/\n.a2app/serve.json\n!.a2app/toolkit.json\n");
  ensureIgnoreRules(old, "data");
  const rules = readFileSync(join(old, ".gitignore"), "utf8").split("\n");
  ok("an older .gitignore keeps its own lines", rules[0] === "node_modules/" && rules.includes(".a2app/serve.json"));
  check(
    "…and gains the framework-state block in order, so its negations follow the rule they except",
    rules.slice(rules.indexOf(".a2app/*"), rules.indexOf(".a2app/*") + 3),
    [".a2app/*", "!.a2app/toolkit.json", "!.a2app/system-hashes.json"],
  );
  ensureIgnoreRules(old, "data");
  check("re-running changes nothing", readFileSync(join(old, ".gitignore"), "utf8").split("\n"), rules);
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`history: ${failures.length} check(s) FAILED\n`);
  for (const f of failures) console.log(`  [FAIL] ${f}\n`);
  process.exit(1);
}
console.log("history: all checks passed");
