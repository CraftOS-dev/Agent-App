/**
 * Client-side coercion: relative dates → ISO 8601, relation labels → ids, plus
 * schema rendering and a cheap did-you-mean. Coercion is client convenience only
 * — the app's guard is the authority and rejects anything wrong.
 */
import type { A2AppClient } from "./client.js";
import type { Describe, DescribeEntity, DescribeField } from "./types.js";

export type FieldSchema = DescribeField & { name: string };

export interface EntitySchema {
  name: string;
  label: string | null;
  auth: boolean;
  records: string;
  fields: FieldSchema[];
}

export type Schema = Map<string, EntitySchema>;

/** Read the app's data model from the A2App surface into a convenient map. */
export async function fetchSchema(client: A2AppClient): Promise<Schema> {
  const out: Schema = new Map();
  const described = await client.describe();
  if (described === null) return out;
  for (const [name, entity] of Object.entries(described.entities ?? {})) {
    out.set(name, entityToSchema(name, entity));
  }
  return out;
}

export function describeToSchema(described: Describe): Schema {
  const out: Schema = new Map();
  for (const [name, entity] of Object.entries(described.entities ?? {})) {
    out.set(name, entityToSchema(name, entity));
  }
  return out;
}

function entityToSchema(name: string, entity: DescribeEntity): EntitySchema {
  return {
    name,
    label: entity.label,
    auth: entity.auth === true,
    records: entity.records,
    fields: Object.entries(entity.fields ?? {}).map(([fieldName, spec]) => ({
      name: fieldName,
      ...spec,
    })),
  };
}

/** Compact one-line-per-entity rendering, for `data <dir> schema` and errors. */
export function renderSchema(schema: Schema): string {
  const lines: string[] = [];
  for (const [name, entity] of schema) {
    const fields = entity.fields
      .filter((f) => !f.readOnly)
      .map((f) => {
        const type = f.entity !== undefined ? `->${f.entity}` : f.type;
        return `${f.name}(${type}${f.required === true ? "*" : ""})`;
      })
      .join(" ");
    lines.push(`  ${name}: ${fields}`);
  }
  return lines.join("\n");
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
    return `${localYmd(d)} 00:00:00.000Z`;
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
  if (/^[a-z0-9]{15}$/.test(value)) return { id: value };
  const target = schema.get(targetName);
  if (target === undefined || target.label === null) return { id: value };
  const label = target.label;
  const filter = `${label}="${value.replace(/"/g, '\\"')}"`;
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
    if (field === undefined || typeof value !== "string" || value === "") continue;
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

/** Fallback read-back for apps whose adapter predates the in-app write guard:
 *  which non-blank requested values are missing in what came back? */
export function droppedFields(sent: Record<string, unknown>, saved: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(sent)) {
    if (value === "" || value === null || value === undefined) continue;
    const stored = saved[key];
    if (stored === undefined || stored === "" || stored === null) out.push(key);
  }
  return out;
}
