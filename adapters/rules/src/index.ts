/**
 * A2App validation rules — PURE. No backend, no runtime, no I/O, no globals.
 *
 * This module is the "Pure rules" layer: it is shared verbatim by every A2App
 * adapter so that (for example) a PocketBase app and a Django app enforce
 * IDENTICAL rules. It is the single reason the guard's guarantee — "two backends
 * reject identical payloads identically" — holds.
 *
 * An adapter's only jobs are:
 *   1. map its backend's field types onto the protocol vocabulary below;
 *   2. call {@link validate} / {@link divergences};
 *   3. render the returned violations as its transport's error envelope.
 *
 * It deliberately RETURNS violations rather than throwing: throwing would
 * require a transport-specific error class, which is exactly the coupling this
 * file must avoid.
 *
 * Protocol type vocabulary (closed set):
 *   string · number · boolean · datetime · enum · ref
 *   list<enum> · list<ref> · json · binary
 */

/** Bumped only when the validation semantics change. */
export const RULES_VERSION = "0.1.0";

/**
 * Availability predicates (A2APP-SPEC 3.4): the closed language deciding whether
 * an operation applies to a given record, plus the deterministic explanation of
 * why it does not. Pure and shared for the same reason the guard is — two stacks
 * must block the same action on the same record for the same stated reason.
 */
export * from "./predicate.js";

/**
 * The per-response describe budget, in characters (A2APP-SPEC 1). Every describe
 * level fits this at any app size; an app whose module or entity would overflow
 * must subdivide. Lives here because the adapter enforces it at serve time and
 * the build gate enforces it at build time, and the two must not drift.
 */
export const DESCRIBE_BUDGET_CHARS = 2000;

/**
 * First path segments the operate CLI reserves for the protocol surface
 * (framework spec 5.1). A module may not take one of these names: the walk
 * resolves the first segment as a module unless it is reserved, so a module
 * named `data` would be permanently unreachable.
 */
export const RESERVED_PATH_SEGMENTS = ["data", "identity", "whoami", "context", "tasks", "events"] as const;

/** Module names are lower-kebab and never a reserved segment. */
const MODULE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Why this is not a usable module name, or null if it is one. */
export function moduleNameProblem(name: string): string | null {
  if (!MODULE_NAME.test(name)) {
    return `"${name}" is not a valid module name (lower-case, digits and hyphens, starting with a letter, max 32)`;
  }
  if ((RESERVED_PATH_SEGMENTS as readonly string[]).includes(name)) {
    return `"${name}" is reserved by the operate CLI (${RESERVED_PATH_SEGMENTS.join(", ")}) and would be unreachable as a module`;
  }
  return null;
}

/** The closed protocol type vocabulary. Extending it is a protocol version
 *  change. */
export const PROTOCOL_TYPES = [
  "string",
  "number",
  "boolean",
  "datetime",
  "enum",
  "ref",
  "list<enum>",
  "list<ref>",
  "json",
  "binary",
] as const;

export type ProtocolType = (typeof PROTOCOL_TYPES)[number];

/** The A2App error code registry. Clients branch on `code`, never on message
 *  prose. Unknown codes are treated as rejection, never success. */
export const ERROR_CODES = {
  UNKNOWN_FIELD: "unknown_field",
  READ_ONLY_FIELD: "read_only_field",
  INVALID_DATE: "invalid_date",
  INVALID_DAYKEY: "invalid_daykey",
  INVALID_STRING: "invalid_string",
  INVALID_NUMBER: "invalid_number",
  INVALID_BOOLEAN: "invalid_boolean",
  INVALID_ENUM: "invalid_enum",
  MISSING_REQUIRED: "missing_required",
  NOT_STORED: "not_stored",
  DUPLICATE_REQUEST: "duplicate_request",
  APPROVAL_REQUIRED: "approval_required",
  INSUFFICIENT_SCOPE: "insufficient_scope",
  AMBIGUOUS_REF: "ambiguous_ref",
  INVALID_FILTER: "invalid_filter",
  INVALID_EVENT: "invalid_event",
  TASK_NOT_FOUND: "task_not_found",
  TASK_NOT_CLAIMABLE: "task_not_claimable",
  TASK_CANCELED: "task_canceled",
  AGENT_TOKEN_REQUIRED: "agent_token_required",
  RATE_LIMITED: "rate_limited",
} as const;

