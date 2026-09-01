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
  NOT_STORED: "not_stored",
  DUPLICATE_REQUEST: "duplicate_request",
  APPROVAL_REQUIRED: "approval_required",
  INSUFFICIENT_SCOPE: "insufficient_scope",
  AMBIGUOUS_REF: "ambiguous_ref",
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

function fieldMap(fields: NormalizedField[]): Record<string, NormalizedField> {
  const m: Record<string, NormalizedField> = {};
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

  for (const key of Object.keys(body)) {
    if (allow[key]) continue;

    const field = map[key];

    // Unknown fields are silently dropped by most backends and absent from the
    // response, so the caller cannot tell they were ignored.
    if (!field) {
      out.push(violation(ERROR_CODES.UNKNOWN_FIELD, key, "one of: " + writable.join(", "), body[key]));
      continue;
    }
    if (field.readOnly) {
      out.push(violation(ERROR_CODES.READ_ONLY_FIELD, key, "not writable (server-managed)", body[key]));
      continue;
    }

    const value = body[key];
    // Blank means "clear this field" — a legitimate operation, only
    // distinguishable from garbage because we see the raw value.
    if (isBlank(value)) continue;

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
      const items = Array.isArray(value) ? value : [value];
      const bad = items.find((item) => !field.values!.some((v) => String(v) === String(item)));
      if (bad !== undefined) {
        out.push(violation(ERROR_CODES.INVALID_ENUM, key, "each of: " + field.values.join(" | "), value));
        continue;
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
    if (!field || field.readOnly) continue;
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

/**
 * A stable fingerprint of a data model, so clients can cache describe against
 * it and re-fetch when it changes. Pure and deterministic: same entities in,
 * same `sv_…` out, regardless of ordering. djb2 over a canonicalised
 * `entity(field:type,…)` rendering.
 */
export function schemaFingerprint(entities: Record<string, NormalizedField[]>): string {
  const parts: string[] = [];
  for (const [name, fields] of Object.entries(entities)) {
    const names = fields.map((f) => `${f.name}:${f.type}`).sort();
    parts.push(`${name}(${names.join(",")})`);
  }
  parts.sort();
  const joined = parts.join(";");
  let h = 5381;
  for (let k = 0; k < joined.length; k++) h = ((h * 33) ^ joined.charCodeAt(k)) >>> 0;
  return "sv_" + h.toString(16);
}
