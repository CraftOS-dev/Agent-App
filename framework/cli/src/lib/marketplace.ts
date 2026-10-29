/**
 * The marketplace (framework packaging §2): where the catalogue comes from,
 * what an entry may say, and whether this machine can run what it lists.
 *
 * A marketplace is a GitHub repository holding `catalogue.json` and one folder
 * per app — or, for offline use and tests, a local directory laid out the same
 * way. The catalogue is read from the raw file; an app is taken out of the
 * branch archive (see sources.ts), so both always come from the same ref.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { downloadBytes } from "./download.js";
import { homeDir, homePath } from "./home.js";
import { readJsonFile } from "./json.js";
import { AGENT_APP_VERSION } from "./manifest.js";
import { PackageRefusedError } from "./packageErrors.js";
import { EnvError, UsageError } from "./project.js";
import { installedToolkit } from "./toolkit.js";

/** The marketplace this framework publishes to, and the one CraftBot has published to so far. */
const DEFAULT_MARKETPLACE = { owner: "CraftOS-dev", repo: "agent-app-collection" };
const FALLBACK_MARKETPLACE = { owner: "CraftOS-dev", repo: "living-ui-marketplace" };
const DEFAULT_REF = "main";

const MiB = 1024 * 1024;
/** A catalogue is a list of apps, not an app: a few kilobytes in practice. */
const CATALOGUE_LIMITS = { maxBytes: 8 * MiB, timeoutMs: 30_000 };

export interface GithubRepo {
  owner: string;
  repo: string;
  ref: string;
}

export type Marketplace = ({ kind: "github" } & GithubRepo) | { kind: "local"; dir: string };

/** How a marketplace is written: `github:<owner>/<repo>@<ref>`, or its directory. */
export function marketplaceLocation(m: Marketplace): string {
  return m.kind === "github" ? `github:${m.owner}/${m.repo}@${m.ref}` : m.dir;
}

/* ---------------------------------------------------------------- GitHub */

/**
 * Where GitHub is.
 *
 * TEST ONLY: `A2APP_TEST_GITHUB_BASE` serves both the raw files and the branch
 * archives from one origin, with GitHub's own paths below it — so the test
 * suite can stand up a fake GitHub with no network. It must be a loopback
 * http:// origin: it can never point an install at another real host.
 */
function githubBases(): { raw: string; web: string } {
  const test = process.env["A2APP_TEST_GITHUB_BASE"];
  if (test !== undefined && test !== "") {
    let url: URL;
    try {
      url = new URL(test);
    } catch {
      throw new UsageError(`A2APP_TEST_GITHUB_BASE is not a URL: ${test}`);
    }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new UsageError("A2APP_TEST_GITHUB_BASE is for tests only and must be a loopback http:// origin");
    }
    const base = test.replace(/\/+$/, "");
    return { raw: base, web: base };
  }
  return { raw: "https://raw.githubusercontent.com", web: "https://github.com" };
}

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** A file in a repository at a ref, as raw.githubusercontent.com serves it. */
export function rawUrl(repo: GithubRepo, path: string): string {
  return `${githubBases().raw}/${encodePath(repo.owner)}/${encodePath(repo.repo)}/${encodePath(repo.ref)}/${encodePath(path)}`;
}

/** The branch archive (§2). */
export function archiveUrl(repo: GithubRepo): string {
  return `${githubBases().web}/${encodePath(repo.owner)}/${encodePath(repo.repo)}/archive/refs/heads/${encodePath(repo.ref)}.zip`;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]+$/;

/** A branch name this CLI will put in a URL or hand to git: no `..`, no leading `-`, nothing but name characters. */
export function validRef(ref: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");
}

/** A path inside a repository, as segments: never empty, `.` or `..`. */
export function validRepoPath(segments: string[]): boolean {
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && !/[\\:\0]/.test(s));
}

/** The ref used when a source names none: A2APP_MARKETPLACE_REF, else main. */
export function defaultRef(): string {
  const configured = process.env["A2APP_MARKETPLACE_REF"]?.trim();
  if (configured === undefined || configured === "") return DEFAULT_REF;
  if (!validRef(configured)) throw new UsageError(`A2APP_MARKETPLACE_REF is not a usable branch name: ${configured}`);
  return configured;
}

