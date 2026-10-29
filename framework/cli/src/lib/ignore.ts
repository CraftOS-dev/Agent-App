/**
 * Ignore rules, read from a `.gitignore`.
 *
 * A package never carries build output the pipeline recreates (framework
 * packaging §1), and the one place a stack already declares its build output is
 * the ignore file its template ships: `dist/`, `target/`, `pb/pb_public/`,
 * `.venv/`, `bin/`. Reading that file is what lets sanitize and export leave
 * those out without the CLI keeping its own list of every stack's output
 * folders.
 *
 * The subset of gitignore(5) implemented is what such a file uses: comments,
 * blank lines, `!` negation, a trailing `/` (folders only), a leading or inner
 * `/` (anchored to the root), `*`, `?`, `**` and `[…]` classes, and `\` escapes.
 * One file is read, at the tree's root; nested `.gitignore` files are not.
 * As in git, a folder that is ignored is not descended into, so nothing inside
 * it can be re-included by a later negation — callers walk top-down and stop at
 * an ignored folder.
 */
import { existsSync, readFileSync } from "node:fs";

export interface IgnoreRule {
  regex: RegExp;
  negate: boolean;
  directoryOnly: boolean;
}

function escapeRegex(c: string): string {
  return /[.*+?^${}()|[\]\\/-]/.test(c) ? `\\${c}` : c;
}

/** A glob (no trailing slash) as a regex over a root-relative, `/`-separated path. */
function compile(glob: string): RegExp {
  // A slash anywhere but the end anchors the pattern to the root; without one
  // it matches the name at any depth.
  const anchored = glob.includes("/");
  const body = glob.startsWith("/") ? glob.slice(1) : glob;
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "*") {
      if (body[i + 1] === "*" && (i === 0 || body[i - 1] === "/") && (i + 2 === body.length || body[i + 2] === "/")) {
        if (i + 2 === body.length) {
          re += ".*"; // `dir/**`: everything inside
          i += 1;
        } else {
          re += "(?:.*/)?"; // `**/`: any number of folders, including none
          i += 2;
        }
        continue;
      }
      while (body[i + 1] === "*") i++;
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = body.indexOf("]", i + 2);
      if (close < 0) {
        re += "\\[";
        continue;
      }
      let cls = body.slice(i + 1, close).replace(/\\/g, "\\\\");
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
      re += `[${cls}]`;
      i = close;
    } else if (c === "\\" && i + 1 < body.length) {
      i += 1;
      re += escapeRegex(body[i]!);
    } else {
      re += escapeRegex(c);
    }
  }
  return new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`);
}

/** Parse the text of an ignore file. */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Trailing spaces are not part of a pattern unless escaped.
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    let directoryOnly = false;
    if (line.endsWith("/")) {
      directoryOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (line === "") continue;
    rules.push({ regex: compile(line), negate, directoryOnly });
  }
  return rules;
}

/** The rules in an ignore file, or none when it does not exist. */
export function readIgnoreFile(file: string): IgnoreRule[] {
  return existsSync(file) ? parseIgnore(readFileSync(file, "utf8")) : [];
}

/** Whether `path` (root-relative, `/`-separated) is ignored; the last matching rule decides. */
export function isIgnored(rules: IgnoreRule[], path: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.regex.test(path)) ignored = !rule.negate;
  }
  return ignored;
}
