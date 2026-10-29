/**
 * Where a package comes from (framework packaging §3), and getting it into a
 * fresh staging directory without running anything from it (§4, acquire).
 *
 * Every source lands the same way: a tree under `$A2APP_HOME/staging/<id>/`
 * that holds no links, nothing §1 says a package never carries that could be
 * left behind on the way in (`.git/`, `node_modules/`, credentials, runtime
 * state, what the package's own ignore rules exclude), and at most
 * {@link PACKAGE_LIMIT} bytes. What is left behind is reported, so inspect can
 * show it.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { downloadToFile } from "./download.js";
import { homePath } from "./home.js";
import {
  archiveUrl,
  loadCatalogue,
  marketplaceLocation,
  parseGithubShorthand,
  validRef,
  type CatalogueEntry,
  type GithubRepo,
  type Marketplace,
} from "./marketplace.js";
import { exclusionRules, NEVER_CARRIED_DIRS, walkPackage } from "./package.js";
import { formatBytes, PackageRefusedError, SourceNotFoundError, SourceUnreachableError } from "./packageErrors.js";
import { EnvError, UsageError } from "./project.js";
import { extractZip, readZipIndex, type ZipEntry } from "./zip.js";

const MiB = 1024 * 1024;
/** The most a package may be: as an archive, and as the app unpacked (§2). */
export const PACKAGE_LIMIT = 512 * MiB;
const ARCHIVE_LIMITS = { maxBytes: PACKAGE_LIMIT, timeoutMs: 10 * 60_000 };
const GIT_TIMEOUT_MS = 10 * 60_000;

/** Provenance, as recorded in an installed app's manifest (§4, register) — less `installedAt`. */
export interface Provenance {
  kind: "marketplace" | "zip" | "folder" | "github" | "git";
  location: string;
  ref?: string;
  catalogueId?: string;
  version?: string;
  sha256?: string;
  commit?: string;
}

/** A `--from` source, parsed. */
export type FromSource =
  | { kind: "zip"; file: string }
  | { kind: "folder"; dir: string }
  | ({ kind: "github"; path: string[] } & GithubRepo)
  | { kind: "git"; url: string; ref: string | null };

/** What to acquire: a catalogue app, a `--from` source, or a folder installed in place. */
export type Request =
  | { kind: "catalogue"; id: string; marketplace?: string }
  | { kind: "from"; source: FromSource }
  | { kind: "in-place"; dir: string };

export interface Acquired {
  /** the package's root, inside the staging directory */
  root: string;
  provenance: Provenance;
  /** the catalogue entry, for a marketplace app */
  entry: CatalogueEntry | null;
  marketplace: Marketplace | null;
  /** what was left behind on the way in, root-relative; folders end in `/` */
  skipped: string[];
  warnings: string[];
}

/**
 * Parse a `--from` value (§3). Decided by how it is written — `git+…`,
 * `github:…`, an https URL on github.com — and otherwise by what is on disk at
 * that path: a folder is a folder, any file is read as a zip.
 */
export function parseFrom(spec: string): FromSource {
  if (spec.startsWith("git+")) {
    const rest = spec.slice(4);
    const hash = rest.lastIndexOf("#");
    const url = hash < 0 ? rest : rest.slice(0, hash);
    const ref = hash < 0 ? null : rest.slice(hash + 1);
    // A URL starting with `-` would be read by git as an option.
    if (url === "" || url.startsWith("-") || /[\s\0]/.test(url)) throw new UsageError(`Not a git URL: ${spec}`);
    if (ref !== null && !validRef(ref)) throw new UsageError(`Not a usable git ref: ${ref}`);
    return { kind: "git", url, ref };
  }
  if (spec.startsWith("github:")) {
    const { owner, repo, ref, path } = parseGithubShorthand(spec, true);
    return { kind: "github", owner, repo, ref, path };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(spec)) return parseGithubUrl(spec);
  const path = resolve(spec);
  if (!existsSync(path)) throw new UsageError(`No such file or folder: ${path}`);
  return statSync(path).isDirectory() ? { kind: "folder", dir: path } : { kind: "zip", file: path };
}

/** `https://github.com/<owner>/<repo>[/tree/<ref>[/<path>]]` — the only URL form read directly; other hosts go through `git+`. */
function parseGithubUrl(spec: string): FromSource {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    throw new UsageError(`Not a usable URL: ${spec}`);
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) {
    throw new UsageError(`An https source is read only from github.com — for any other git host, write git+${spec}`);
  }
  const parts = url.pathname.split("/").filter((p) => p !== "").map(decodeURIComponent);
  const [owner, repo, tree, ref, ...path] = parts;
  if (owner === undefined || repo === undefined || (tree !== undefined && (tree !== "tree" || ref === undefined))) {
    throw new UsageError(`Not a GitHub repository URL: ${spec} — write https://github.com/<owner>/<repo>[/tree/<ref>/<path>]`);
  }
  const shorthand = `github:${owner}/${repo.replace(/\.git$/, "")}${ref !== undefined ? `@${ref}` : ""}${path.length > 0 ? `/${path.join("/")}` : ""}`;
  const parsed = parseGithubShorthand(shorthand, true);
  return { kind: "github", owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, path: parsed.path };
}