/**
 * Parse `github:<owner>/<repo>[@<ref>][/<path>]`. A ref ends at the first `/`:
 * a branch whose name holds a slash is written with the https form's
 * `/tree/<ref>` only where it is the last part.
 */
export function parseGithubShorthand(spec: string, allowPath: boolean): GithubRepo & { path: string[]; refGiven: boolean } {
  const body = spec.slice("github:".length);
  const m = /^([^/@]+)\/([^/@]+)(?:@([^/]+))?(?:\/(.*))?$/.exec(body);
  const path = m?.[4] === undefined ? [] : m[4].split("/").filter((s) => s !== "");
  if (m === null || !OWNER.test(m[1]!) || !REPO.test(m[2]!) || m[2] === "." || m[2] === "..") {
    throw new UsageError(`Not a GitHub source: ${spec} — write github:<owner>/<repo>[@<ref>]${allowPath ? "[/<path>]" : ""}`);
  }
  if (m[3] !== undefined && !validRef(m[3])) throw new UsageError(`Not a usable branch name: ${m[3]}`);
  if (path.length > 0 && (!allowPath || !validRepoPath(path))) {
    throw new UsageError(allowPath ? `Not a usable path in a repository: ${m[4]}` : `A marketplace is a whole repository: ${spec} names a path inside one`);
  }
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), ref: m[3] ?? defaultRef(), path, refGiven: m[3] !== undefined };
}

/* ----------------------------------------------------------- the source */

/** `github:<owner>/<repo>[@<ref>]`, or a directory holding catalogue.json; relative directories resolve against `base`. */
export function parseMarketplace(spec: string, base: string): Marketplace {
  if (spec.startsWith("github:")) {
    const { owner, repo, ref } = parseGithubShorthand(spec, false);
    return { kind: "github", owner, repo, ref };
  }
  const dir = isAbsolute(spec) ? resolve(spec) : resolve(base, spec);
  if (!existsSync(join(dir, "catalogue.json"))) {
    throw new UsageError(`Not a marketplace: ${spec} is neither github:<owner>/<repo>[@<ref>] nor a directory holding catalogue.json`);
  }
  return { kind: "local", dir };
}

/** `marketplace` from `$A2APP_HOME/settings.json`, when set. */
function settingsMarketplace(): string | undefined {
  const file = homePath("settings.json");
  if (!existsSync(file)) return undefined;
  let settings: unknown;
  try {
    settings = readJsonFile(file);
  } catch (err) {
    throw new EnvError((err as Error).message);
  }
  const value = (settings as { marketplace?: unknown } | null)?.marketplace;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new EnvError(`${file}: "marketplace" must be a non-empty string`);
  return value.trim();
}

/**
 * The marketplaces to try, in order (§2): `--source`, else A2APP_MARKETPLACE,
 * else settings.json, else the default with its one fallback. Only the default
 * falls back: a source someone configured is the only one they meant.
 */
