/**
 * App-part validation.
 *
 * These are the declarations that make an app *this* app — the A2App adapter's
 * app part (framework spec 4.1). The gate checks they are present, well-shaped,
 * and internally consistent; a third party emits a compatible app part from the
 * pinned shape, so this validates against that shape, not a reference impl.
 *
 * Consistency is checked here rather than left to runtime because every rule
 * this framework has stated without a gate behind it has drifted in practice.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleNameProblem, validatePredicate, PROTOCOL_TYPES } from "@a2app/rules";
import { readJsonFile } from "./json.js";

export interface FrameworkFileProblem {
  file: string;
  message: string;
}

const OP_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
// Imported, never re-listed: a hand-copied vocabulary drifts the moment the
// protocol adds a type, and this file already depends on @a2app/rules.
const PROTOCOL_TYPE_NAMES = new Set<string>(PROTOCOL_TYPES);

/** The modules a manifest declares, or an empty list when it has none/is unreadable.
 *  Shape problems are reported by {@link validateManifest}; this only reads. */
export function declaredModules(projectDir: string): string[] {
  try {
    const m = readJsonFile(join(projectDir, "manifest.json")) as {
      modules?: { name?: unknown }[];
    };
    return (m.modules ?? []).map((mod) => String(mod?.name ?? "")).filter((n) => n !== "");
  } catch {
    return [];
  }
}

export function validateManifest(projectDir: string): FrameworkFileProblem[] {
  const file = "manifest.json";
  const path = join(projectDir, file);
  if (!existsSync(path)) return [{ file, message: "missing (required framework file)" }];
  let m: Record<string, unknown>;
  try {
    m = readJsonFile(path) as Record<string, unknown>;
  } catch (e) {
    return [{ file, message: (e as Error).message }];
  }
  const problems: FrameworkFileProblem[] = [];
  const req = (k: string): void => {
    if (m[k] === undefined || m[k] === null || m[k] === "") {
      problems.push({ file, message: `missing required key "${k}"` });
    }
  };
  for (const k of ["id", "name", "agentAppVersion", "adapterVersion", "authMode", "modules", "pipeline"]) req(k);
  if (m.authMode !== undefined && m.authMode !== "none" && m.authMode !== "multi-user") {
    problems.push({ file, message: `authMode must be "none" or "multi-user", got ${JSON.stringify(m.authMode)}` });
  }

  // Modules are the organizing unit: the root of describe lists them, and every
  // entity and operation names one. An app with none has no root screen to serve.
  if (m.modules !== undefined) {
    if (!Array.isArray(m.modules)) {
      problems.push({ file, message: "modules must be an array of { name, summary? }" });
    } else if (m.modules.length === 0) {
      problems.push({ file, message: "modules must declare at least one module — the root screen lists them" });
    } else {
      const seen = new Set<string>();
      for (const entry of m.modules as Record<string, unknown>[]) {
        const name = entry?.name;
        if (typeof name !== "string") {
          problems.push({ file, message: `module entry has no name: ${JSON.stringify(entry)}` });
          continue;
        }
        const problem = moduleNameProblem(name);
        if (problem) problems.push({ file, message: problem });
        if (seen.has(name)) problems.push({ file, message: `duplicate module "${name}"` });
        seen.add(name);
      }
    }
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
    parsed = readJsonFile(path) as { operations?: unknown };
  } catch (e) {
    return [{ file, message: (e as Error).message }];
  }
  if (!Array.isArray(parsed.operations)) {
    return [{ file, message: '"operations" must be an array' }];
  }
  const problems: FrameworkFileProblem[] = [];
  const seen = new Set<string>();
  const modules = new Set(declaredModules(projectDir));
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

    // Every operation appears on exactly one screen. One that names no module,
    // or a module the manifest never declared, is unreachable by the walk.
    //
    // The resolve check is NOT skipped when no modules are readable. An empty set
    // means the manifest is missing, unreadable, or declares none — in every one
    // of those cases the operation's module genuinely does not resolve, and
    // treating "nothing to check against" as "nothing wrong" is how an app ships
    // with an unreachable operation surface.
    if (typeof raw.module !== "string" || raw.module === "") {
      problems.push({ file, message: `${name}: "module" is required — which screen this operation appears on` });
    } else if (!modules.has(raw.module)) {
      problems.push({
        file,
        message: `${name}: module "${raw.module}" is not declared in manifest.json (declared: ${[...modules].join(", ") || "none readable"})`,
      });
    }

    // Typed params are what the record screen renders as the signature. Prose
    // inside `description` can be neither rendered nor checked before a call.
    if (raw.params === undefined || raw.params === null || typeof raw.params !== "object" || Array.isArray(raw.params)) {
      problems.push({
        file,
        message: `${name}: "params" is required and must be an object of typed parameters (declare {} if it takes none)`,
      });
    } else {
      for (const [param, spec] of Object.entries(raw.params as Record<string, unknown>)) {
        if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
          problems.push({ file, message: `${name}.params.${param}: must be an object with a "type"` });
          continue;
        }
        const type = (spec as Record<string, unknown>).type;
        if (typeof type !== "string" || !PROTOCOL_TYPE_NAMES.has(type)) {
          problems.push({
            file,
            message: `${name}.params.${param}: "type" must be one of the protocol types, got ${JSON.stringify(type)}`,
          });
        }
      }
    }

    if (raw.appliesWhen !== undefined) {
      if (typeof raw.entity !== "string" || raw.entity === "") {
        problems.push({
          file,
          message: `${name}: "appliesWhen" needs an "entity" — there is no record to evaluate the condition against`,
        });
      }
      for (const message of validatePredicate(raw.appliesWhen, `${name}.appliesWhen`)) {
        problems.push({ file, message });
      }
    }
  }
  return problems;
}

