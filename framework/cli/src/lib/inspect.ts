/**
 * Inspecting a staged package (framework packaging §5): what it is, and what
 * installing it would do — read from the staged tree alone, with nothing from
 * it run. `agent-app inspect` prints the report; `install` takes the same
 * inspection as its second step, so the two can never disagree.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "./json.js";
import { AGENT_APP_VERSION } from "./manifest.js";
import {
  classify,
  exclusionRules,
  findPlaceholders,
  IDENTITY_TOKENS,
  packageIntegrity,
  strippable,
  type Classified,
  type Integrity,
  type PackageKind,
  type Route,
} from "./package.js";
import { UsageError } from "./project.js";
import type { Acquired, Provenance } from "./sources.js";
import { adapterVersionOf, installedToolkit, isToolkitId, resolveToolkit, templateRoot, type ResolvedToolkit } from "./toolkit.js";

/** `agent-app inspect`'s report (schema `inspect-report.schema.json`). */
export interface InspectReport {
  ok: true;
  kind: PackageKind;
  installable: boolean;
  reason: string | null;
  /** for a tree that is not a package: what can be done with it instead (§7) */
  routes: Route[];
  source: Provenance & { name?: string };
  app: { name: string | null; authMode: string | null; modules: string[] };
  toolkit: { id: string | null; installed: boolean; adapterVersion: { package: string | null; current: string | null } } | null;
  integrity: Integrity;
  pipeline: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  strips: string[];
  placeholders: string[];
  warnings: string[];
  /** `--keep`: where the source was kept */
  kept?: string;
}

export interface Inspection {
  report: InspectReport;
  classified: Classified;
  /** the locally installed toolkit the package would be re-vendored from, when there is one */
  toolkit: ResolvedToolkit | null;
  /** the toolkit id asked for (`--blueprint`, else the package's record) */
  toolkitId: string | null;
  /** what sanitize removes from the staged tree (beyond what acquire already left behind) */
  strips: string[];
}