/**
 * The normalised field contract every adapter maps its schema onto. `type` is a
 * protocol type (never the backend's native type). `dayKey` marks a `string`
 * field that stores a `YYYY-MM-DD` date-as-text to dodge timezone drift.
 */
export interface NormalizedField {
  name: string;
  type: ProtocolType;
  required?: boolean;
  readOnly?: boolean;
  /** never advertised in describe, never validated as writable (e.g. password) */
  writeOnly?: boolean;
  max?: number;
  values?: string[];
  /** target entity for `ref` / `list<ref>` */
  entity?: string;
  /** true for a `string` field carrying a `YYYY-MM-DD` day key */
  dayKey?: boolean;
}

/** A single guard rejection. */
export interface Violation {
  code: string;
  field: string;
  expected: string;
  got: unknown;
}

/** A read-back divergence: a value was requested but nothing landed. */
export interface Divergence {
  field: string;
  type: ProtocolType;
  stored: string;
}

export interface ValidateOptions {
  /** extra keys accepted without being fields (e.g. 'id', auth signup fields) */
  allow?: Record<string, unknown>;
  /**
   * Enforce required-field presence. Set ONLY on a create (POST): a required
   * field that is absent or blank is a `missing_required` violation. Left off
   * for update/patch, where a partial write is legitimate and a blank value
   * clears a field — enforcing required there would break both.
   */
  requireRequired?: boolean;
}

/* ------------------------------------------------------------------ helpers */

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** Regex alone accepts 2026-13-45, so check the calendar too. */
export function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let max = lengths[m - 1]!;
  if (m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) max = 29;
  return d <= max;
}