/** Required top-level markdown sections. `Modules` precedes `Entities` because
 *  modules are decided first — an entity cannot be declared until there is a
 *  module to put it in. */
const AGENT_APP_SECTIONS = ["Plan", "Modules", "Entities", "Operations", "Conventions", "Checklist"];

/** The two-part spec: Part A (SRS — what must exist, walk-verify drives it) then
 *  Part B (Technical Specification — how it is built, with the Quality
 *  Conformance decision record). `## Changes` is the only section absent here:
 *  the first modification creates it. */
const REQUIREMENTS_SECTIONS = [
  "Introduction",
  "Approval",
  "Product Description",
  "Features",
  "Non-Functional Requirements",
  "Data Requirements",
  "External Interfaces",
  "Out of Scope",
  "Quality of Life",
  "System Overview",
  "UI Design",
  "Quality Conformance",
  "Conventions and overrides",
  "Process Flows",
  "Operations Design",
];

/** The template's fill markers. A spec still carrying one is not authored:
 *  the gate refuses it by name so a half-filled template can never reach
 *  verification, let alone the user. */
const TEMPLATE_MARKER = /<REPLACE:/;

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

/** The body lines of the first heading (any level, `#`–`###`) whose title
 *  starts with `section`, up to the next heading of the same or a higher
 *  level. Deeper subheadings and their bodies belong to the section —
 *  Features keeps its "### Module: <name>" groups, and a `###` section like
 *  Approval is addressable on its own. */
function sectionBody(src: string, section: string): string[] {
  const lower = section.toLowerCase();
  const out: string[] = [];
  let level = 0;
  for (const line of src.split("\n")) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (level > 0 && h[1]!.length <= level) break;
      if (level === 0 && h[2]!.trim().toLowerCase().startsWith(lower)) level = h[1]!.length;
      continue;
    }
    if (level > 0) out.push(line);
  }
  return out;
}

const LIST_ITEM = /^\s*[-*]\s+(.*\S)/;

export function validateAgentAppDoc(projectDir: string): FrameworkFileProblem[] {
  return checkMarkdownSections(projectDir, "AGENT_APP.md", AGENT_APP_SECTIONS);
}

