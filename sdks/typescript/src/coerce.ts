/**
 * Client-side coercion: relative dates → ISO 8601, relation labels → ids, plus
 * schema rendering and a cheap did-you-mean. Coercion is client convenience only
 * — the app's guard is the authority and rejects anything wrong.
 */
import { A2AppUnreachableError, type A2AppClient } from "./client.js";
import type { DescribeEntity, DescribeField, OperationDecl } from "./types.js";

export type FieldSchema = DescribeField & { name: string };

export interface EntitySchema {
  name: string;
  /** the module this entity lives in — the first segment of its describe path */
  module: string;
  label: string | null;
  auth: boolean;
  records: string;
  fields: FieldSchema[];
  /** the operations that act on this entity, with their typed signatures */
  operations: OperationDecl[];
}

export type Schema = Map<string, EntitySchema>;

/**
 * Where an entity lives, so a caller holding only its name can address it.
 *
 * Resolved by name search rather than by walking every module, so it costs one
 * request regardless of how many modules the app has. An exact name match wins
 * over a substring one: `find` matches loosely by design, and "cards" must not
 * resolve to "cards-archive" merely because that entity sorted first.
 */
export async function locateEntity(client: A2AppClient, entity: string): Promise<string | null> {
  const found = await client.find(entity);
  if (found === null) return null;
  const paths = found.matches
    .filter((m) => m.level === "entity" && m.operation === undefined)
    .map((m) => m.path);
  const exact = paths.find((p) => p.slice(p.indexOf("/") + 1) === entity);
  const chosen = exact ?? null;
  return chosen === null ? null : chosen.slice(0, chosen.indexOf("/"));
}

/**
 * Read ONE entity's model, by name, into the shape the coercion helpers use.
 *
 * Two requests: locate the entity, then describe it. This is deliberately not a
 * whole-app fetch — there is no endpoint that returns one, and the point of the
 * navigational surface is that a task touching two entities pays for two, not
 * for the app. Callers that repeat this across a session should cache against
 * the app's `schemaVersion` (A2APP-SPEC 2), which is what makes the ≤2
 * round-trip write budget reachable.
 *
 * The returned entity carries EVERY readable field, not a summary. That is
 * load-bearing: {@link nonReadableFields} treats a field absent from the model
 * as write-only and exempts it from the read-back check, so a partial model here
 * would silently disable the write-completeness backstop rather than fail loudly.
 */
export async function fetchEntitySchema(client: A2AppClient, entity: string): Promise<EntitySchema | null> {
  const module = await locateEntity(client, entity);
  if (module === null) return null;
  const level = await client.describeEntity(module, entity);
  if (level === null) return null;
  return entityToSchema(entity, module, level);
}

/** Every entity name the app has, with the module each lives in. One request. */
export async function fetchEntityIndex(client: A2AppClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const root = await client.describeRoot();
  if (root === null) return out;
  for (const m of root.modules) {
    if (m.access === "none" || m.entities === 0) continue;
    const level = await client.describe(m.name, { all: true });
    if (level?.level !== "module") continue;
    for (const e of level.entities) out.set(e.name, m.name);
  }
  return out;
}

export function entityToSchema(name: string, module: string, entity: DescribeEntity): EntitySchema {
  return {
    name,
    module,
    label: entity.label,
    auth: entity.auth === true,
    records: entity.records,
    fields: Object.entries(entity.fields ?? {}).map(([fieldName, spec]) => ({
      name: fieldName,
      ...spec,
    })),
    operations: entity.operations ?? [],
  };
}

/**
 * One entity's writable fields on a line, for `data <entity> schema` and errors.
 *
 * Enum values are shown inline. They are the single most common reason a write
 * is rejected, and an agent that has to guess them spends a round trip finding
 * out — which is the budget this surface exists to protect.
 */
export function renderEntity(entity: EntitySchema): string {
  const fields = entity.fields
    .filter((f) => !f.readOnly)
    .map((f) => {
      const type =
        f.entity !== undefined
          ? `->${f.entity}`
          : f.values !== undefined && f.values.length > 0
            ? `enum:${f.values.join("|")}`
            : f.type;
      return `${f.name}(${type}${f.required === true ? "*" : ""})`;
    })
    .join(" ");
  return `  ${entity.name}: ${fields}`;
}

