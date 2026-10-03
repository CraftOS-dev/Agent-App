/**
 * The agent-state gate: work an app queues for an agent has to be visible in
 * the View until it is done.
 *
 * An agent run takes seconds to minutes. A button that queues one and then goes
 * quiet leaves the person looking at a screen with no sign anything is
 * happening, and that is the failure this step exists to catch. The creator
 * skill has always said so, but advice is followed unreliably and nothing used
 * to notice when it was not.
 *
 * The check is static and stack-agnostic, so it runs on every app whatever its
 * blueprint:
 *
 *   1. Find each `trigger(...)` call in app-owned code that names a capability,
 *      which is what puts a task on the queue. A trigger without one only
 *      announces an event, and no agent is ever handed it.
 *   2. If any exists and the app has a human View, some View code must follow
 *      the task: it reads `/api/_a2app/tasks/...`, or it renders the
 *      blueprint's agent-task component. The component file itself does not
 *      count (it carries an `@a2app-kit agent-task` marker), because shipping a
 *      component nobody renders shows nothing.
 *
 * Comments are stripped before either search, so a note saying "TODO: poll
 * /api/_a2app/tasks" proves nothing. System-owned files are skipped: they are
 * the framework's code, not the app's, and the adapter's own `trigger`
 * implementation is not a feature that queues work.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { canonPaths } from "./canon.js";

/** One place app code puts work on the agent queue. */
export interface QueuingTrigger {
  /** project-relative, forward slashes */
  file: string;
  line: number;
  /** the capability argument as written, e.g. `"triage"` */
  capability: string;
}

export interface AgentStateReport {
  triggers: QueuingTrigger[];
  /** project-relative View files (markup or component sources) */
  viewFiles: string[];
  /** project-relative files whose code follows a queued task */
  followers: string[];
}

/** The marker a kit component carries, so its own task polling is not counted as use. */
export const KIT_MARKER = "@a2app-kit agent-task";

/** Where the skill states the rule. Named in every failure so the fix is one read away. */
export const RULE_POINTER =
  'creator skill, "The UI that queues work must show that work until it is done"';

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".a2app", ".lui", "dist", "build", "out", "target", "public",
  "data", "pb_data", "vendor", "tmp", "log", "logs", "coverage", "__pycache__", ".venv",
  "venv", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache",
  "test", "tests", "__tests__", "spec",
]);

const MAX_FILE_BYTES = 512 * 1024;

type Lang = "c" | "hash" | "markup";

const LANG_BY_EXT: Record<string, Lang> = {
  ".js": "c", ".mjs": "c", ".cjs": "c", ".jsx": "c", ".ts": "c", ".mts": "c", ".cts": "c", ".tsx": "c",
  ".go": "c", ".rs": "c", ".java": "c", ".kt": "c", ".cs": "c", ".swift": "c", ".dart": "c", ".php": "c",
  ".py": "hash", ".rb": "hash", ".ex": "hash", ".exs": "hash",
  ".vue": "markup", ".svelte": "markup", ".html": "markup", ".htm": "markup", ".erb": "markup",
};

/** Files that ARE a View — markup, or a component a bundler compiles into one. */
const VIEW_EXTS = new Set([".jsx", ".tsx", ".vue", ".svelte", ".html", ".htm", ".erb"]);

const FOLLOW_RE = /_a2app\/tasks|\buseAgentTask\b|\bAgentTask\w*|<agent-task\b/;

/** Is a test file by name, whatever directory it sits in. */
const TEST_FILE_RE = /(\.|_)(test|spec)\.[a-z]+$|_test\.go$/i;

/**
 * Scan a project for queued agent work and for View code that follows it.
 *
 * `extraSkip` names project-relative files to leave out on top of the
 * ownership canon (the gate passes none; tests use it).
 */
