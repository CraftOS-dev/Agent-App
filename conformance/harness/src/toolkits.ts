/**
 * Toolkit artifact class: a toolkit "scaffolds to a conforming Agent App; system
 * files registered in the canon; sync command provided". This drives the real
 * `agent-app` CLI: `<dir> scaffold --blueprint <id>` then `<dir> validate`, and asserts the
 * ownership canon exists and is non-empty.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CheckResult, SuiteResult } from "./runner.js";

interface ToolkitSpec {
  id: string;
  /** react-node's real build needs `npm install` of a published adapter, so its
   *  gate is checked with --no-build (Toolkit class validates the scaffold). */
  noBuild?: boolean;
  /**
   * This blueprint scaffolds a STARTING POINT, not a finished app, so `validate`
   * is expected to REFUSE a fresh scaffold and name the spec as unauthored —
   * that refusal is the blueprint working, not failing.
   *
   * Asserting `validate` passes here would demand a spec for an app that does
   * not exist yet, and the only way to satisfy it would be to write a fictional
   * one. The check is inverted instead, so the suite states the real contract
   * rather than a wish: a starting point is not a finished app, and `validate`
   * saying so on every app that is not done is the whole point of `validate`.
   *
   * The string says WHY for each, because "incomplete" is a claim that should
   * age badly if someone finishes the blueprint and forgets this line.
   */
  incompleteBecause?: string;
}

const TOOLKITS: ToolkitSpec[] = [
  // Framework files and no runtime code at all: no entities, no operations, a
  // pipeline of placeholder echoes. The author picks the stack.
  { id: "blueprint-base", incompleteBecause: "ships framework files only, no runtime code" },
  // The one finished starter: a to-do app with a View, a model and operations.
  { id: "blueprint-react-node", noBuild: true },
  // Runtime and model are complete, but the spec is the author's to write — the
  // blueprint ships the template unfilled on purpose, like the other two
  // starting points. Writing one on its behalf would put words in the mouth of
  // whoever owns the blueprint.
  {
    id: "blueprint-python-fastapi",
    noBuild: true,
    incompleteBecause: "ships the requirements template unfilled; the spec is the author's to write",
  },
  // Ships adapter hooks only. Its `tasks` collection is created by hand in
  // PocketBase, and `install` prints "download the pocketbase binary" — so a
  // fresh scaffold has neither data model nor runtime.
  {
    id: "blueprint-pocketbase-react",
    noBuild: true,
    incompleteBecause: "ships adapter hooks only; collections and the binary are added by hand",
  },
];

/**
 * Run the CLI against a THROWAWAY framework home, so scaffolding disposable test
 * apps never registers them in the user's real app registry (framework 5.6).
 * A suite that pollutes the machine it runs on is not a clean-room suite.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), "a2app-conf-home-"));

function run(cliEntry: string, args: string[]): Promise<{ exit: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, A2APP_HOME: TEST_HOME },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ exit: code ?? -1, out }));
    child.on("error", (e) => resolve({ exit: -1, out: String(e) }));
  });
}

export async function runToolkitClass(cliEntry: string | null): Promise<SuiteResult> {
  const results: CheckResult[] = [];
  if (!cliEntry) {
    return { class: "Toolkit", name: "Blueprints scaffold to conforming apps", results: [{ name: "toolkit class", ok: true, failures: ["(skipped: CLI unavailable)"] }], passed: 1, failed: 0 };
  }

  for (const tk of TOOLKITS) {
    const base = mkdtempSync(join(tmpdir(), `a2app-tk-${tk.id}-`));
    const appDir = join(base, "app");
    const failures: string[] = [];

    // App-first grammar (framework spec 5.1): `agent-app <dir> <verb> [args]`.
    const created = await run(cliEntry, [appDir, "scaffold", "--blueprint", tk.id, "--name", `${tk.id} demo`]);
    if (created.exit !== 0) failures.push(`scaffold exit ${created.exit}: ${created.out.trim().slice(0, 300)}`);

    if (created.exit === 0) {
      const canon = join(appDir, ".a2app", "system-hashes.json");
      if (!existsSync(canon)) failures.push("no ownership canon written");
      else {
        const entries = Object.keys(JSON.parse(readFileSync(canon, "utf8")));
        if (entries.length === 0) failures.push("ownership canon is empty (never empty for a conforming app)");
        if (!entries.includes("manifest.json")) failures.push("canon missing manifest.json");
      }

      const validateArgs = [appDir, "validate", ...(tk.noBuild ? ["--no-build"] : [])];
      const validated = await run(cliEntry, validateArgs);
      if (tk.incompleteBecause) {
        // The refusal IS the contract here: a starting point with no entities and
        // no operations must not be able to pass as a finished app, or `validate`
        // means nothing on the apps that are.
        if (validated.exit === 0) {
          failures.push(`validate passed a scaffold that ${tk.incompleteBecause} — an unauthored spec must not pass`);
        } else if (!/not authored/.test(validated.out)) {
          failures.push(`validate refused for the wrong reason: ${validated.out.trim().slice(0, 300)}`);
        }
      } else if (validated.exit !== 0) {
        failures.push(`validate exit ${validated.exit}: ${validated.out.trim().slice(0, 400)}`);
      }
    }

    results.push({ name: `${tk.id}: scaffold → canon → ${tk.incompleteBecause ? "validate refuses (starting point, not a finished app)" : "validate"}`, ok: failures.length === 0, failures });
  }

  const passed = results.filter((r) => r.ok).length;
  return { class: "Toolkit", name: "Blueprints scaffold to conforming apps", results, passed, failed: results.length - passed };
}
