/**
 * agent-app <dir> walk-verify — run the walk-verify checks against the RUNNING app.
 * The full feature-by-feature, browser-driven verification is delivered as the
 * walk-verify SKILL (so a verifier agent, distinct from the builder, drives the
 * real UI). This command does the machine-checkable part: the app mounts and
 * answers, its A2App surface is reachable, and it enumerates the
 * `reference/requirements.md` Features the verifier must exercise — emitting a
 * checklist the verifier fills, so the builder never grades itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFor, loadProject } from "../lib/project.js";
import { log } from "../lib/log.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const client = await clientFor(project);
  const checks: Check[] = [];

  // 1. Health / mount.
  const health = project.manifest.pipeline.health || "/api/health";
  let mounted = false;
  try {
    const res = await client.request("GET", health.startsWith("/") ? health : `/${health}`);
    mounted = res.ok;
    checks.push({ name: `health (${health})`, ok: res.ok, detail: `HTTP ${res.status}` });
  } catch (err) {
    checks.push({ name: `health (${health})`, ok: false, detail: (err as Error).message });
  }

  // 2. Identity marker + supported protocol.
  const id = await client.identity();
  checks.push({
    name: "identity (a2app marker)",
    ok: id !== null,
    detail: id ? `protocol ${id.protocol}, adapter ${id.adapterVersion}` : "no marker",
  });

  // 3. Describe reachable.
  const described = await client.describe();
  checks.push({
    name: "describe (data model)",
    ok: described !== null,
    detail: described ? `${Object.keys(described.entities).length} entities` : "unreachable",
  });

  // 4. Requirements features enumerated.
  const features = readFeatures(project.dir);
  checks.push({
    name: "reference/requirements.md Features",
    ok: features.length > 0,
    detail: `${features.length} feature statement(s)`,
  });

  const blocked = !mounted;
  const allOk = checks.every((c) => c.ok);
  const verdict = {
    verdict: blocked ? "blocked" : allOk ? "incomplete" : "defects",
    checks,
    features,
    note: blocked
      ? "App is not reachable — environment unavailable (not a failure). Launch it and retry."
      : "Machine checks only. A verifier agent (NOT the builder) must now drive each feature above in a browser and set the verdict to pass or defects.",
  };
  for (const c of checks) (c.ok ? log.ok : log.error).call(log, `${c.name}: ${c.detail ?? ""}`);
  log.raw(JSON.stringify(verdict, null, 2));
  // Announcement gates on a real `pass`, which only a verifier agent driving the
  // browser can produce — this machine preflight NEVER pass-es on its own. So a
  // non-`pass` verdict (incomplete/defects/blocked) must never exit 0, or a
  // caller treating exit 0 as "verified" would announce an unverified app.
  void allOk;
  void blocked;
  return verdict.verdict === "pass" ? 0 : 1;
}

/** Extract the "## Features" list items as checkable capability statements. */
function readFeatures(projectDir: string): string[] {
  const path = join(projectDir, "reference", "requirements.md");
  if (!existsSync(path)) return [];
  const src = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let inFeatures = false;
  for (const line of src) {
    if (/^#{1,3}\s+/.test(line)) inFeatures = /^#{1,3}\s+features\b/i.test(line);
    else if (inFeatures) {
      const m = line.match(/^\s*[-*]\s+(.*\S)/);
      if (m) out.push(m[1]!);
    }
  }
  return out;
}
