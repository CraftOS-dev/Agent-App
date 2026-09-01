/**
 * Framework-file validation.
 *
 * These are the files that make an app an Agent App. The gate checks they are
 * present and well-shaped; a third party emits compatible files from the pinned
 * shape, so this validates against that shape, not a reference impl.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrameworkFileProblem {
  file: string;
  message: string;
}

const OP_NAME = /^[a-z][a-z0-9._-]{0,63}$/;

export function validateManifest(projectDir: string): FrameworkFileProblem[] {
  const file = "manifest.json";
  const path = join(projectDir, file);
  if (!existsSync(path)) return [{ file, message: "missing (required framework file)" }];
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return [{ file, message: `not valid JSON: ${(e as Error).message}` }];
  }
  const problems: FrameworkFileProblem[] = [];
  const req = (k: string): void => {
    if (m[k] === undefined || m[k] === null || m[k] === "") {
      problems.push({ file, message: `missing required key "${k}"` });
    }
  };
  for (const k of ["id", "name", "agentAppVersion", "adapterVersion", "authMode", "pipeline"]) req(k);
  if (m.authMode !== undefined && m.authMode !== "none" && m.authMode !== "multi-user") {
    problems.push({ file, message: `authMode must be "none" or "multi-user", got ${JSON.stringify(m.authMode)}` });
  }
  const pipeline = m.pipeline as Record<string, unknown> | undefined;
  if (pipeline && typeof pipeline === "object") {
    for (const k of ["install", "build", "start", "health"]) {
      if (typeof pipeline[k] !== "string" || pipeline[k] === "") {
        problems.push({ file, message: `pipeline.${k} must be a non-empty string` });
      }
    }
  } else if (m.pipeline !== undefined) {
    problems.push({ file, message: "pipeline must be an object with install/build/start/health" });
  }
  return problems;
}

export function validateOperations(projectDir: string): FrameworkFileProblem[] {
  const file = "operations.json";
  const path = join(projectDir, file);
  if (!existsSync(path)) return []; // operations.json is optional for a data-only app
  let parsed: { operations?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { operations?: unknown };
  } catch (e) {
    return [{ file, message: `not valid JSON: ${(e as Error).message}` }];
  }
  if (!Array.isArray(parsed.operations)) {
    return [{ file, message: '"operations" must be an array' }];
  }
  const problems: FrameworkFileProblem[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.operations as Record<string, unknown>[]) {
    const name = raw.name;
    if (typeof name !== "string" || !OP_NAME.test(name)) {
      problems.push({ file, message: `invalid op name: ${JSON.stringify(name)} (must match ${OP_NAME})` });
      continue;
    }
    if (seen.has(name)) problems.push({ file, message: `duplicate op name: ${name}` });
    seen.add(name);
    if (typeof raw.destructive !== "boolean") {
      problems.push({ file, message: `${name}: "destructive" (boolean) is required` });
    }
  }
  return problems;
}

/** Required top-level markdown sections. */
const AGENT_APP_SECTIONS = ["Plan", "Entities", "Operations", "Conventions", "Checklist"];
const REQUIREMENTS_SECTIONS = ["Overview", "Features", "Data", "Design", "Operations"];

function checkMarkdownSections(
  projectDir: string,
  file: string,
  sections: string[],
): FrameworkFileProblem[] {
  const path = join(projectDir, file);
  if (!existsSync(path)) return [{ file, message: "missing (required framework file)" }];
  const src = readFileSync(path, "utf8");
  const headings = new Set(
    src
      .split("\n")
      .filter((l) => /^#{1,3}\s+/.test(l))
      .map((l) => l.replace(/^#{1,3}\s+/, "").trim().toLowerCase()),
  );
  const problems: FrameworkFileProblem[] = [];
  for (const section of sections) {
    if (![...headings].some((h) => h.startsWith(section.toLowerCase()))) {
      problems.push({ file, message: `missing required section "## ${section}"` });
    }
  }
  return problems;
}

export function validateAgentAppDoc(projectDir: string): FrameworkFileProblem[] {
  return checkMarkdownSections(projectDir, "AGENT_APP.md", AGENT_APP_SECTIONS);
}

export function validateRequirementsDoc(projectDir: string): FrameworkFileProblem[] {
  return checkMarkdownSections(
    projectDir,
    join("reference", "requirements.md"),
    REQUIREMENTS_SECTIONS,
  );
}

/** Run every framework-file check. */
export function validateFrameworkFiles(projectDir: string): FrameworkFileProblem[] {
  return [
    ...validateManifest(projectDir),
    ...validateOperations(projectDir),
    ...validateAgentAppDoc(projectDir),
    ...validateRequirementsDoc(projectDir),
  ];
}