export function scanAgentState(projectDir: string, extraSkip: string[] = []): AgentStateReport {
  const skip = new Set([...canonPaths(projectDir), ...extraSkip].map((p) => p.replace(/\\/g, "/")));
  const report: AgentStateReport = { triggers: [], viewFiles: [], followers: [] };

  for (const abs of walk(projectDir)) {
    const rel = relative(projectDir, abs).split(sep).join("/");
    if (skip.has(rel) || TEST_FILE_RE.test(rel)) continue;
    const ext = extname(rel).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;

    let raw: string;
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    if (VIEW_EXTS.has(ext)) report.viewFiles.push(rel);

    const { noComments, codeOnly } = lang === "markup" ? stripMarkup(raw) : strip(raw, lang);
    for (const t of findQueuingTriggers(noComments, codeOnly)) {
      report.triggers.push({ file: rel, ...t });
    }
    if (!raw.includes(KIT_MARKER) && FOLLOW_RE.test(noComments)) report.followers.push(rel);
  }
  return report;
}

/** The gate's verdict: null when the View shows the work (or there is none to show). */
export function agentStateProblem(report: AgentStateReport): string | null {
  if (report.triggers.length === 0 || report.viewFiles.length === 0) return null;
  if (report.followers.length > 0) return null;

  const sites = report.triggers.map((t) => `  ${t.file}:${t.line} queues work for capability ${t.capability}`);
  return [
    "This app queues work for an agent, but no View code shows that work:",
    ...sites,
    "",
    "An agent run takes seconds to minutes. A control that queues one and then goes quiet looks",
    "broken. Keep the task id the trigger returns on the record, and render it in the View with the",
    "blueprint's AgentTask component (see reference/blueprint.md), or follow",
    "GET /api/_a2app/tasks/{id} yourself and show submitted (with elapsed time, and a \"no agent is",
    "listening\" hint after ~20 s), working (progress.step), completed (result.summary in its own",
    "full-width block) and failed (reason, and a way to ask again). On a multi-user app that read",
    "answers 401: have the agent write its progress onto the record and render that through the",
    "same component.",
    `See the ${RULE_POINTER}.`,
  ].join("\n");
}

/* ------------------------------------------------------------------ walking */

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      yield* walk(join(dir, e.name));
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

/* ---------------------------------------------------------------- stripping */

interface Stripped {
  /** source with comments blanked to spaces (newlines kept, so offsets and lines hold) */
  noComments: string;
  /** source with comments AND string contents blanked: only code structure is left */
  codeOnly: string;
}

/**
 * Blank comments (and, for `codeOnly`, string contents) without moving a
 * single character, so an offset found in one view indexes the others.
 *
 * Deliberately a lexer, not a parser: it knows quotes and comment markers and
 * nothing else. Single- and double-quoted strings end at a newline whatever
 * the language says, so a stray apostrophe (JSX text, a Rust lifetime) can
 * mislead it for one line at most.
 */
export function strip(src: string, lang: "c" | "hash"): Stripped {
  const nc = src.split("");
  const co = src.split("");
  const blank = (arr: string[], i: number) => {
    if (arr[i] !== "\n" && arr[i] !== "\r") arr[i] = " ";
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    // comments
    if (lang === "c" && c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") (blank(nc, i), blank(co, i), i++);
      continue;
    }
    if (lang === "c" && c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) (blank(nc, i), blank(co, i));
      continue;
    }
    if (lang === "hash" && c === "#") {
      while (i < n && src[i] !== "\n") (blank(nc, i), blank(co, i), i++);
      continue;
    }

    // strings
    if (lang === "hash" && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      const stop = end === -1 ? n : end + 3;
      for (let j = i + 3; j < stop - 3; j++) blank(co, j);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && lang === "c")) {
      const multiline = c === "`";
      let j = i + 1;
      while (j < n && src[j] !== c && (multiline || src[j] !== "\n")) {
        if (src[j] === "\\") j++;
        j++;
      }
      for (let k = i + 1; k < j && k < n; k++) blank(co, k);
      i = src[j] === c ? j + 1 : j;
      continue;
    }
    i++;
  }
  return { noComments: nc.join(""), codeOnly: co.join("") };
}

/**
 * Markup (HTML, Vue, Svelte, ERB): blank `<!-- -->` comments, then lex each
 * `<script>` body as code. Text outside scripts is left alone — an apostrophe
 * in a sentence is not a string delimiter there.
 */
