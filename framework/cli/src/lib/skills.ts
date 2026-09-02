/**
 * Locating the framework skills (spec section 5.2).
 *
 * Skills are plain markdown any agent can read; `skills/index.json` makes
 * selection deterministic. The CLI does not interpret them — it only has to be
 * able to say where they are and copy them somewhere a harness looks, so that a
 * bare `npm i -g agent-app` install carries the knowledge half of the framework and
 * not just the enforcement half.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

export interface SkillEntry {
  name: string;
  activity: string;
  description: string;
  path: string;
  stack?: string;
  toolkit?: string;
}

export interface SkillsIndex {
  version: string;
  description?: string;
  skills: SkillEntry[];
}

/** Candidate roots holding a `skills/index.json`, nearest first. */
function skillsSearchRoots(): string[] {
  const roots: string[] = [];
  const envRoot = process.env["A2APP_SKILLS_DIR"];
  if (envRoot && envRoot.trim() !== "") roots.push(resolve(envRoot));
  // Bundled with a published CLI: dist/lib -> package root -> skills/
  // (copied here by scripts/bundle-skills.mjs at pack time).
  roots.push(resolve(LIB_DIR, "..", "..", "skills"));
  // In-repo dev: dist/lib -> package -> framework -> repo root -> skills/
  roots.push(resolve(LIB_DIR, "..", "..", "..", "..", "skills"));
  return roots;
}

/** The framework skills directory, or null when this build carries none. */
export function findSkillsDir(): string | null {
  for (const root of skillsSearchRoots()) {
    if (existsSync(join(root, "index.json"))) return root;
  }
  return null;
}

/** Read the skills index from `dir`. Throws if it is unreadable or malformed. */
export function readSkillsIndex(dir: string): SkillsIndex {
  const parsed = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as SkillsIndex;
  if (!Array.isArray(parsed.skills)) {
    throw new Error(`${join(dir, "index.json")}: "skills" must be an array`);
  }
  return parsed;
}