/** Entity names by module, for `data schema`. Names only — field detail is one
 *  level in, which is what keeps this bounded however large the app grows. */
export function renderEntityIndex(index: Map<string, string>): string {
  const byModule = new Map<string, string[]>();
  for (const [entity, module] of index) {
    const list = byModule.get(module) ?? [];
    list.push(entity);
    byModule.set(module, list);
  }
  return [...byModule]
    .map(([module, entities]) => `  ${module}: ${entities.sort().join(" ")}`)
    .join("\n");
}

/** Cheap did-you-mean (Levenshtein under a small threshold). */
export function suggest(input: string, candidates: string[]): string | null {
  const distance = (a: string, b: string): number => {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let last = prev[0]!;
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j]!;
        prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
        last = tmp;
      }
    }
    return prev[b.length]!;
  };
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const d = distance(input.toLowerCase(), candidate.toLowerCase());
    if (d < bestScore) [best, bestScore] = [candidate, d];
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Local calendar date in the host timezone, as YYYY-MM-DD. Deliberately NOT
 *  toISOString(), which is UTC and shifts the day near midnight — the exact bug
 *  class this whole effort removes. */
function localYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Natural or absolute date → an ISO 8601 datetime, or null if unparseable. */
export function parseDate(value: string, now = new Date()): string | null {
  const s = value.trim().toLowerCase();
  if (s === "") return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return value.trim();
  const shift = (days: number): string => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    // ISO 8601 uses a 'T' between date and time; a space is a common-but-illegal
    // variant that strict backends (and JSON Schema date-time) reject.
    return `${localYmd(d)}T00:00:00.000Z`;
  };
  if (s === "today" || s === "now") return shift(0);
  if (s === "tomorrow") return shift(1);
  if (s === "yesterday") return shift(-1);
  let m = /^(?:in )?([+-]?\d+) ?(d|day|days|w|week|weeks|m|month|months)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    return shift(unit.startsWith("w") ? n * 7 : unit.startsWith("m") ? n * 30 : n);
  }
  m = /^(?:next |this |on )?([a-z]+)$/.exec(s);
  if (m) {
    const word = m[1]!;
    if (word === "week") return shift(7);
    if (word === "month") return shift(30);
    const target = DAYS.indexOf(word);
    if (target >= 0) return shift(((target - now.getDay() + 7) % 7) || 7);
  }
  return null;
}

function isDayKey(field: FieldSchema): boolean {
  return field.type === "string" && field.format === "YYYY-MM-DD";
}

/** Escape a value for interpolation into a `field="value"` filter predicate.
 *  Backslash MUST be escaped first, then the quote — otherwise a value ending in
 *  a backslash (`foo\`) escapes the closing quote and breaks (or injects into)
 *  the predicate. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * "To Do" → a record id via a filtered read on the label field. Ambiguity is an
 * error listing the candidates, never a guess: no shipped relation label carries
 * a unique index, so a multi-match is the normal case.
 */
export async function resolveRef(
  client: A2AppClient,
  schema: Schema,
  targetName: string,
  value: string,
): Promise<{ id?: string; error?: string }> {
  // Definitive, stack-agnostic id check: if a record with this exact id already
  // exists, the value IS an id — use it as-is (works for any backend's id
  // format, not just one). Only if no such record exists do we treat it as a
  // human label to resolve.
  try {
    const direct = await client.getRecord(targetName, value);
    if (direct.ok) return { id: value };
  } catch (err) {
    // A genuinely unreachable app must surface, not be mistaken for "not an id" —
    // otherwise we fall through to a label lookup that will also fail, and the
    // caller sees a wrong "no such label" instead of "app is down".
    if (err instanceof A2AppUnreachableError) throw err;
    /* otherwise fall through to label resolution */
  }
  const target = schema.get(targetName);
  if (target === undefined || target.label === null) return { id: value };
  const label = target.label;
  const filter = `${label}="${escapeFilterValue(value)}"`;
  const res = await client.listRecords(targetName, { filter, perPage: 10 });
  if (!res.ok) return { id: value };
  const items = ((res.json as { items?: Record<string, unknown>[] })?.items) ?? [];
  if (items.length === 1) return { id: String(items[0]!["id"]) };
  if (items.length === 0) {
    const all = await client.listRecords(targetName, { perPage: 25 });
    const names = (((all.json as { items?: Record<string, unknown>[] })?.items) ?? [])
      .map((r) => String(r[label] ?? ""))
      .filter(Boolean);
    return {
      error: `no ${targetName} with ${label}="${value}"${names.length ? ` — existing: ${names.join(", ")}` : ""}`,
    };
  }
  return {
    error: `"${value}" matches ${items.length} ${targetName} records — pass an id instead: ${items
      .map((r) => String(r["id"]))
      .join(", ")}`,
  };
}