/* --------------------------------------------------------------- staging */

/** A fresh, empty staging directory under `$A2APP_HOME/staging/`. Short names: Windows paths are counted. */
export function createStaging(): string {
  const parent = homePath("staging");
  mkdirSync(parent, { recursive: true });
  for (;;) {
    const dir = join(parent, randomBytes(4).toString("hex"));
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

export function removeStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/* ------------------------------------------------------------- acquiring */

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Copy a folder's package tree into `dest`: what a package never carries is
 * left behind (including what the folder's own ignore rules exclude), a link is
 * refused rather than followed or copied, and the size is capped as it is
 * counted.
 */
function copyPackageTree(src: string, dest: string): string[] {
  const skipped: string[] = [];
  let bytes = 0;
  mkdirSync(dest, { recursive: true });
  walkPackage(
    src,
    exclusionRules(src, null),
    (rel, abs, kind) => {
      const target = join(dest, ...rel.split("/"));
      if (kind === "directory") {
        mkdirSync(target, { recursive: true });
      } else if (kind === "file") {
        bytes += statSync(abs).size;
        if (bytes > PACKAGE_LIMIT) throw new PackageRefusedError(`the app is over the ${formatBytes(PACKAGE_LIMIT)} a package may hold`);
        copyFileSync(abs, target);
      } else {
        throw new PackageRefusedError(`${rel} is ${kind === "link" ? "a link" : "not a regular file"} — a package holds only files and folders`);
      }
    },
    (rel, isDirectory) => skipped.push(isDirectory ? `${rel}/` : rel),
  );
  return skipped;
}

/** In an archive, folders that are never extracted: their contents are never part of a package, and are full of links. */
function skipNeverCarried(rel: string[]): string | null {
  const at = rel.findIndex((segment) => NEVER_CARRIED_DIRS.has(segment));
  if (at < 0) return null;
  return `${rel.slice(0, at + 1).join("/")}${at < rel.length - 1 ? "/" : ""}`;
}

function startsWith(segments: string[], prefix: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((s, i) => segments[i] === s);
}

/**
 * Where a zip keeps its package (§1): at its root, or inside one top-level
 * folder. Decided by structure: the root when `manifest.json` is there; else
 * the one top-level folder holding a `manifest.json` (so the `__MACOSX/` a
 * Finder-made zip adds beside it does not matter); else the only top-level
 * folder, when everything is inside one.
 */
function zipPackageRoot(index: ZipEntry[]): string[] {
  const manifestAt = (prefix: string[]): boolean =>
    index.some((e) => !e.directory && e.segments.length === prefix.length + 1 && e.segments[prefix.length] === "manifest.json" && startsWith(e.segments, prefix));
  if (manifestAt([])) return [];
  const tops = [...new Set(index.filter((e) => e.segments.length > 0).map((e) => e.segments[0]!))];
  const holding = tops.filter((t) => manifestAt([t]));
  if (holding.length === 1) return [holding[0]!];
  const filesAtRoot = index.some((e) => !e.directory && e.segments.length === 1);
  return tops.length === 1 && !filesAtRoot ? [tops[0]!] : [];
}

/** The one folder every entry of a GitHub branch archive sits in (`<repo>-<ref>/`). */
function archiveRoot(index: ZipEntry[], what: string): string {
  const tops = new Set(index.filter((e) => e.segments.length > 0).map((e) => e.segments[0]!));
  if (tops.size !== 1) throw new PackageRefusedError(`${what} is not a GitHub branch archive (it has ${tops.size} top-level folders)`);
  return [...tops][0]!;
}

/** Download a branch archive and take `<root>/<path…>/` out of it (§2): only that folder, matched by whole segments. */
async function fromBranchArchive(repo: GithubRepo, path: string[], staging: string, dest: string): Promise<{ sha256: string; skipped: string[] }> {
  const url = archiveUrl(repo);
  const archive = join(staging, "archive.zip");
  const { sha256 } = await downloadToFile(url, archive, ARCHIVE_LIMITS);
  const index = readZipIndex(archive);
  const root = archiveRoot(index, url);
  const { files, skipped } = await extractZip(archive, index, dest, { under: [root, ...path], maxBytes: PACKAGE_LIMIT, skip: skipNeverCarried });
  rmSync(archive, { force: true });
  if (files === 0) {
    throw new SourceNotFoundError(`${path.length > 0 ? `${path.join("/")}/` : "the repository"} holds no files in ${url}`);
  }
  return { sha256, skipped };
}

/**
 * A shallow clone that cannot prompt and runs nothing: no terminal or GUI
 * credential prompt (a private repository fails instead of waiting for a
 * person), no hooks (no template is copied, and `core.hooksPath` points at a
 * folder that does not exist), no submodules. The URL follows `--`, so it can
 * never be read as an option.
 */
function gitClone(url: string, ref: string | null, staging: string, dest: string): string {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes",
  };
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, windowsHide: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; signal?: string };
      if (e.code === "ENOENT") throw new EnvError("git is not on PATH: install git to use a git+ source, or use another source");
      if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") throw new SourceUnreachableError(`git did not finish within ${GIT_TIMEOUT_MS / 60_000} minutes`);
      throw new SourceNotFoundError(`git ${args.includes("clone") ? `clone ${url}` : args.join(" ")} failed: ${String(e.stderr ?? e.message).trim()}`);
    }
  };
  run([
    "-c", `core.hooksPath=${join(staging, "no-hooks")}`,
    "-c", "core.askPass=",
    "clone", "--depth", "1", "--no-recurse-submodules", "--template=",
    ...(ref !== null ? ["--branch", ref] : []),
    "--", url, dest,
  ]);
  return run(["-C", dest, "rev-parse", "HEAD"]).trim();
}

