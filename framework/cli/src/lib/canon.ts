/**
 * The ownership canon.
 *
 * A machine-checkable record of the system-owned/agent-accessible boundary:
 * `.a2app/system-hashes.json` maps each system-owned path (repo-relative,
 * forward slashes) to its SHA-256 content hash, prefixed `sha256:`. Only
 * framework tooling writes it (at scaffold and at every toolkit/adapter sync);
 * the validation gate re-hashes every entry and fails on any drift.
 *
 * The canon is never empty for a conforming app: the minimum is the adapter
 * files plus `manifest.json`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { assertInside } from "./fsx.js";
import { projectToolkit } from "./toolkit.js";

export const CANON_DIR = ".a2app";
export const CANON_FILE = join(CANON_DIR, "system-hashes.json");
/** Legacy location read during the transition window. */
const LEGACY_CANON_FILE = join(".lui", "system-hashes.json");

function sha256(file: string): string {
  return "sha256:" + createHash("sha256").update(readFileSync(file)).digest("hex");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function canonPath(projectDir: string): string | null {
  if (existsSync(join(projectDir, CANON_FILE))) return join(projectDir, CANON_FILE);
  if (existsSync(join(projectDir, LEGACY_CANON_FILE))) return join(projectDir, LEGACY_CANON_FILE);
  return null;
}

/**
 * Hash every system path (files hashed directly; directories walked). Missing
 * paths are skipped — a canon lists what exists at write time.
 */
export function computeSystemHashes(projectDir: string, systemPaths: string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  // Contain every declared path: a toolkit (and any imported app's canon) is
  // untrusted input, so a `../../` or absolute entry must never make the canon
  // read or record a file outside the project. assertInside throws on escape.
  const stack = systemPaths
    .map((p) => assertInside(projectDir, p, "system path"))
    .filter((p) => existsSync(p));
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue; // cycle guard (symlink loops)
    seen.add(current);
    // lstat, not stat: never follow a symlink. A system-owned file is a real
    // file; a symlink in a system path is skipped rather than followed out of
    // the tree (or into a cycle).
    const st = lstatSync(current);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } else {
      hashes[toPosix(relative(projectDir, current))] = sha256(current);
    }
  }
  return hashes;
}

/** Record the current state of `systemPaths` as canonical. Called by scaffold,
 *  toolkit-sync, and adapter-sync — never for agent-editable paths. */
export function writeSystemHashes(projectDir: string, systemPaths: string[]): void {
  mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
  const hashes = computeSystemHashes(projectDir, systemPaths);
  writeFileSync(join(projectDir, CANON_FILE), JSON.stringify(hashes, null, 2) + "\n");
}

/** Re-record ONE file the tooling itself just wrote. Never call for
 *  agent-editable paths. */
export function recordFileHash(projectDir: string, relPath: string): void {
  const file = canonPath(projectDir);
  if (file === null) return;
  const recorded = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  recorded[toPosix(relPath)] = sha256(join(projectDir, relPath));
  writeFileSync(file, JSON.stringify(recorded, null, 2) + "\n");
}

/** true = clean, false = drifted, null = no canon entry for this path. */
export function fileMatchesCanon(projectDir: string, relPath: string): boolean | null {
  const file = canonPath(projectDir);
  if (file === null) return null;
  const recorded = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const want = recorded[toPosix(relPath)];
  if (want === undefined) return null;
  const abs = join(projectDir, relPath);
  if (!existsSync(abs)) return false;
  return sha256(abs) === want;
}

export interface OwnershipDrift {
  modified: string[];
  missing: string[];
  added: string[];
}

/**
 * Compare the recorded canon to the current state: `modified` and `missing`
 * come from recorded entries, `added` is a system-owned file present now that
 * the canon does not record.
 *
 * The comparison walks the toolkit's DECLARED system paths, not the canon's own
 * keys. Re-walking the recorded keys can only ever rediscover the files already
 * listed, so an added file would be invisible — but a declared path may be a
 * directory, and a new file dropped inside it is a system-owned file nobody
 * canonized. Section 4.2 requires the gate to fail on exactly that.
 *
 * With no toolkit there are no declared directory roots, so the recorded file
 * list IS the complete declaration of what is system-owned, and any other file
 * in the project is agent-accessible by definition.
 */
export function verifySystemHashes(projectDir: string): OwnershipDrift {
  const file = canonPath(projectDir);
  if (file === null) {
    throw new Error(
      `missing ${CANON_FILE} — run \`agent-app <dir> toolkit-sync\` to (re)establish the ownership canon`,
    );
  }
  const recorded = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const declared = projectToolkit(projectDir)?.manifest.systemPaths ?? Object.keys(recorded);
  const current = computeSystemHashes(projectDir, declared);

  const drift: OwnershipDrift = { modified: [], missing: [], added: [] };
  for (const [path, hash] of Object.entries(recorded)) {
    const now = current[path];
    if (now === undefined) drift.missing.push(path);
    else if (now !== hash) drift.modified.push(path);
  }
  for (const path of Object.keys(current)) {
    if (recorded[path] === undefined) drift.added.push(path);
  }
  return drift;
}

/** The recorded system paths (top-level keys of the canon), or [] if none. */
export function canonPaths(projectDir: string): string[] {
  const file = canonPath(projectDir);
  if (file === null) return [];
  return Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>);
}
