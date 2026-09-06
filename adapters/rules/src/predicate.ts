/**
 * Availability predicates: the closed, schema-based language an operation uses to
 * declare when it applies to a record (A2APP-SPEC 3.4).
 *
 * The record level of describe shows every operation attached to an entity and
 * marks each one available or blocked *for this record*. Deciding that is what
 * this module does. Three properties are load-bearing and shape every choice
 * below:
 *
 * 1. **Machine-evaluable.** Natural-language conditions are prohibited, exactly
 *    as they are for event subscriptions (A2APP-SPEC 6.1). A model never decides
 *    whether an action is allowed.
 * 2. **Machine-explainable.** A blocked operation must state its own reason, and
 *    that reason is derived here from the predicate and the record's stored
 *    values — never composed by a model. This is the same discipline as receipts.
 * 3. **Type-directed.** Comparison follows the field's DECLARED type, not the
 *    runtime shape of whatever the backend happened to return. A backend is only
 *    obliged to return what it stored, so `done: "true"` and `done: true` are the
 *    same boolean and must compare equal. Guessing from the value's JS type would
 *    make availability depend on the storage engine.
 *
 * Pure: no I/O, no clock, no backend. Shared verbatim by every adapter in every
 * language, so two stacks block the same operation on the same record for the
 * same stated reason.
 */
import { isBlank, type NormalizedField, type ProtocolType } from "./index.js";

/* ------------------------------------------------------------------- types */

/** Compare one field against a literal. */
export interface LeafEq {
  field: string;
  eq: unknown;
}
export interface LeafNe {
  field: string;
  ne: unknown;
}
export interface LeafIn {
  field: string;
  in: unknown[];
}
export interface LeafNotIn {
  field: string;
  notIn: unknown[];
}
/** `isBlank: true` holds when the field is null, undefined, or "". */
export interface LeafBlank {
  field: string;
  isBlank: boolean;
}

export interface AllOf {
  all: Predicate[];
}
export interface AnyOf {
  any: Predicate[];
}
export interface NotOf {
  not: Predicate;
}

/**
 * The whole language. Deliberately closed: every form here can be evaluated and
 * explained without a model, and extending it is a protocol change.
 */
export type Predicate = LeafEq | LeafNe | LeafIn | LeafNotIn | LeafBlank | AllOf | AnyOf | NotOf;

/* -------------------------------------------------------------- narrowing */

const has = (p: object, k: string): boolean => Object.prototype.hasOwnProperty.call(p, k);

const isEq = (p: Predicate): p is LeafEq => has(p, "eq");
const isNe = (p: Predicate): p is LeafNe => has(p, "ne");
const isIn = (p: Predicate): p is LeafIn => has(p, "in");
const isNotIn = (p: Predicate): p is LeafNotIn => has(p, "notIn");
const isBlankLeaf = (p: Predicate): p is LeafBlank => has(p, "isBlank");
const isAll = (p: Predicate): p is AllOf => has(p, "all");
const isAny = (p: Predicate): p is AnyOf => has(p, "any");
const isNot = (p: Predicate): p is NotOf => has(p, "not");

/* ------------------------------------------------------------- comparison */

/**
 * Read a value as its field's declared type, so comparison is decided by the
 * model and not by how a backend chose to serialize. Returns `null` for blank —
 * blankness is asked about explicitly with `isBlank`, never inferred from a
 * failed comparison.
 */
function asDeclared(value: unknown, type: ProtocolType | undefined): unknown {
  if (isBlank(value)) return null;
  switch (type) {
    case "boolean":
      // A backend may store a boolean as text; both are the same boolean.
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    case "number": {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const n = Number(value);
        return Number.isFinite(n) ? n : value;
      }
      return value;
    }
    case "string":
    case "enum":
    case "ref":
    case "datetime":
      return typeof value === "string" ? value : value;
    default:
      return value;
  }
}

/** Structural equality after declared-type reading. Arrays and objects compare
 *  by canonical JSON so `list<ref>` membership is well defined. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/* ------------------------------------------------------------- evaluation */

type FieldIndex = Map<string, NormalizedField>;

/** Index a field list once per evaluation rather than scanning per leaf. */
export function indexFields(fields: readonly NormalizedField[]): FieldIndex {
  const index: FieldIndex = new Map();
  for (const f of fields) index.set(f.name, f);
  return index;
}

function readField(record: Record<string, unknown>, name: string, index: FieldIndex): unknown {
  return asDeclared(record[name], index.get(name)?.type);
}

/**
 * Does this predicate hold for this record?
 *
 * A leaf naming a field the record does not carry reads as blank, which is the
 * honest answer: an absent value is not equal to anything, and `isBlank` is the
 * form that asks about absence.
 */
export function evaluatePredicate(
  predicate: Predicate,
  record: Record<string, unknown>,
  fields: readonly NormalizedField[] | FieldIndex,
): boolean {
  const index = fields instanceof Map ? fields : indexFields(fields);
  return evaluate(predicate, record, index);
}

function evaluate(p: Predicate, record: Record<string, unknown>, index: FieldIndex): boolean {
  if (isAll(p)) return p.all.every((sub) => evaluate(sub, record, index));
  if (isAny(p)) return p.any.some((sub) => evaluate(sub, record, index));
  if (isNot(p)) return !evaluate(p.not, record, index);

  const actual = readField(record, p.field, index);
  const declared = index.get(p.field)?.type;

  if (isBlankLeaf(p)) return (actual === null) === p.isBlank;
  if (isEq(p)) return sameValue(actual, asDeclared(p.eq, declared));
  if (isNe(p)) return !sameValue(actual, asDeclared(p.ne, declared));
  if (isIn(p)) return p.in.some((candidate) => sameValue(actual, asDeclared(candidate, declared)));
  if (isNotIn(p)) return !p.notIn.some((candidate) => sameValue(actual, asDeclared(candidate, declared)));

  // Unreachable for a validated predicate. Refuse rather than default to
  // available: an unrecognised form must never silently unblock an action.
  return false;
}

