/**
 * Linking a scaffolded app to unpublished packages that live in the toolkit's
 * own repository.
 *
 * A blueprint template declares its adapter as an ordinary registry dependency
 * (`"@a2app/adapter-core": "^0.1.0"`). That is the right thing to ship once the
 * package is published — but while it is not, every app scaffolded outside the
 * repo's own workspace fails `npm install` with a 404, and therefore fails the
 * build gate on step one, before its author has written a line.
 *
 * So at scaffold time each dependency is checked against the packages that
 * actually exist in the toolkit's repository. A match is rewritten to a `file:`
 * path relative to the new app; anything with no local match is left exactly as
 * the blueprint declared it. That makes the behaviour degrade in the right
 * direction: a CLI installed from npm, with only bundled blueprints and no
 * source tree beside them, finds nothing and changes nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "./home.js";

/** Directories that never contain a workspace package worth linking. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".a2app", ".lui", "coverage"]);

/** How far below the repo root a package may sit (`adapters/adapter-core` = 2). */
const MAX_DEPTH = 2;

/**
 * The repository a toolkit belongs to: the nearest ancestor holding a workspace
 * marker. Without one there is no source tree to link against — a bundled
 * blueprint inside an installed CLI is the normal case here.
 */
function repoRootOf(toolkitSource: string): string | null {
  let dir = resolve(toolkitSource);
  for (;;) {
    for (const marker of ["pnpm-workspace.yaml", "pnpm-workspace.yml", ".git"]) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every package name in the repo, mapped to the directory declaring it. */
function localPackageIndex(repoRoot: string): Map<string, string> {
  const found = new Map<string, string>();

  const visit = (dir: string, depth: number): void => {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        // First declaration wins, so a nested copy never shadows the real one.
        if (typeof pkg.name === "string" && pkg.name && !found.has(pkg.name)) {
          found.set(pkg.name, dir);
        }
      } catch {
        /* an unparseable package.json is simply not a link target */
      }
    }
    if (depth >= MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry) || entry.startsWith(".")) continue;
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) visit(child, depth + 1);
      } catch {
        /* unreadable entry */
      }
    }
  };

  visit(repoRoot, 0);
  return found;
}

/**
 * The `file:` specifier pointing from an app at a package directory.
 *
 * Relative when it can be, so the app stays movable as a unit with its repo.
 * But `relative()` cannot express a path between two Windows drives — asked for
 * one it hands back the absolute target, which then has to be used AS an
 * absolute path. Prefixing that with `./` produced `file:./D:/…`, a specifier
 * npm resolves to a directory that does not exist.
 */
function specifierFor(projectDir: string, packageDir: string): string | null {
  const abs = resolve(packageDir);
  const rel = relative(projectDir, abs);
  if (rel === "") return null;
  const posix = (p: string): string => p.split(sep).join("/");
  // A different filesystem root: no relative path exists, so anchor absolutely.
  if (isAbsolute(rel)) return `file:${posix(abs)}`;
  const slashed = posix(rel);
  return `file:${slashed.startsWith(".") ? slashed : `./${slashed}`}`;
}

/** One rewritten dependency, for reporting. */
export interface LinkedDependency {
  name: string;
  from: string;
  to: string;
}

/**
 * Rewrite a scaffolded app's dependencies on packages that live in the
 * toolkit's repository to `file:` paths. Returns what it changed; an empty
 * array means the app's package.json was left untouched.
 */
export function linkLocalPackages(projectDir: string, toolkitSource: string): LinkedDependency[] {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return [];

  const repoRoot = repoRootOf(toolkitSource);
  if (repoRoot === null) return [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }

  const index = localPackageIndex(repoRoot);
  if (index.size === 0) return [];

  const linked: LinkedDependency[] = [];
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = pkg[section];
    if (deps === null || typeof deps !== "object") continue;
    const table = deps as Record<string, unknown>;
    for (const [name, spec] of Object.entries(table)) {
      const dir = index.get(name);
      if (dir === undefined) continue;
      // Leave anything already pointing somewhere concrete alone — the blueprint
      // author meant it, and `workspace:` is pnpm's own linking.
      if (typeof spec === "string" && (spec.startsWith("file:") || spec.startsWith("link:") || spec.startsWith("workspace:"))) {
        continue;
      }
      const target = specifierFor(projectDir, dir);
      if (target === null) continue;
      table[name] = target;
      linked.push({ name, from: typeof spec === "string" ? spec : String(spec), to: target });
    }
  }

  if (linked.length > 0) writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return linked;
}