/** Coerce a write body: human dates → ISO, relation labels → ids. Unknown
 *  fields and bad values are left alone — the app rejects those, and it must,
 *  because it is the only layer every caller goes through. */
export async function coerceBody(
  client: A2AppClient,
  schema: Schema,
  entityName: string,
  body: Record<string, unknown>,
): Promise<{ body: Record<string, unknown>; errors: string[] }> {
  const entity = schema.get(entityName);
  if (entity === undefined) return { body, errors: [] };
  const byName = new Map(entity.fields.map((f) => [f.name, f]));
  const out = { ...body };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const field = byName.get(key);
    if (field === undefined) continue;

    // list<ref>: an array (or single) of labels/ids — resolve each element the
    // same way a scalar ref is resolved, so a multi-relation write accepts labels.
    if (field.type === "list<ref>" && field.entity !== undefined) {
      const elements = Array.isArray(value) ? value : value === "" ? [] : [value];
      const resolvedIds: unknown[] = [];
      for (const el of elements) {
        if (typeof el !== "string" || el === "") {
          resolvedIds.push(el);
          continue;
        }
        const resolved = await resolveRef(client, schema, field.entity, el);
        if (resolved.error !== undefined) errors.push(`--${key}: ${resolved.error}`);
        else if (resolved.id !== undefined) resolvedIds.push(resolved.id);
        else resolvedIds.push(el);
      }
      if (Array.isArray(value)) out[key] = resolvedIds;
      continue;
    }

    if (typeof value !== "string" || value === "") continue;
    if (field.type === "datetime" || isDayKey(field)) {
      const parsed = parseDate(value);
      if (parsed === null) {
        errors.push(`--${key} "${value}" is not a date. Try an ISO date, or today/tomorrow/in 3 days/next monday.`);
      } else {
        out[key] = isDayKey(field) ? parsed.slice(0, 10) : parsed;
      }
      continue;
    }
    if (field.type === "ref" && field.entity !== undefined) {
      const resolved = await resolveRef(client, schema, field.entity, value);
      if (resolved.error !== undefined) errors.push(`--${key}: ${resolved.error}`);
      else if (resolved.id !== undefined) out[key] = resolved.id;
    }
  }
  return { body: out, errors };
}

/**
 * Fallback read-back for apps whose adapter predates the in-app write guard:
 * which non-blank requested values are missing in what came back?
 *
 * `exempt` names fields that are legitimately never echoed — a write-only field
 * (e.g. a password) or any field the describe omits from its readable set. A
 * write-only field is SENT by the client and, by design, NEVER returned by the
 * backend, so without this exemption every password write would be flagged
 * "WRITE INCOMPLETE". Pass the entity's write-only / non-readable field names.
 */
export function droppedFields(
  sent: Record<string, unknown>,
  saved: Record<string, unknown>,
  exempt?: Iterable<string>,
): string[] {
  const skip = exempt ? new Set(exempt) : null;
  const out: string[] = [];
  for (const [key, value] of Object.entries(sent)) {
    if (value === "" || value === null || value === undefined) continue;
    if (skip?.has(key)) continue;
    const stored = saved[key];
    if (stored === undefined || stored === "" || stored === null) out.push(key);
  }
  return out;
}

/** The set of a described entity's write-only / non-readable field names — the
 *  fields a read-back must NOT expect to see. A field the describe does not list
 *  as readable (write-only fields are omitted from describe) is exempt from the
 *  {@link droppedFields} backstop. */
export function nonReadableFields(entity: EntitySchema | undefined, sent: Record<string, unknown>): Set<string> {
  const readable = new Set((entity?.fields ?? []).map((f) => f.name));
  const out = new Set<string>();
  if (entity === undefined) return out;
  for (const key of Object.keys(sent)) {
    if (!readable.has(key)) out.add(key);
  }
  return out;
}