/* ------------------------------------------------------------ explanation */

function render(value: unknown): string {
  if (value === null || value === undefined) return "blank";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderList(values: unknown[]): string {
  const parts = values.map(render);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]!}`;
}

/**
 * Why this predicate does not hold, phrased for the agent that is about to be
 * told an operation is unavailable.
 *
 * Generated from the predicate and the record — deterministic, and the same
 * string on every stack. Reports the FIRST failing branch rather than every one:
 * the caller needs the reason it cannot proceed, and a compound predicate that
 * listed all of its unmet clauses would bury it.
 *
 * Calling this on a predicate that HOLDS is a caller bug; it returns a stable
 * marker rather than throwing, because a describe response must never fail to
 * render over an internal disagreement.
 */
export function explainPredicate(
  predicate: Predicate,
  record: Record<string, unknown>,
  fields: readonly NormalizedField[] | FieldIndex,
): string {
  const index = fields instanceof Map ? fields : indexFields(fields);
  if (evaluate(predicate, record, index)) return "the condition holds";
  return explain(predicate, record, index);
}

function explain(p: Predicate, record: Record<string, unknown>, index: FieldIndex): string {
  if (isAll(p)) {
    const failing = p.all.find((sub) => !evaluate(sub, record, index));
    return failing ? explain(failing, record, index) : "the condition holds";
  }
  if (isAny(p)) {
    // None held, so every branch failed; the first is the most specific thing to
    // say, and listing all of them reads as noise on a two-line record screen.
    const first = p.any[0];
    return first ? explain(first, record, index) : "no condition is satisfiable";
  }
  if (isNot(p)) {
    const inner = p.not;
    if (isBlankLeaf(inner)) {
      return inner.isBlank ? `${inner.field} is blank` : `${inner.field} is set`;
    }
    if (isEq(inner)) return `${inner.field} is ${render(readField(record, inner.field, index))}`;
    return `the condition on ${fieldOf(inner)} is not met`;
  }

  const actual = readField(record, p.field, index);
  if (isBlankLeaf(p)) {
    return p.isBlank ? `${p.field} is set to ${render(actual)}, not blank` : `${p.field} is blank`;
  }
  if (isEq(p)) return `${p.field} is ${render(actual)}, not ${render(p.eq)}`;
  if (isNe(p)) return `${p.field} is ${render(actual)}`;
  if (isIn(p)) return `${p.field} is ${render(actual)}, not ${renderList(p.in)}`;
  if (isNotIn(p)) return `${p.field} is ${render(actual)}`;
  return "the condition is not met";
}

function fieldOf(p: Predicate): string {
  if (isAll(p) || isAny(p) || isNot(p)) return "the record";
  return p.field;
}

/* ------------------------------------------------------------- validation */

/** Every field name a predicate reads, deduplicated. Used by the build gate to
 *  check that a predicate refers only to fields its entity actually has. */
export function predicateFields(predicate: Predicate): string[] {
  const out = new Set<string>();
  collect(predicate, out);
  return [...out];
}

function collect(p: Predicate, out: Set<string>): void {
  if (isAll(p)) return void p.all.forEach((sub) => collect(sub, out));
  if (isAny(p)) return void p.any.forEach((sub) => collect(sub, out));
  if (isNot(p)) return void collect(p.not, out);
  out.add(p.field);
}

/**
 * Structural check of an untrusted predicate, returning one message per problem.
 * An empty array means the value is a {@link Predicate}.
 *
 * Validating separately from evaluating is deliberate: the build gate rejects a
 * malformed predicate at declaration time, so the served surface never has to
 * decide what an unrecognised form means at request time.
 */
export function validatePredicate(value: unknown, at = "appliesWhen"): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${at}: must be an object`];
  }
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p);

  if (has(p, "all") || has(p, "any")) {
    const key = has(p, "all") ? "all" : "any";
    const branches = p[key];
    if (keys.length !== 1) return [`${at}: "${key}" is the only allowed key here, found ${keys.join(", ")}`];
    if (!Array.isArray(branches) || branches.length === 0) {
      return [`${at}.${key}: must be a non-empty array of predicates`];
    }
    return branches.flatMap((sub, i) => validatePredicate(sub, `${at}.${key}[${i}]`));
  }

  if (has(p, "not")) {
    if (keys.length !== 1) return [`${at}: "not" is the only allowed key here, found ${keys.join(", ")}`];
    return validatePredicate(p["not"], `${at}.not`);
  }

  if (!has(p, "field") || typeof p["field"] !== "string" || p["field"] === "") {
    return [`${at}: a leaf predicate needs a "field" (non-empty string)`];
  }
  const operators = ["eq", "ne", "in", "notIn", "isBlank"].filter((k) => has(p, k));
  if (operators.length !== 1) {
    return [
      `${at}: a leaf predicate needs exactly one of eq, ne, in, notIn, isBlank — found ${
        operators.length === 0 ? "none" : operators.join(", ")
      }`,
    ];
  }
  const extra = keys.filter((k) => k !== "field" && !operators.includes(k));
  if (extra.length > 0) return [`${at}: unknown key(s) ${extra.join(", ")}`];

  const operator = operators[0]!;
  if ((operator === "in" || operator === "notIn") && !Array.isArray(p[operator])) {
    return [`${at}.${operator}: must be an array`];
  }
  if (operator === "isBlank" && typeof p["isBlank"] !== "boolean") {
    return [`${at}.isBlank: must be a boolean`];
  }
  return [];
}