function stripMarkup(src: string): Stripped {
  let noComments = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, " "));
  let codeOnly = noComments;
  const script = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;
  let m: RegExpExecArray | null;
  while ((m = script.exec(noComments)) !== null) {
    const start = m.index + m[1]!.length;
    const body = m[2]!;
    const s = strip(body, "c");
    noComments = noComments.slice(0, start) + s.noComments + noComments.slice(start + body.length);
    codeOnly = codeOnly.slice(0, start) + s.codeOnly + codeOnly.slice(start + body.length);
  }
  return { noComments, codeOnly };
}

/* ---------------------------------------------------------------- triggers */

const TRIGGER_RE = /\btrigger\s*\(/g;
/** What precedes a DEFINITION of trigger rather than a call to it. */
const DEFINITION_BEFORE = /(?:\b(?:def|fn|func|function)\s+|\bfunc\s*\([^)]*\)\s*)$/;
/** What follows a parameter list rather than an argument list (a body, or a TS return type). */
const DEFINITION_AFTER = /^[ \t]*\{|^[ \t]*:[ \t]*[\w<[{(]/;
/** A capability argument that names no capability. */
const EMPTY_CAPABILITY = /^(?:""|''|``|null|undefined|None|nil|Option::None|false)$/;

/**
 * Find calls that put a task on the queue: `trigger(type, payload, capability)`
 * with a capability that is not empty, in any of the blueprint spellings —
 * positional (JS, Go, Ruby), keyword (`capability=` in Python), `Some(...)` in
 * Rust, or the adapter's own object form `trigger({ type, capability })`.
 */
export function findQueuingTriggers(noComments: string, codeOnly: string): Array<{ line: number; capability: string }> {
  const found: Array<{ line: number; capability: string }> = [];
  TRIGGER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRIGGER_RE.exec(codeOnly)) !== null) {
    const lineStart = codeOnly.lastIndexOf("\n", m.index) + 1;
    if (DEFINITION_BEFORE.test(codeOnly.slice(lineStart, m.index))) continue;

    const open = m.index + m[0].length - 1;
    const args = splitArgs(noComments, codeOnly, open);
    if (args === null) continue;
    // A method body follows its parameter list: `trigger(input) {` or `trigger(x: T): R {`.
    if (DEFINITION_AFTER.test(codeOnly.slice(args.close + 1, args.close + 80))) continue;

    const capability = capabilityOf(args.list);
    if (capability === null) continue;
    const line = noComments.slice(0, m.index).split("\n").length;
    found.push({ line, capability });
  }
  return found;
}

function capabilityOf(list: string[]): string | null {
  const args = list.map((a) => a.trim()).filter((a) => a.length > 0);

  // Python: capability passed by keyword.
  const kw = args.find((a) => /^capability\s*=/.test(a));
  if (kw) return normalizeCapability(kw.replace(/^capability\s*=\s*/, ""));

  // The adapter's object form: trigger({ type, payload, capability }).
  if (args.length === 1 && args[0]!.startsWith("{")) {
    const obj = args[0]!;
    const named = obj.match(/\bcapability\s*:\s*([^,}\n]+)/);
    if (named) return normalizeCapability(named[1]!);
    // Shorthand `{ type, capability }` passes a variable of that name.
    if (/[{,]\s*capability\s*[,}]/.test(obj)) return "capability";
    return null;
  }

  if (args.length < 3) return null;
  return normalizeCapability(args[2]!);
}

function normalizeCapability(text: string): string | null {
  let cap = text.trim();
  const some = cap.match(/^Some\s*\(([\s\S]*)\)$/);
  if (some) cap = some[1]!.trim();
  if (EMPTY_CAPABILITY.test(cap)) return null;
  return cap.replace(/\s+/g, " ").slice(0, 80);
}

/**
 * Split the argument list of the call whose `(` is at `open`. Structure is read
 * from `codeOnly` (string contents blanked, so a comma or paren inside a string
 * is not one); the text of each argument comes from `noComments`.
 */
function splitArgs(noComments: string, codeOnly: string, open: number): { list: string[]; close: number } | null {
  const list: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < codeOnly.length; i++) {
    const c = codeOnly[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        list.push(noComments.slice(start, i));
        return { list, close: i };
      }
    } else if (c === "," && depth === 1) {
      list.push(noComments.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}
