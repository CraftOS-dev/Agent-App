/**
 * What a package is (framework packaging §1, §5): the files it never carries,
 * what kind of tree it is, whether its system files still match its own canon,
 * and the compatibility placeholders an older catalogue app may hold.
 *
 * Shared by inspect, install and export, so the three can never disagree about
 * what leaves one machine and what arrives on another.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { compareCanon, computeSystemHashes, hasCanon } from "./canon.js";
import { isIgnored, readIgnoreFile, type IgnoreRule } from "./ignore.js";
import { readJsonFile } from "./json.js";
import { PackageRefusedError } from "./packageErrors.js";
import { templateRoot, type ResolvedToolkit } from "./toolkit.js";

/* ---------------------------------------------------------- never carried */

/** Folders never part of a package, at any depth: dependencies the pipeline reinstalls, and version control. */
export const NEVER_CARRIED_DIRS = new Set(["node_modules", ".git"]);

/** Credential files, by name, wherever they sit — plus anything named `*.secret`. */
const CREDENTIAL_NAMES = new Set([".agent-token", ".superuser", ".principal", ".tunnel-secret", ".lan-secret"]);
const SECRET_SUFFIX = ".secret";

/** The only `.a2app/` files a package carries. Everything else there is runtime state (serve, dev, bridge, backups, …). */
const CARRIED_FRAMEWORK_FILES = new Set(["toolkit.json", "system-hashes.json"]);

export interface ExclusionRules {
  /** the toolkit's data directory, root-relative and `/`-separated (`lifecycle.dataDir`) */
  dataDir: string | null;
  /**
   * Ignore-rule sets, each applied on its own: a negation in the package's own
   * file never re-includes what its toolkit's file excludes.
   */
  ignore: IgnoreRule[][];
}

/**
 * The exclusion rules for a tree: §1's fixed list, the toolkit's data
 * directory, and the build output named by the tree's own `.gitignore` and by
 * its toolkit template's `.gitignore` (the declaration a stack already makes).
 */
export function exclusionRules(root: string, toolkit: ResolvedToolkit | null): ExclusionRules {
  const ignore = [readIgnoreFile(join(root, ".gitignore"))];
  if (toolkit !== null) ignore.push(readIgnoreFile(join(templateRoot(toolkit), ".gitignore")));
  const declared = toolkit?.manifest.lifecycle?.dataDir;
  const dataDir = declared === undefined ? "" : declared.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return { dataDir: dataDir === "" ? null : dataDir, ignore };
}

/** Whether §1 says a package never carries `rel` (root-relative, `/`-separated). */
export function neverCarried(rel: string, isDirectory: boolean, rules: ExclusionRules): boolean {
  const segments = rel.split("/");
  const name = segments[segments.length - 1]!;
  if (CREDENTIAL_NAMES.has(name) || name.endsWith(SECRET_SUFFIX)) return true;
  if (NEVER_CARRIED_DIRS.has(name)) return true;
  if (rel === "logs" && isDirectory) return true;
  if (segments.length === 2 && segments[0] === ".a2app" && !CARRIED_FRAMEWORK_FILES.has(name)) return true;
  if (rules.dataDir !== null && rel === rules.dataDir) return true;
  return rules.ignore.some((set) => isIgnored(set, rel, isDirectory));
}

/**
 * Walk a tree, never following a link and never descending into a folder the
 * rules exclude. `visit` receives each kept entry; `excluded` each excluded one.
 */
export function walkPackage(
  root: string,
  rules: ExclusionRules,
  visit: (rel: string, abs: string, kind: "file" | "directory" | "link" | "other") => void,
  excluded: (rel: string, isDirectory: boolean) => void = () => {},
): void {
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      const isDirectory = entry.isDirectory();
      if (neverCarried(rel, isDirectory, rules)) {
        excluded(rel, isDirectory);
        continue;
      }
      if (isDirectory) {
        visit(rel, abs, "directory");
        walk(abs, rel);
      } else if (entry.isSymbolicLink()) {
        visit(rel, abs, "link");
      } else if (entry.isFile()) {
        visit(rel, abs, "file");
      } else {
        visit(rel, abs, "other");
      }
    }
  };
  walk(root, "");
}