function candidates(explicit: string | undefined): { list: Marketplace[]; configured: boolean } {
  if (explicit !== undefined) return { list: [parseMarketplace(explicit, process.cwd())], configured: true };
  const fromEnv = process.env["A2APP_MARKETPLACE"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return { list: [parseMarketplace(fromEnv, process.cwd())], configured: true };
  const fromSettings = settingsMarketplace();
  if (fromSettings !== undefined) return { list: [parseMarketplace(fromSettings, homeDir())], configured: true };
  const ref = defaultRef();
  return {
    list: [
      { kind: "github", ...DEFAULT_MARKETPLACE, ref },
      { kind: "github", ...FALLBACK_MARKETPLACE, ref },
    ],
    configured: false,
  };
}

/* ------------------------------------------------------------- catalogue */

export interface CustomField {
  key: string;
  label: string;
  type?: "text";
  default?: string;
  placeholder?: string;
}

/** One app a catalogue lists (schema `catalogue.schema.json`). Unknown keys are carried through untouched. */
export interface CatalogueEntry {
  id: string;
  name: string;
  folder: string;
  description?: string;
  tags?: string[];
  version?: string;
  preview?: string;
  customizable?: CustomField[];
  agentAppVersion?: string | number;
  livingUIVersion?: number;
  toolkit?: string;
  [key: string]: unknown;
}

export interface Catalogue {
  version?: string;
  apps: CatalogueEntry[];
}

const KEY = /^[A-Z][A-Z0-9_]*$/;

/** Why one entry cannot be used, or null. */
function entryProblem(e: Record<string, unknown>): string | null {
  const optionalString = (k: string): boolean => e[k] === undefined || typeof e[k] === "string";
  if (typeof e["id"] !== "string" || e["id"] === "") return "has no id";
  if (typeof e["name"] !== "string") return "has no name";
  const folder = e["folder"];
  if (typeof folder !== "string" || folder === "" || folder.startsWith("/") || !validRepoPath(folder.replace(/\/+$/, "").split("/"))) {
    return "has no usable folder (a path inside the repository)";
  }
  for (const k of ["description", "version", "preview", "toolkit"]) if (!optionalString(k)) return `has a ${k} that is not a string`;
  if (e["tags"] !== undefined && !(Array.isArray(e["tags"]) && e["tags"].every((t) => typeof t === "string"))) return "has tags that are not strings";
  if (e["agentAppVersion"] !== undefined && typeof e["agentAppVersion"] !== "string" && typeof e["agentAppVersion"] !== "number") {
    return "has an agentAppVersion that is neither a string nor a number";
  }
  if (e["livingUIVersion"] !== undefined && typeof e["livingUIVersion"] !== "number") return "has a livingUIVersion that is not a number";
  const fields = e["customizable"];
  if (fields !== undefined) {
    if (!Array.isArray(fields)) return "has customizable fields that are not a list";
    for (const f of fields as Record<string, unknown>[]) {
      if (f === null || typeof f !== "object") return "has a customizable field that is not an object";
      if (typeof f["key"] !== "string" || !KEY.test(f["key"])) return `has a customizable key that is not UPPER_SNAKE_CASE: ${JSON.stringify(f["key"])}`;
      if (typeof f["label"] !== "string") return `has customizable key ${f["key"]} with no label`;
      if (f["type"] !== undefined && f["type"] !== "text") return `has customizable key ${f["key"]} of a type other than text`;
      if ((f["default"] !== undefined && typeof f["default"] !== "string") || (f["placeholder"] !== undefined && typeof f["placeholder"] !== "string")) {
        return `has customizable key ${f["key"]} whose default or placeholder is not a string`;
      }
    }
  }
  return null;
}

/**
 * Check a parsed catalogue against `catalogue.schema.json`. A catalogue that is
 * not one at all is refused; a single unusable entry is dropped with a warning,
 * so one bad listing never hides every other app.
 */
export function validateCatalogue(raw: unknown): { catalogue: Catalogue; warnings: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as { apps?: unknown }).apps)) {
    throw new PackageRefusedError("catalogue.json is not a catalogue (it needs an `apps` list)");
  }
  const source = raw as { version?: unknown; apps: unknown[] };
  const warnings: string[] = [];
  const apps: CatalogueEntry[] = [];
  const ids = new Set<string>();
  source.apps.forEach((value, i) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      warnings.push(`catalogue entry ${i} is not an object — skipped`);
      return;
    }
    const entry = value as Record<string, unknown>;
    const problem = entryProblem(entry);
    if (problem !== null) {
      warnings.push(`catalogue entry ${i}${typeof entry["id"] === "string" ? ` ("${entry["id"]}")` : ""} ${problem} — skipped`);
      return;
    }
    const id = entry["id"] as string;
    if (ids.has(id)) {
      warnings.push(`catalogue entry ${i} repeats the id "${id}" — skipped`);
      return;
    }
    ids.add(id);
    apps.push({ ...(entry as CatalogueEntry), folder: (entry["folder"] as string).replace(/\/+$/, "") });
  });
  return { catalogue: { ...(typeof source.version === "string" ? { version: source.version } : {}), apps }, warnings };
}

export interface LoadedCatalogue {
  marketplace: Marketplace;
  location: string;
  catalogue: Catalogue;
  /** the default marketplace that was unavailable, when the fallback answered instead */
  fallbackFrom: { location: string; reason: string } | null;
  warnings: string[];
}

