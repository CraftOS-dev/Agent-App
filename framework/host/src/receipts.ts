/**
 * Receipts + the false-claim gate. A HOST obligation: what the user is told
 * about a mutation is generated from the STORED record by the system, not
 * composed by the model; and an agent's unsupported success claim is withheld
 * and returned to the agent to correct, so the user never sees the system
 * contradict the agent.
 *
 * Pure and dependency-free so any host embeds it.
 */
import type { DescribeEntity } from "@a2app/sdk";

export type WriteVerb = "created" | "updated" | "deleted";

export interface WriteRecord {
  verb: WriteVerb;
  entity: string;
  id: string;
  /** the stored record after the write (absent for a delete). */
  record?: Record<string, unknown>;
  /** the run this write belongs to (for the false-claim gate). */
  run?: string;
  at?: string;
}

/* ------------------------------------------------------------- receipts */

export interface HumanizeOptions {
  /**
   * The ENTITY level of describe for the entity being written (A2APP-SPEC 3.3).
   *
   * One entity, not the whole model: a receipt is generated for one write, and
   * the caller has already navigated to that entity to perform it. Requiring the
   * whole model here would put a cost on every receipt proportional to the size
   * of the app rather than the size of the write.
   */
  entity: DescribeEntity;
  /** resolve a ref id to its human label, if the host can. Return null to fall
   *  back to the id. */
  resolveRef?: (entity: string, id: string) => string | null;
}

/** Generate the user-facing receipt for one write, FROM the stored record. */
export function humanizeWrite(write: WriteRecord, opts: HumanizeOptions): string {
  const entityDef = opts.entity;
  const label = recordLabel(write, entityDef);
  const noun = singular(write.entity);
  if (write.verb === "deleted") return `Deleted ${noun} "${label}".`;
  const verb = write.verb === "created" ? "Created" : "Updated";
  const details = write.record ? humanizeFields(write.record, entityDef, opts) : [];
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return `${verb} ${noun} "${label}"${suffix}.`;
}

function recordLabel(write: WriteRecord, def: DescribeEntity): string {
  const labelField = def.label;
  const rec = write.record ?? {};
  if (labelField && rec[labelField] != null && rec[labelField] !== "") return String(rec[labelField]);
  return write.id;
}

function humanizeFields(rec: Record<string, unknown>, def: DescribeEntity, opts: HumanizeOptions): string[] {
  const out: string[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    if (name === def.label || field.readOnly) continue;
    const v = rec[name];
    if (v == null || v === "") continue;
    if (field.type === "enum") out.push(`${prettify(name)}: ${prettify(String(v))}`);
    else if ((field.type === "ref" || field.type === "list<ref>") && field.entity) {
      const ids = Array.isArray(v) ? v : [v];
      const labels = ids.map((id) => opts.resolveRef?.(field.entity!, String(id)) ?? String(id));
      out.push(`${prettify(name)}: ${labels.join(", ")}`);
    } else if (field.type === "boolean") {
      if (v === true) out.push(prettify(name));
    } else if (typeof v === "string" || typeof v === "number") {
      out.push(`${prettify(name)}: ${v}`);
    }
    if (out.length >= 4) break; // a receipt is a sentence, not a dump
  }
  return out;
}

function prettify(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function singular(entity: string): string {
  return entity.endsWith("ies") ? entity.slice(0, -3) + "y" : entity.endsWith("s") ? entity.slice(0, -1) : entity;
}

/* ------------------------------------------------------- false-claim gate */

/** Records writes per run so the gate can tell a real mutation from a claim. */
export class WriteLedger {
  private writes: WriteRecord[] = [];
  record(w: WriteRecord): void {
    this.writes.push(w);
  }
  /** writes recorded for a run (or all, if run is omitted). */
  forRun(run?: string): WriteRecord[] {
    return run === undefined ? this.writes.slice() : this.writes.filter((w) => w.run === run);
  }
  countForRun(run?: string): number {
    return this.forRun(run).length;
  }
  clear(): void {
    this.writes = [];
  }
}

export interface GateResult {
  /** true = the agent's message may be shown to the user as-is. */
  pass: boolean;
  /** when withheld, the machine-readable correction returned to the AGENT (never
   *  shown to the user). */
  correction?: string;
}

// A narrow, precision-biased mutation-claim detector: a clear completion verb,
// not phrased as a question. Questions and hedged statements always pass.
const MUTATION_CLAIM = /\b(created|added|updated|changed|edited|deleted|removed|saved|set|marked|archived|completed|done|scheduled|assigned)\b/i;

/**
 * If the agent asserts a completed mutation but no write is recorded for the run,
 * withhold the message and return the discrepancy to the agent. The gate is
 * precision-biased: questions pass, the detector is narrow, and it only fires on
 * "claimed a change, recorded none".
 */
export function falseClaimGate(claim: string, ledger: WriteLedger, run?: string): GateResult {
  const text = claim.trim();
  if (text === "" || text.endsWith("?")) return { pass: true }; // a question is never a claim
  if (!MUTATION_CLAIM.test(text)) return { pass: true }; // not a mutation claim
  if (ledger.countForRun(run) > 0) return { pass: true }; // a write backs it
  return {
    pass: false,
    correction:
      "false_claim: you asserted a completed change but no write was recorded for this run. " +
      "Do NOT report a mutation as done until the app confirms it landed. Make the write (or read it back to confirm), then report.",
  };
}
