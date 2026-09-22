/**
 * The framework's six skills, registered into dsh's skill registry.
 *
 * dsh has no per-bundle skill discovery. Its only filesystem provider
 * (`@deepseek-ai/dsh-skill-filesystem`) scans configured roots — and in the
 * shipped `web` profile that row is `disabled: true`, so a bundle's `skills/`
 * directory is inert on its own and `DSH_BUNDLED_SKILL_DIR` is ignored too.
 * A packaged plugin ships skills by registering a provider; this mirrors
 * `@deepseek-ai/dsh-skill-badge`, the reference for exactly that.
 *
 * The types below are declared locally on purpose: `@deepseek-ai/dsh-skill` is
 * a dsh-internal package and this bundle must not require it at runtime (see
 * the `//peer` note in package.json). Only the shapes this file touches are
 * restated, and `BUNDLED_SKILL_RANK` is the one constant worth knowing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The six skills ship beside the bundle, so `dist/lib/index.js` sees `dist/skills/`. */
const SKILLS_DIR_URL = new URL("../skills/", import.meta.url);

/** dsh's `BUNDLED_SKILL_RANK` (packages/skill/skill/src/index.ts): lower ranks win. */
const BUNDLED_SKILL_RANK = 600;

const PROVIDER_NAME = "agent-app";

/** The metadata every skill carries into the model-facing catalog. */
interface SkillSummary {
  /** Absolute instruction path, so the host can open the skill file. */
  readonly path?: string;
  readonly name: string;
  readonly description: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  readonly source: string;
  readonly provider: string;
  readonly resourceBase?: { readonly kind: "directory"; readonly path: string };
}

interface SkillCandidate extends SkillSummary {
  readonly rank: number;
  readonly locator: unknown;
}

interface SkillDefinition extends SkillSummary {
  readonly content: string;
}

interface SkillProvider {
  readonly name: string;
  list(): Promise<readonly SkillCandidate[]>;
  get(candidate: SkillCandidate): Promise<SkillDefinition | undefined>;
}

/** The slice of dsh's skill registry this module registers into. */
export interface SkillHost {
  skills: { registerProvider(create: () => SkillProvider): () => void };
}

/**
 * Read the `key: value` frontmatter block the skill contract requires.
 * Deliberately minimal — the contract allows `name`, `activity`, `description`
 * and an optional `stack`/`toolkit`; a skill needing more YAML than this is
 * outside what this provider promises, and is skipped rather than mis-parsed.
 */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (block === undefined) return {};
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    const key = kv?.[1];
    if (key === undefined) continue;
    let value = (kv?.[2] ?? "").trim();
    // walk-verify quotes its description; the other five do not.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** The instruction body, with the frontmatter block removed. */
function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/.exec(text);
  return m === null ? text : text.slice(m[0].length);
}

/**
 * Register the bundled skills. Returns the registry's disposer, so the caller
 * can hand it to `ctx.effect` and have the provider removed on unload. A bundle
 * whose `skills/` directory is absent registers nothing rather than failing.
 */
export function registerSkills(ctx: SkillHost): () => void {
  const dir = fileURLToPath(SKILLS_DIR_URL);
  if (!existsSync(dir)) return () => {};

  const resourceBase = { kind: "directory" as const, path: dir };
  // Types are asserted locally: @types/node is not a dependency here (dsh
  // supplies it), so readdirSync resolves to `any` and would otherwise trip
  // noImplicitAny and collapse every downstream inference.
  const dirents = readdirSync(dir, { withFileTypes: true }) as readonly {
    name: string;
    isDirectory(): boolean;
  }[];

  const entries: { candidate: SkillCandidate; file: string }[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const file = join(dir, dirent.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const meta = frontmatter(readFileSync(file, "utf8"));
    const name = (meta.name ?? "").trim();
    const description = (meta.description ?? "").trim();
    if (name === "" || description === "") continue;
    entries.push({
      file,
      candidate: {
        path: file,
        name,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: "bundled",
        provider: PROVIDER_NAME,
        resourceBase,
        rank: BUNDLED_SKILL_RANK,
        locator: file,
      },
    });
  }

  if (entries.length === 0) return () => {};
  const byName = new Map(entries.map((entry) => [entry.candidate.name, entry]));

  const provider: SkillProvider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(entries.map((entry) => entry.candidate)),
    get: (candidate) => {
      const entry = byName.get(String(candidate.name));
      if (entry === undefined) return Promise.resolve(undefined);
      return Promise.resolve({ ...entry.candidate, content: stripFrontmatter(readFileSync(entry.file, "utf8")) });
    },
  };

  return ctx.skills.registerProvider(() => provider);
}