async function readCatalogue(m: Marketplace): Promise<{ catalogue: Catalogue; warnings: string[] }> {
  let raw: unknown;
  if (m.kind === "local") {
    raw = readJsonFile(join(m.dir, "catalogue.json"));
  } else {
    const bytes = await downloadBytes(rawUrl(m, "catalogue.json"), CATALOGUE_LIMITS);
    const text = bytes.toString("utf8");
    try {
      // Strict JSON: a catalogue is machine-written and read by every harness alike.
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (err) {
      throw new PackageRefusedError(`catalogue.json at ${marketplaceLocation(m)} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return validateCatalogue(raw);
}

/** Fetch and validate the catalogue, falling back from the default marketplace when it is unavailable (§2). */
export async function loadCatalogue(explicit?: string): Promise<LoadedCatalogue> {
  const { list, configured } = candidates(explicit);
  let fallbackFrom: LoadedCatalogue["fallbackFrom"] = null;
  for (let i = 0; i < list.length; i++) {
    const marketplace = list[i]!;
    try {
      const { catalogue, warnings } = await readCatalogue(marketplace);
      return { marketplace, location: marketplaceLocation(marketplace), catalogue, fallbackFrom, warnings };
    } catch (err) {
      const last = configured || i === list.length - 1;
      if (last) throw err;
      // Reported to the caller (`fallbackFrom`), which says it once in its own output.
      fallbackFrom = { location: marketplaceLocation(marketplace), reason: (err as Error).message };
    }
  }
  throw new Error("no marketplace to read");
}

/** An entry's preview image: as listed, else `<folder>/thumbnail.png` on the same ref (§2). */
export function previewOf(entry: CatalogueEntry, m: Marketplace): string | undefined {
  if (entry.preview !== undefined) return entry.preview;
  if (m.kind === "github") return rawUrl(m, `${entry.folder}/thumbnail.png`);
  const file = join(m.dir, ...entry.folder.split("/"), "thumbnail.png");
  return existsSync(file) && statSync(file).isFile() ? pathToFileURL(file).href : undefined;
}

/* --------------------------------------------------------- compatibility */

/** Whether a version is on this CLI's compatibility line: the same major, and for 0.x the same minor. */
function sameLine(version: string, current: string): boolean {
  const a = /^(\d+)\.(\d+)/.exec(version);
  const b = /^(\d+)\.(\d+)/.exec(current);
  if (a === null || b === null) return false;
  return a[1] === b[1] && (a[1] !== "0" || a[2] === b[2]);
}

/**
 * Whether this machine can run an entry, judged only by what the entry itself
 * lists — nothing is downloaded. `compatible` is null when the entry lists no
 * requirement: unknown is reported as unknown, never guessed either way.
 */
export function compatibility(entry: CatalogueEntry): { compatible: boolean | null; reason?: string } {
  if (entry.livingUIVersion !== undefined || typeof entry.agentAppVersion === "number") {
    const version = entry.livingUIVersion ?? entry.agentAppVersion;
    return {
      compatible: false,
      reason: `a CraftBot Living UI app (version ${version}): not installable as it is — the importer skill converts it`,
    };
  }
  const unmet: string[] = [];
  let listed = 0;
  if (typeof entry.agentAppVersion === "string") {
    listed += 1;
    if (!sameLine(entry.agentAppVersion, AGENT_APP_VERSION)) {
      unmet.push(`written for framework ${entry.agentAppVersion}; this CLI is ${AGENT_APP_VERSION}`);
    }
  }
  if (entry.toolkit !== undefined) {
    listed += 1;
    if (installedToolkit(entry.toolkit) === null) unmet.push(`needs toolkit "${entry.toolkit}", which is not installed here`);
  }
  if (listed === 0) return { compatible: null };
  return unmet.length > 0 ? { compatible: false, reason: unmet.join("; ") } : { compatible: true };
}

/** Whether every word occurs, case-insensitively, in the entry's id, name, description or tags. */
export function matchesSearch(entry: CatalogueEntry, words: string[]): boolean {
  const text = [entry.id, entry.name, entry.description ?? "", ...(entry.tags ?? [])].join("\n").toLowerCase();
  return words.every((w) => text.includes(w.toLowerCase()));
}