/**
 * Put the requested package in `staging` (§4, step 1). Nothing from the source
 * runs. Throws {@link SourceNotFoundError}, {@link SourceUnreachableError} or
 * {@link PackageRefusedError} by what went wrong.
 */
export async function acquire(request: Request, staging: string): Promise<Acquired> {
  const dest = join(staging, "package");
  const warnings: string[] = [];

  if (request.kind === "catalogue") {
    const loaded = await loadCatalogue(request.marketplace);
    warnings.push(...loaded.warnings);
    if (loaded.fallbackFrom !== null) warnings.push(`${loaded.fallbackFrom.location} is unavailable (${loaded.fallbackFrom.reason}); used ${loaded.location}`);
    const entry = loaded.catalogue.apps.find((a) => a.id === request.id);
    if (entry === undefined) {
      throw new SourceNotFoundError(`${loaded.location} lists no app "${request.id}" — see \`agent-app catalogue --search <words>\` for the ids it has`);
    }
    const m = loaded.marketplace;
    const provenance: Provenance = {
      kind: "marketplace",
      location: m.kind === "github" ? `github:${m.owner}/${m.repo}` : m.dir,
      ...(m.kind === "github" ? { ref: m.ref } : {}),
      catalogueId: entry.id,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
    };
    const folder = entry.folder.split("/");
    if (m.kind === "github") {
      const { sha256, skipped } = await fromBranchArchive(m, folder, staging, dest);
      return { root: dest, provenance: { ...provenance, sha256 }, entry, marketplace: m, skipped, warnings };
    }
    const src = join(m.dir, ...folder);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new SourceNotFoundError(`${marketplaceLocation(m)} lists "${entry.id}" in ${entry.folder}/, which is not there`);
    }
    return { root: dest, provenance, entry, marketplace: m, skipped: copyPackageTree(src, dest), warnings };
  }

  if (request.kind === "in-place") {
    return {
      root: dest,
      provenance: { kind: "folder", location: request.dir },
      entry: null,
      marketplace: null,
      skipped: copyPackageTree(request.dir, dest),
      warnings,
    };
  }

  const source = request.source;
  switch (source.kind) {
    case "folder":
      return { root: dest, provenance: { kind: "folder", location: source.dir }, entry: null, marketplace: null, skipped: copyPackageTree(source.dir, dest), warnings };
    case "zip": {
      const size = statSync(source.file).size;
      if (size > PACKAGE_LIMIT) throw new PackageRefusedError(`${source.file} is ${formatBytes(size)}, over the ${formatBytes(PACKAGE_LIMIT)} limit`);
      const sha256 = await hashFile(source.file);
      const index = readZipIndex(source.file);
      const { skipped } = await extractZip(source.file, index, dest, {
        under: zipPackageRoot(index),
        maxBytes: PACKAGE_LIMIT,
        skip: skipNeverCarried,
      });
      return { root: dest, provenance: { kind: "zip", location: source.file, sha256 }, entry: null, marketplace: null, skipped, warnings };
    }
    case "github": {
      const { sha256, skipped } = await fromBranchArchive(source, source.path, staging, dest);
      const location = `github:${source.owner}/${source.repo}${source.path.length > 0 ? `/${source.path.join("/")}` : ""}`;
      return { root: dest, provenance: { kind: "github", location, ref: source.ref, sha256 }, entry: null, marketplace: null, skipped, warnings };
    }
    case "git": {
      const clone = join(staging, "clone");
      const commit = gitClone(source.url, source.ref, staging, clone);
      const skipped = copyPackageTree(clone, dest);
      rmSync(clone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return {
        root: dest,
        provenance: { kind: "git", location: source.url, ...(source.ref !== null ? { ref: source.ref } : {}), commit },
        entry: null,
        marketplace: null,
        skipped,
        warnings,
      };
    }
  }
}