export function validateRequirementsDoc(projectDir: string): FrameworkFileProblem[] {
  const file = join("reference", "requirements.md");
  const problems = checkMarkdownSections(projectDir, file, REQUIREMENTS_SECTIONS);
  // Content checks are skipped when sections are already missing — a second
  // problem derived from the first buries the real cause.
  if (problems.length > 0) return problems;
  const src = readFileSync(join(projectDir, file), "utf8");

  // An unauthored spec is refused before any content check: markers mean the
  // creator has not written this app's spec yet, and every downstream check
  // would only re-report that one fact in fragments.
  const markers = src.split("\n").filter((l) => TEMPLATE_MARKER.test(l)).length;
  if (markers > 0) {
    return [{
      file,
      message: `${markers} template placeholder(s) <REPLACE: …> remain — the spec is not authored; write Part A, get the user's approval, then Part B (creator skill)`,
    }];
  }

  // Features must carry at least one checkable statement, not just the heading:
  // walk-verify is an agent driving the app against these items one by one, and
  // an empty list would let a build claim "verified" with nothing verified.
  const features = requirementsFeatures(projectDir);
  if (features.length === 0) {
    problems.push({
      file,
      message: 'section "## Features" has no list items — each feature must be a checkable capability statement for walk-verify to drive',
    });
  }

  // Feature IDs (F-<MOD>-n) are how tasks and defect reports cite the spec; a
  // duplicated ID makes every citation ambiguous. IDs are a convention, not a
  // mandate — only duplicates fail, never absence.
  const ids = features.flatMap((f) => f.match(/\bF-[A-Z0-9]+-\d+\b/g) ?? []);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length > 0) {
    problems.push({ file, message: `duplicate Feature ID(s): ${dupes.join(", ")} — every citation of these is ambiguous` });
  }

  // Part A is frozen by an approval that actually happened; the record of it
  // is one dated line. A spec that cannot say when it was approved was not.
  if (!sectionBody(src, "Approval").some((l) => l.trim() !== "")) {
    problems.push({
      file,
      message: 'section "### Approval" is empty — record the user\'s approval of Part A (date) before building',
    });
  }

  // Scope nobody bounded is scope the builder invents — the documented failure
  // mode of every requirement-expanding agent. "- None declared." is honest and
  // passes; an absent decision does not.
  if (!sectionBody(src, "Out of Scope").some((l) => LIST_ITEM.test(l))) {
    problems.push({
      file,
      message: 'section "## Out of Scope" has no items — list the exclusions (exhaustive), or state "- None declared."',
    });
  }

  // A UI Design section that says nothing is a screen nobody designed.
  if (!sectionBody(src, "UI Design").some((l) => l.trim() !== "")) {
    problems.push({
      file,
      message: 'section "## UI Design" is empty — record the design system, layout, and each screen\'s primary object, primary action, states, and narrow-width behavior',
    });
  }

  // Quality Conformance is where the Quality Standard becomes this app's
  // decisions: one entry per standard section, Q1–Q18. A missing entry is a
  // quality area nobody decided — the exact hole the verifier keeps finding
  // in code instead of in the spec.
  const qNumbers = new Set(
    sectionBody(src, "Quality Conformance")
      .flatMap((l) => [...l.matchAll(/\*\*Q(\d+)\b/g)].map((m) => Number(m[1]))),
  );
  const missingQ = Array.from({ length: 18 }, (_, i) => i + 1).filter((n) => !qNumbers.has(n));
  if (missingQ.length > 0) {
    problems.push({
      file,
      message: `section "## Quality Conformance" is missing entr${missingQ.length === 1 ? "y" : "ies"} ${missingQ.map((n) => `Q${n}`).join(", ")} — every standard section gets this app's decision (or N/A with the reason)`,
    });
  }
  return problems;
}

/** The "## Features" list items: the checkable capability statements a
 *  walk-verify agent drives one by one, including those grouped under
 *  "### Module: <name>" subheadings. */
export function requirementsFeatures(projectDir: string): string[] {
  const path = join(projectDir, "reference", "requirements.md");
  if (!existsSync(path)) return [];
  const src = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const line of sectionBody(src, "Features")) {
    const m = line.match(LIST_ITEM);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** `reference/tasks.md` — the build ledger. A build with no ledger cannot show
 *  what it did: every task cites the Feature ID or Part B section it
 *  implements, and completed tasks are the record walk-verify's builder
 *  hand-off rests on. */
export function validateTasksDoc(projectDir: string): FrameworkFileProblem[] {
  const file = join("reference", "tasks.md");
  const path = join(projectDir, file);
  if (!existsSync(path)) {
    return [{ file, message: "missing — derive the task ledger from the approved spec before building (one task per Feature ID or Q-entry)" }];
  }
  const src = readFileSync(path, "utf8");
  const markers = src.split("\n").filter((l) => TEMPLATE_MARKER.test(l)).length;
  if (markers > 0) {
    return [{ file, message: `${markers} template placeholder(s) <REPLACE: …> remain — derive real tasks from the approved spec` }];
  }
  if (!src.split("\n").some((l) => /^\s*[-*]\s+\[[ xX]\]\s+\S/.test(l))) {
    return [{ file, message: 'has no tasks — at least one "- [ ] T-n (F-…): …" item is required; the ledger is how the build shows what it did' }];
  }
  return [];
}

/** Run every framework-file check. */
export function validateFrameworkFiles(projectDir: string): FrameworkFileProblem[] {
  return [
    ...validateManifest(projectDir),
    ...validateOperations(projectDir),
    ...validateAgentAppDoc(projectDir),
    ...validateRequirementsDoc(projectDir),
    ...validateTasksDoc(projectDir),
  ];
}