/** Every path in `root` a package never carries: folders end in `/`, and nothing inside one is listed. */
export function strippable(root: string, rules: ExclusionRules): string[] {
  const out: string[] = [];
  walkPackage(root, rules, () => {}, (rel, isDirectory) => out.push(isDirectory ? `${rel}/` : rel));
  return out;
}

/* ---------------------------------------------------------------- classify */

export type PackageKind = "agent-app" | "living-ui" | "foreign";
/** What to do with a tree that is not an installable package (framework packaging §7). */
export type Route = "adopt" | "convert";

export interface Classified {
  kind: PackageKind;
  manifest: Record<string, unknown> | null;
  /** why it is not an Agent App package, or null when it is one */
  reason: string | null;
  routes: Route[];
}

/**
 * What kind of tree this is, decided by the structure of its `manifest.json`
 * (framework packaging §5), never by names or file contents elsewhere:
 *  - agent-app: a framework manifest — `agentAppVersion` as a string, and `modules`;
 *  - living-ui: a CraftBot Living UI manifest — `livingUIVersion`, or a numeric `agentAppVersion`;
 *  - foreign: anything else, including no manifest at all.
 */
export function classify(root: string): Classified {
  const file = join(root, "manifest.json");
  const foreign = (why: string, manifest: Record<string, unknown> | null): Classified => ({
    kind: "foreign",
    manifest,
    reason:
      `${why}: it is not an Agent App package. Adopt it as it is behind the sidecar adapter (blueprint-sidecar), ` +
      "or convert it by rebuilding it; the importer skill decides which with the person.",
    routes: ["adopt", "convert"],
  });
  let manifest: unknown;
  try {
    if (!statSync(file).isFile()) throw new Error("not a file");
  } catch {
    return foreign("there is no manifest.json at its root", null);
  }
  try {
    manifest = readJsonFile(file);
  } catch {
    return foreign("its manifest.json is not valid JSON", null);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return foreign("its manifest.json is not a JSON object", null);
  }
  const m = manifest as Record<string, unknown>;
  if (m["livingUIVersion"] !== undefined || typeof m["agentAppVersion"] === "number") {
    const version = m["livingUIVersion"] ?? m["agentAppVersion"];
    return {
      kind: "living-ui",
      manifest: m,
      reason:
        `a CraftBot Living UI app (version ${JSON.stringify(version)}), not an Agent App package: it is not installable as it is. ` +
        "The importer skill converts it: scaffold on the matching blueprint, then rebuild it from the source kept read-only in reference/source/.",
      routes: ["convert"],
    };
  }
  if (typeof m["agentAppVersion"] === "string" && Array.isArray(m["modules"])) {
    return { kind: "agent-app", manifest: m, reason: null, routes: [] };
  }
  return foreign("its manifest.json is not an Agent App manifest (that needs agentAppVersion as a string, and modules)", m);
}

/* --------------------------------------------------------------- integrity */

export interface Integrity {
  canon: "intact" | "drifted" | "absent";
  changed?: string[];
}

/**
 * A package's system files against its OWN canon (`.a2app/system-hashes.json`).
 * `declared` is what is system-owned — a locally installed toolkit's
 * `systemPaths` — or null to use the canon's own entries. The canon is the
 * package's claim, so an unreadable one, or one naming a path outside the
 * package, reads as drifted rather than stopping the inspection.
 */