/** Accepts ISO 8601 date or datetime, with or without a timezone suffix. */
export function looksLikeDate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = v.match(
    /^(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/,
  );
  return !!m && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** A bare `YYYY-MM-DD` day key with a valid calendar date. */
export function isDayKeyValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return !!m && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Day-keys are stored as plain text to dodge timezone drift. No type check can
 * protect them: writing "tomorrow" stores it verbatim, the field LOOKS
 * populated, and because comparison is lexical the row becomes permanently
 * invisible to `due <= "2026-07-29"` ("t" > "2"). Hence a name+width convention:
 * a short `string` field named like a date.
 */
export function isDayKeyField(field: Pick<NormalizedField, "type" | "max" | "name">): boolean {
  if (field.type !== "string") return false;
  const max = field.max ?? 0;
  if (max <= 0 || max > 12) return false;
  return /^(due|day|date)$|_(date|day)$/i.test(field.name);
}

/**
 * Field lookup keyed by name. The map has a NULL prototype because its keys come
 * from the request body: on a plain object, `map["constructor"]` resolves up the
 * prototype chain and returns a truthy value, so an undeclared field named after
 * any Object.prototype member reads as declared. It then passes the unknown-field
 * check and every check after it — the one guarantee this module exists to make,
 * silently voided by the field's name.
 */
function fieldMap(fields: NormalizedField[]): Record<string, NormalizedField> {
  const m: Record<string, NormalizedField> = Object.create(null) as Record<string, NormalizedField>;
  for (const f of fields) m[f.name] = f;
  return m;
}

function writableNames(fields: NormalizedField[]): string[] {
  return fields.filter((f) => !f.readOnly).map((f) => f.name);
}

function violation(code: string, field: string, expected: string, got: unknown): Violation {
  return { code, field, expected, got: got === undefined ? null : got };
}

/** The field a human would name a record by — needed to resolve a label to an
 *  id. Preference order: title, name, label, then the first required string. */
export function labelFieldOf(fields: NormalizedField[]): string | null {
  const names = fields.map((f) => f.name);
  for (const preferred of ["title", "name", "label"]) {
    if (names.includes(preferred)) return preferred;
  }
  for (const f of fields) {
    if (f.type === "string" && f.required && !f.readOnly) return f.name;
  }
  return null;
}

/* --------------------------------------------------------------- validation */

/**
 * Validate a RAW request body against normalised fields.
 *
 * IMPORTANT: the body must be raw — the values as the client sent them. A
 * backend that coerces before validation defeats this entirely (an invalid date
 * and a deliberately cleared field become indistinguishable).
 *
 * Returns [] when the body is acceptable; otherwise every violation in the
 * request (a rejection lists every violation, not the first).
 */
export function validate(
  fields: NormalizedField[],
  body: Record<string, unknown>,
  opts: ValidateOptions = {},
): Violation[] {
  const allow = opts.allow ?? {};
  const map = fieldMap(fields);
  const writable = writableNames(fields);
  const out: Violation[] = [];
  // Every lookup below is keyed by a name taken from the request body, so it
  // must be an OWN-property test. `allow["constructor"]` and `map["toString"]`
  // are truthy on any plain object, which let a field named after an
  // Object.prototype member skip the allow check, read as declared, and pass
  // every remaining rule — the guard silently voided by the field's name.
  const has = (o: Record<string, unknown> | Record<string, NormalizedField>, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(o, k);

  for (const key of Object.keys(body)) {
    if (has(allow, key) && allow[key]) continue;

    const field = has(map, key) ? map[key] : undefined;

    // Unknown fields are silently dropped by most backends and absent from the
    // response, so the caller cannot tell they were ignored.
    if (!field) {
      // An operation may legitimately declare no parameters at all, and "one
      // of: " with nothing after it reads as a truncated message rather than as
      // the answer it is.
      const accepted = writable.length ? "one of: " + writable.join(", ") : "nothing — no writable fields are declared";
      out.push(violation(ERROR_CODES.UNKNOWN_FIELD, key, accepted, body[key]));
      continue;
    }
    if (field.readOnly) {
      out.push(violation(ERROR_CODES.READ_ONLY_FIELD, key, "not writable (server-managed)", body[key]));
      continue;
    }

    const value = body[key];
    // Blank means "clear this field" — a legitimate operation, only
    // distinguishable from garbage because we see the raw value. It is only
    // legitimate on a NON-required field: clearing a required one leaves the
    // record in a state the schema says cannot exist, and on a partial update
    // nothing else would catch it.
    if (isBlank(value)) {
      if (field.required) {
        out.push(violation(ERROR_CODES.MISSING_REQUIRED, key, "a non-blank value (required field)", value));
      }
      continue;
    }

    if (field.type === "datetime" && !looksLikeDate(value)) {
      out.push(violation(ERROR_CODES.INVALID_DATE, key, "an ISO 8601 date", value));
      continue;
    }
    if (field.dayKey && !isDayKeyValue(value)) {
      out.push(violation(ERROR_CODES.INVALID_DAYKEY, key, 'a day key "YYYY-MM-DD"', value));
      continue;
    }
    if (field.type === "string" && typeof value !== "string") {
      // A boolean/number landing in a text field. It happens: a value eaten by
      // shell quoting becomes a bare flag, the client sends `true`, and the
      // backend stores the string "true". The one unchecked type is where it
      // lands, so check it.
      out.push(violation(ERROR_CODES.INVALID_STRING, key, "text", value));
      continue;
    }
    // `max` is published in describe, so a client plans against it; a backend
    // that silently truncates (or a column that rejects at insert time) turns an
    // advertised constraint into a surprise. Length is the documented meaning of
    // `max` on a string field.
    if (field.type === "string" && typeof field.max === "number" && (value as string).length > field.max) {
      out.push(violation(ERROR_CODES.INVALID_STRING, key, `text of at most ${field.max} characters`, value));
      continue;
    }
    if (field.type === "number" && typeof value !== "number") {
      if (typeof value !== "string" || value.trim() === "" || isNaN(Number(value))) {
        out.push(violation(ERROR_CODES.INVALID_NUMBER, key, "a number", value));
        continue;
      }
    }
    if (field.type === "boolean" && typeof value !== "boolean") {
      if (value !== "true" && value !== "false") {
        out.push(violation(ERROR_CODES.INVALID_BOOLEAN, key, "true or false", value));
        continue;
      }
    }
    if (field.type === "enum" && field.values && field.values.length) {
      if (!field.values.some((v) => String(v) === String(value))) {
        out.push(violation(ERROR_CODES.INVALID_ENUM, key, "one of: " + field.values.join(" | "), value));
        continue;
      }
    }
    if (field.type === "list<enum>" && field.values && field.values.length) {
      // The wire form of a list type is an array. Accepting a bare scalar and
      // wrapping it hides a client bug and makes the stored shape depend on how
      // many values happened to be sent.
      if (!Array.isArray(value)) {
        out.push(violation(ERROR_CODES.INVALID_ENUM, key, "an array of: " + field.values.join(" | "), value));
        continue;
      }
      const bad = value.find((item) => !field.values!.some((v) => String(v) === String(item)));
      if (bad !== undefined) {
        out.push(violation(ERROR_CODES.INVALID_ENUM, key, "each of: " + field.values.join(" | "), value));
        continue;
      }
    }
  }

  // Required-field guard — create only. A backend silently accepts a create that
  // omits a required column and stores a half-built row; the agent then reports
  // success. Catch it at the guard so a missing required field is a rejection,
  // not a corrupt record. Skipped on update/patch (partial writes are legitimate).
  // A required field that was PROVIDED but blank is already reported above (that
  // check applies to updates too), so this only covers the create-specific case:
  // the field is absent entirely. Reporting both would list one mistake twice.
  if (opts.requireRequired) {
    for (const f of fields) {
      if (!f.required || f.readOnly) continue;
      if (!Object.prototype.hasOwnProperty.call(body, f.name)) {
        out.push(violation(ERROR_CODES.MISSING_REQUIRED, f.name, "a non-blank value (required field)", undefined));
      }
    }
  }
  return out;
}

/**
 * Read-back backstop: which non-blank requested values failed to land?
 *
 * `read(name)` returns the stored value for a field. Deliberately conservative —
 * flags only "asked for something, stored nothing" — so it never
 * false-positives on a legitimate false/0/"" write, nor on a backend
 * normalising a timezone offset.
 */
export function divergences(
  fields: NormalizedField[],
  body: Record<string, unknown>,
  read: (name: string) => unknown,
): Divergence[] {
  const map = fieldMap(fields);
  const out: Divergence[] = [];
  for (const key of Object.keys(body)) {
    const field = map[key];
    // A write-only field (e.g. a password) is accepted on write but deliberately
    // never returned by the backend, so "not in the read-back" is expected, not a
    // divergence — exempt it or every password write would read as incomplete.
    if (!field || field.readOnly || field.writeOnly) continue;
    const requested = body[key];
    if (isBlank(requested)) continue;
    let stored: unknown;
    try {
      stored = read(key);
    } catch {
      stored = null;
    }
    if (isBlank(stored)) {
      out.push({ field: key, type: field.type, stored: String(stored) });
    }
  }
  return out;
}

/* ----------------------------------------------------------------- messages */

/** One human+machine readable sentence. Adapters MUST NOT invent their own —
 *  identical rules must produce identical text on every backend. */
export function describeViolation(v: Violation, serverNow?: string): string {
  let msg =
    "Rejected by a2app (" +
    v.code +
    '): field "' +
    v.field +
    '" expects ' +
    v.expected +
    "; got " +
    JSON.stringify(v.got);
  if (v.code === ERROR_CODES.INVALID_DATE || v.code === ERROR_CODES.INVALID_DAYKEY) {
    if (serverNow) msg += '. Example: "' + String(serverNow).slice(0, 10) + '"';
  }
  if (serverNow) msg += ". Server time is " + serverNow;
  return msg + ".";
}

export function describeIncomplete(lost: Divergence[]): string {
  const names = lost.map((l) => l.field);
  return (
    "Rejected by a2app (not_stored): the database did not store " +
    names.join(", ") +
    ". Do NOT report this as done."
  );
}

/* --------------------------------------------------------------- fingerprint */

/** Every attribute of a field that describe publishes, rendered deterministically.
 *  Omitted when unset, so adding an attribute to the model changes the string
 *  while an untouched field keeps its rendering stable. */
function fieldPrint(f: NormalizedField): string {
  const parts = [`${f.name}:${f.type}`];
  if (f.required) parts.push("req");
  if (f.readOnly) parts.push("ro");
  if (f.writeOnly) parts.push("wo");
  if (f.dayKey) parts.push("day");
  if (typeof f.max === "number") parts.push(`max=${f.max}`);
  if (f.entity) parts.push(`entity=${f.entity}`);
  if (f.values && f.values.length) parts.push(`values=${[...f.values].sort().join("|")}`);
  return parts.join(":");
}

/**
 * A stable fingerprint of everything describe publishes, so clients can cache
 * describe against it and re-fetch when it changes. Pure and deterministic: the
 * same model in, the same `sv_…` out, regardless of ordering.
 *
 * It covers every published attribute, not just name and type. A client caches
 * describe against this value and is told never to write against a stale schema
 * (section 2) — so narrowing an enum, making a field required, tightening `max`,
 * or retargeting a `ref` MUST change it. If it did not, every cached client
 * would keep writing against a model the app no longer has, and the guard
 * rejections would look inexplicable to the agent.
 *
 * Operations are included for the same reason: they are part of the same cached
 * document, so removing one has to invalidate the cache that still advertises it.
 */
export function schemaFingerprint(
  entities: Record<string, EntityPrint>,
  operations: readonly OperationPrint[] = [],
): string {
  const parts: string[] = [];
  for (const [name, print] of Object.entries(entities)) {
    const attrs = [`${name}(${print.fields.map(fieldPrint).sort().join(",")})`];
    // `auth` and `module` are published by describe, so they must move the hash:
    // a client caching against it would otherwise keep a document that puts the
    // entity in a module it has left, or omits an auth marker it has gained.
    if (print.auth) attrs.push("auth");
    attrs.push(`mod=${print.module}`);
    parts.push(attrs.join(":"));
  }
  parts.sort();
  const ops = operations.map(operationPrint).sort();
  const joined = parts.join(";") + "|" + ops.join(",");
  let h = 5381;
  for (let k = 0; k < joined.length; k++) h = ((h * 33) ^ joined.charCodeAt(k)) >>> 0;
  return "sv_" + h.toString(16);
}

/**
 * Everything describe publishes about one operation, rendered deterministically.
 *
 * `params` and `appliesWhen` are included because both are published and both
 * are load-bearing for a cached client: a narrowed parameter type or a changed
 * availability rule leaves a stale cache advertising a signature the app no
 * longer accepts. They are canonicalised through sorted-key JSON so that key
 * order in the declaration cannot change the hash.
 */
function operationPrint(o: OperationPrint): string {
  const flags = [o.destructive ? "d" : "", o.readOnly ? "r" : "", o.idempotent ? "i" : ""].filter(Boolean);
  const parts = [flags.length ? `${o.name}:${flags.join("")}` : o.name];
  parts.push(`mod=${o.module}`);
  if (o.entity) parts.push(`on=${o.entity}`);
  if (o.params && Object.keys(o.params).length > 0) parts.push(`params=${stableJson(o.params)}`);
  if (o.appliesWhen) parts.push(`when=${stableJson(o.appliesWhen)}`);
  return parts.join(":");
}

/** JSON with object keys sorted at every depth, so two equal declarations that
 *  differ only in key order fingerprint identically. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/** One entity as describe publishes it, for {@link schemaFingerprint}.
 *
 *  `module` is required, not optional: every entity belongs to exactly one, and
 *  a fingerprint that could omit it would let an entity move between modules
 *  without invalidating the caches that still place it in the old one. */
export interface EntityPrint {
  fields: NormalizedField[];
  module: string;
  auth?: boolean;
}

/** The operation attributes describe publishes, for {@link schemaFingerprint}. */
export interface OperationPrint {
  name: string;
  destructive?: boolean;
  readOnly?: boolean;
  idempotent?: boolean;
  /** required for the same reason as EntityPrint.module */
  module: string;
  entity?: string;
  params?: Record<string, unknown>;
  appliesWhen?: unknown;
}
