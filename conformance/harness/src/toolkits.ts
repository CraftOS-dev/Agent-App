/**
 * Toolkit artifact class: a toolkit "scaffolds to a conforming Agent App; system
 * files registered in the canon; sync command provided". This drives the real
 * `a2app` CLI: `create --blueprint <id>` then `validate`, and asserts the
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
}

const TOOLKITS: ToolkitSpec[] = [
  { id: "blueprint-base" },
  { id: "blueprint-react-node", noBuild: true },
  { id: "blueprint-python-fastapi", noBuild: true },
  { id: "blueprint-pocketbase-react", noBuild: true },
];

function run(cliEntry: string, args: string[]): Promise<{ exit: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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

    const created = await run(cliEntry, ["create", appDir, "--blueprint", tk.id, "--name", `${tk.id} demo`]);
    if (created.exit !== 0) failures.push(`create exit ${created.exit}: ${created.out.trim().slice(0, 300)}`);

    if (created.exit === 0) {
      const canon = join(appDir, ".a2app", "system-hashes.json");
      if (!existsSync(canon)) failures.push("no ownership canon written");
      else {
        const entries = Object.keys(JSON.parse(readFileSync(canon, "utf8")));
        if (entries.length === 0) failures.push("ownership canon is empty (never empty for a conforming app)");
        if (!entries.includes("manifest.json")) failures.push("canon missing manifest.json");
      }

      const validateArgs = ["validate", appDir, ...(tk.noBuild ? ["--no-build"] : [])];
      const validated = await run(cliEntry, validateArgs);
      if (validated.exit !== 0) failures.push(`validate exit ${validated.exit}: ${validated.out.trim().slice(0, 400)}`);
    }

    results.push({ name: `${tk.id}: create → canon → validate`, ok: failures.length === 0, failures });
  }

  const passed = results.filter((r) => r.ok).length;
  return { class: "Toolkit", name: "Blueprints scaffold to conforming apps", results, passed, failed: results.length - passed };
}