export function packageIntegrity(root: string, declared: string[] | null): { integrity: Integrity; warning: string | null } {
  if (!hasCanon(root)) return { integrity: { canon: "absent" }, warning: null };
  try {
    const drift = compareCanon(root, declared);
    const changed = [...drift.modified, ...drift.missing, ...drift.added].sort();
    return { integrity: changed.length === 0 ? { canon: "intact" } : { canon: "drifted", changed }, warning: null };
  } catch (err) {
    return { integrity: { canon: "drifted", changed: [] }, warning: `its canon could not be checked: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------ placeholders */

/**
 * The identity tokens a catalogue app written before this framework may hold
 * (framework packaging §1). A framework-format app needs none: its identity is
 * in manifest.json.
 */
export const IDENTITY_TOKENS = ["PROJECT_ID", "PROJECT_NAME", "PROJECT_DESCRIPTION", "PORT", "BACKEND_PORT", "CREATED_AT"] as const;
/** The tokens whose value is the app's port. */
export const PORT_TOKENS = new Set(["PORT", "BACKEND_PORT"]);

const TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A file's text, or null when it is binary (holds a NUL byte, or is not UTF-8). Binary files are never touched. */
function readText(file: string): string | null {
  const bytes = readFileSync(file);
  if (bytes.includes(0)) return null;
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** The text files under `root` that hold tokens, with the token keys each holds. */
function filesWithTokens(root: string, rules: ExclusionRules, skip: Set<string>): Map<string, { abs: string; text: string; keys: Set<string> }> {
  const out = new Map<string, { abs: string; text: string; keys: Set<string> }>();
  walkPackage(root, rules, (rel, abs, kind) => {
    if (kind !== "file" || skip.has(rel)) return;
    const text = readText(abs);
    if (text === null || !text.includes("{{")) return;
    const keys = new Set([...text.matchAll(TOKEN)].map((m) => m[1]!));
    if (keys.size > 0) out.set(rel, { abs, text, keys });
  });
  return out;
}

/** Every `{{TOKEN}}` in the package's text files, as written, sorted. */
export function findPlaceholders(root: string, rules: ExclusionRules): string[] {
  const keys = new Set<string>();
  for (const { keys: found } of filesWithTokens(root, rules, new Set()).values()) for (const k of found) keys.add(k);
  return [...keys].sort().map((k) => `{{${k}}}`);
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** What a value may not hold to be written raw into a file with no escaping rule of its own. */
const UNSAFE_RAW = /["'\\`$<>\u0000-\u001f\u007f]/;

/** `value` written for a file of this type, or null when it cannot be written there safely. */
function escapeFor(extension: string, value: string): string | null {
  if (extension === ".json") return JSON.stringify(value).slice(1, -1);
  if (extension === ".html" || extension === ".md") return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
  return UNSAFE_RAW.test(value) ? null : value;
}

export interface Substituted {
  files: number;
  /** the keys actually replaced somewhere */
  keys: Set<string>;
}

/**
 * Replace `{{KEY}}` with each value (framework packaging §1): JSON-escaped in
 * `.json`, HTML-escaped in `.html` and `.md`, and raw elsewhere only when the
 * value holds nothing a shell, a script or markup would read as syntax.
 * Everything is checked before anything is written, so a refusal changes no
 * file. `skip` names root-relative files never to touch (the toolkit's system
 * files, which must stay byte-identical to the toolkit's).
 */
export function substitutePlaceholders(root: string, values: Map<string, string>, skip: Set<string>): Substituted {
  const noRules: ExclusionRules = { dataDir: null, ignore: [] };
  const planned: { abs: string; text: string }[] = [];
  const keys = new Set<string>();
  for (const [rel, file] of filesWithTokens(root, noRules, skip)) {
    const extension = extname(rel).toLowerCase();
    let text = file.text;
    for (const key of file.keys) {
      const value = values.get(key);
      if (value === undefined) continue;
      const written = escapeFor(extension, value);
      if (written === null) {
        throw new PackageRefusedError(
          `${rel}: {{${key}}} cannot be written into this file — its value holds a quote, backslash, backtick, $, <, > or a control character`,
        );
      }
      text = text.split(`{{${key}}}`).join(written);
      keys.add(key);
    }
    if (text !== file.text) planned.push({ abs: file.abs, text });
  }
  for (const { abs, text } of planned) writeFileSync(abs, text);
  return { files: planned.length, keys };
}

/** The files a toolkit owns in a tree, root-relative and `/`-separated. */
export function systemFiles(root: string, toolkit: ResolvedToolkit): Set<string> {
  return new Set(Object.keys(computeSystemHashes(root, toolkit.manifest.systemPaths)));
}

/* ------------------------------------------------------------------- names */

/** A folder name for an app: lowercase ASCII, digits and dashes; `app` when nothing usable is left. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug === "" ? "app" : slug;
}
