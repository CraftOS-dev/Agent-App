/**
 * `a2app-conformance` — boot the reference app and run every YAML suite in
 * `conformance/suites/` against it. Exit 0 iff every class-A check passes (class
 * A is required for a stable release); class B is skipped with a clear notice if
 * the CLI is not built, per "claim only the class you fully pass".
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startReferenceApp } from "./reference-app.js";
import { parseSuite, runSuite, type RunContext, type SuiteResult } from "./runner.js";
import { runToolkitClass } from "./toolkits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = resolve(HERE, "..", "..", "suites");

function findCliEntry(): string | null {
  const candidates = [
    resolve(HERE, "..", "node_modules", "a2app", "dist", "cli.js"),
    resolve(HERE, "..", "..", "..", "node_modules", "a2app", "dist", "cli.js"),
    resolve(HERE, "..", "..", "..", "framework", "cli", "dist", "cli.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function makeProjectDir(port: number, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "a2app-conf-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        id: "conformance_kanban",
        name: "Conformance Kanban",
        agentAppVersion: "0.1.0",
        adapterVersion: "0.1.0",
        authMode: "none",
        pipeline: { install: "true", build: "true", start: "true", health: "/api/_a2app" },
        port,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, ".agent-token"), token + "\n", { mode: 0o600 });
  return dir;
}

function report(results: SuiteResult[]): number {
  let anyRequiredFail = 0;
  console.log("\nA2App / Agent App conformance\n" + "=".repeat(40));
  for (const s of results) {
    const head = `Class ${s.class} — ${s.name}: ${s.passed}/${s.results.length}`;
    console.log(`\n${head}`);
    for (const r of s.results) {
      const mark = r.ok ? "  ok  " : " FAIL ";
      console.log(`  [${mark}] ${r.name}`);
      if (!r.ok) for (const f of r.failures) console.log(`         - ${f}`);
    }
    if (s.failed > 0 && s.class === "A") anyRequiredFail += s.failed;
  }
  const total = results.reduce((n, s) => n + s.results.length, 0);
  const failed = results.reduce((n, s) => n + s.failed, 0);
  console.log("\n" + "=".repeat(40));
  console.log(`Total: ${total - failed}/${total} passed, ${failed} failed.`);
  if (anyRequiredFail > 0) console.log(`Class A (required for stable) has ${anyRequiredFail} failure(s).`);
  return anyRequiredFail > 0 ? 1 : failed > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  if (!existsSync(SUITES_DIR)) {
    console.error(`No suites directory at ${SUITES_DIR}`);
    return 2;
  }
  const ref = await startReferenceApp();
  const cliEntry = findCliEntry();
  const projectDir = makeProjectDir(ref.port, ref.fullToken);

  const ctx: RunContext = {
    baseUrl: ref.url,
    tokens: { full: ref.fullToken, readonly: ref.readonlyToken },
    ...(cliEntry ? { cli: { entry: cliEntry, projectDir } } : {}),
    vars: new Map<string, unknown>(),
  };

  if (!cliEntry) {
    console.log("Note: a2app CLI not built — class B checks will be skipped.");
  }

  // Seed a task so class C can drive the lifecycle over HTTP.
  ref.app.trigger({ type: "card.due_soon", payload: { card: "card_seed" }, capability: "summarize" });

  const results: SuiteResult[] = [];
  const files = readdirSync(SUITES_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  for (const file of files) {
    const suite = parseSuite(readFileSync(join(SUITES_DIR, file), "utf8"));
    results.push(await runSuite(suite, ctx));
  }

  // Artifact class: Toolkit — blueprints scaffold to conforming apps.
  results.push(await runToolkitClass(cliEntry));

  const code = report(results);
  await ref.close();
  return code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