export interface InspectOptions {
  /** `--blueprint`: the toolkit to re-vendor from, chosen by the person installing */
  blueprint?: string;
  /** trees no toolkit may be taken from: the staging area and the package's own folder */
  untrusted: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The toolkit id a package records, and what about the record deserves a warning. Its path is never read. */
function recordedToolkit(root: string, warnings: string[]): string | null {
  const file = join(root, ".a2app", "toolkit.json");
  if (!existsSync(file)) return null;
  let record: { id?: unknown; source?: unknown };
  try {
    record = readJsonFile(file) as { id?: unknown; source?: unknown };
  } catch {
    warnings.push(".a2app/toolkit.json is not valid JSON, so it names no toolkit");
    return null;
  }
  if (record?.source !== undefined) {
    warnings.push(".a2app/toolkit.json names a toolkit path; it is ignored — a package never chooses which code is trusted");
  }
  if (isToolkitId(record?.id)) return record.id;
  if (record?.id !== undefined) warnings.push(`.a2app/toolkit.json names ${JSON.stringify(record.id)}, which is not a toolkit id`);
  return null;
}

/** The commands the toolkit's own manifest runs: what the app's pipeline becomes once re-vendored. */
function toolkitPipeline(tk: ResolvedToolkit): Record<string, unknown> | null {
  const file = join(templateRoot(tk), "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const pipeline = (readJsonFile(file) as { pipeline?: unknown }).pipeline;
    return pipeline !== null && typeof pipeline === "object" ? (pipeline as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function inspectStaged(acquired: Acquired, opts: InspectOptions): Inspection {
  const root = acquired.root;
  const warnings = [...acquired.warnings];
  const classified = classify(root);
  const m = classified.manifest ?? {};

  let toolkitId: string | null = null;
  let toolkit: ResolvedToolkit | null = null;
  if (classified.kind === "agent-app") {
    const recorded = recordedToolkit(root, warnings);
    if (opts.blueprint !== undefined) {
      toolkitId = opts.blueprint;
      try {
        toolkit = resolveToolkit(opts.blueprint, opts.untrusted);
      } catch (err) {
        // A --blueprint that names nothing is a mistyped command, not a property of the package.
        throw new UsageError((err as Error).message);
      }
      if (recorded !== null && recorded !== toolkit.manifest.id) {
        warnings.push(`the package was built on "${recorded}"; --blueprint re-vendors it from "${toolkit.manifest.id}"`);
      }
    } else {
      toolkitId = recorded;
      toolkit = recorded === null ? null : installedToolkit(recorded, opts.untrusted);
    }
  }

  const rules = exclusionRules(root, toolkit);
  const strips = strippable(root, rules);
  const { integrity, warning } = packageIntegrity(root, toolkit?.manifest.systemPaths ?? null);
  if (warning !== null) warnings.push(warning);

  let installable = false;
  let reason = classified.reason;
  if (classified.kind === "agent-app") {
    if (toolkitId === null) {
      reason = "the package names no toolkit (.a2app/toolkit.json) — pass --blueprint <id> to re-vendor it from one installed here";
    } else if (toolkit === null) {
      reason = `toolkit "${toolkitId}" is not installed here — install it, or pass --blueprint <id> to choose one that is`;
    } else {
      installable = true;
    }
    if (integrity.canon === "drifted") {
      warnings.push(`its system files differ from its own canon (${(integrity.changed ?? []).join(", ") || "unreadable canon"}); install replaces them from the local toolkit`);
    } else if (integrity.canon === "absent") {
      warnings.push("it records no ownership canon; install records one after re-vendoring");
    }
    const packaged = str(m["adapterVersion"]);
    if (toolkit !== null && packaged !== null && packaged !== adapterVersionOf(toolkit)) {
      warnings.push(`its adapter ${packaged} is replaced by the local toolkit's ${adapterVersionOf(toolkit)}`);
    }
    const written = str(m["agentAppVersion"]);
    if (written !== null && written !== AGENT_APP_VERSION) {
      warnings.push(`it was written for framework ${written}; this CLI is ${AGENT_APP_VERSION}`);
    }
  }

  const placeholders = findPlaceholders(root, rules);
  const known = new Set<string>([...IDENTITY_TOKENS, ...(acquired.entry?.customizable ?? []).map((f) => f.key)]);
  const unknown = placeholders.filter((p) => !known.has(p.slice(2, -2)));
  if (unknown.length > 0) {
    warnings.push(`${unknown.join(", ")} ${unknown.length === 1 ? "has" : "have"} no value unless given with --set, and stay as written otherwise`);
  }
  const entryVersion = acquired.entry?.version;
  const appVersion = str(m["appVersion"]);
  if (entryVersion !== undefined && appVersion !== null && entryVersion !== appVersion) {
    warnings.push(`the catalogue lists version ${entryVersion}; the package says ${appVersion}`);
  }

  const modules = Array.isArray(m["modules"])
    ? (m["modules"] as unknown[]).map((x) => str((x as { name?: unknown } | null)?.name)).filter((n): n is string => n !== null)
    : [];
  const capabilities = m["capabilities"];
  const report: InspectReport = {
    ok: true,
    kind: classified.kind,
    installable,
    reason: installable ? null : reason,
    routes: classified.routes,
    source: { ...acquired.provenance, ...(acquired.entry !== null ? { name: acquired.entry.name } : {}) },
    app: { name: str(m["name"]), authMode: str(m["authMode"]), modules },
    toolkit:
      classified.kind === "agent-app"
        ? {
            id: toolkit?.manifest.id ?? toolkitId,
            installed: toolkit !== null,
            adapterVersion: { package: str(m["adapterVersion"]), current: toolkit !== null ? adapterVersionOf(toolkit) : null },
          }
        : null,
    integrity,
    pipeline: toolkit !== null ? toolkitPipeline(toolkit) : null,
    capabilities: capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities) ? (capabilities as Record<string, unknown>) : null,
    strips: [...new Set([...acquired.skipped, ...strips])].sort(),
    placeholders,
    warnings,
  };
  return { report, classified, toolkit, toolkitId, strips };
}
