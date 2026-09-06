/**
 * An in-memory {@link Binding} — the simplest possible back face. It stores
 * records in a Map, maps its declared fields straight onto protocol types, and
 * runs operations from a supplied table. It is a conforming A2App backend on its
 * own, used by the adapter-starter, the conformance harness, and tests.
 *
 * A real adapter (SQLite, PocketBase, Django, …) replaces this file only; the
 * served surface (server.ts) and the rules are shared verbatim.
 */
import { randomBytes } from "node:crypto";
import { UnsupportedFilterError } from "./types.js";
import type {
  Binding,
  CallContext,
  ContextResult,
  EntityDef,
  ListQuery,
  ListResult,
  StoredRecord,
} from "./types.js";
import type { NormalizedField } from "@a2app/rules";

export interface MemoryEntitySpec {
  fields: NormalizedField[];
  /** the declared module this entity lives in (A2APP-SPEC 3) */
  module: string;
  /** one line, shown beside the entity's name on its module screen */
  summary?: string;
  auth?: boolean;
  writeAllow?: string[];
  /** seed records */
  seed?: Record<string, unknown>[];
}

export type OperationRunner = (
  args: Record<string, unknown>,
  ctx: CallContext,
) => Promise<unknown> | unknown;

export interface MemoryBindingOptions {
  appId: string;
  appName?: string | null;
  adapterVersion?: string;
  authMode?: "none" | "multi-user";
  entities: Record<string, MemoryEntitySpec>;
  operations?: Record<string, OperationRunner>;
  context?: () => ContextResult;
}

export class MemoryBinding implements Binding {
  readonly appId: string;
  readonly appName: string | null;
  readonly adapterVersion: string;
  readonly authMode: "none" | "multi-user";
  private readonly specs: Record<string, MemoryEntitySpec>;
  private readonly rows: Record<string, Map<string, StoredRecord>> = {};
  private readonly ops: Record<string, OperationRunner>;
  private readonly ctxFn: (() => ContextResult) | undefined;

  constructor(opts: MemoryBindingOptions) {
    this.appId = opts.appId;
    this.appName = opts.appName ?? null;
    this.adapterVersion = opts.adapterVersion ?? "0.1.0";
    this.authMode = opts.authMode ?? "none";
    this.specs = opts.entities;
    this.ops = opts.operations ?? {};
    this.ctxFn = opts.context;
    for (const [name, spec] of Object.entries(opts.entities)) {
      const map = new Map<string, StoredRecord>();
      for (const seed of spec.seed ?? []) {
        const rec = this.materialize(spec, seed);
        map.set(rec.id, rec);
      }
      this.rows[name] = map;
    }
  }

  private materialize(spec: MemoryEntitySpec, body: Record<string, unknown>): StoredRecord {
    const id = typeof body.id === "string" && body.id ? body.id : "rec_" + randomBytes(8).toString("hex");
    const rec: StoredRecord = { id };
    for (const f of spec.fields) {
      if (f.name in body && body[f.name] !== undefined) rec[f.name] = coerce(f, body[f.name]);
      else if (f.readOnly && f.name === "created") rec[f.name] = new Date().toISOString();
    }
    return rec;
  }

  entities(): Record<string, EntityDef> {
    const out: Record<string, EntityDef> = {};
    for (const [name, spec] of Object.entries(this.specs)) {
      out[name] = {
        fields: spec.fields,
        module: spec.module,
        ...(spec.summary ? { summary: spec.summary } : {}),
        ...(spec.auth ? { auth: true } : {}),
        ...(spec.writeAllow ? { writeAllow: spec.writeAllow } : {}),
      };
    }
    return out;
  }

  listRecords(entity: string, query: ListQuery): ListResult {
    const map = this.rows[entity];
    if (!map) return { items: [] };
    let items = [...map.values()];
    if (query.filter) items = items.filter(matchFilter(query.filter));
    if (query.sort) {
      const desc = query.sort.startsWith("-");
      const key = desc ? query.sort.slice(1) : query.sort;
      items.sort((a, b) => cmp(a[key], b[key]) * (desc ? -1 : 1));
    }
    const perPage = query.perPage ?? items.length;
    const page = query.page ?? 1;
    const start = (page - 1) * perPage;
    return {
      items: items.slice(start, start + perPage),
      page,
      perPage,
      totalItems: items.length,
    };
  }

  getRecord(entity: string, id: string): StoredRecord | null {
    return this.rows[entity]?.get(id) ?? null;
  }

  createRecord(entity: string, body: Record<string, unknown>): StoredRecord {
    const spec = this.specs[entity]!;
    const rec = this.materialize(spec, body);
    this.rows[entity]!.set(rec.id, rec);
    return rec;
  }

  updateRecord(entity: string, id: string, body: Record<string, unknown>): StoredRecord | null {
    const map = this.rows[entity];
    const existing = map?.get(id);
    if (!map || !existing) return null;
    const spec = this.specs[entity]!;
    for (const f of spec.fields) {
      if (f.readOnly) continue;
      if (f.name in body) {
        const v = body[f.name];
        if (v === null || v === "") delete existing[f.name];
        else existing[f.name] = coerce(f, v);
      }
    }
    map.set(id, existing);
    return existing;
  }

  deleteRecord(entity: string, id: string): boolean {
    return this.rows[entity]?.delete(id) ?? false;
  }

  runOperation(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<unknown> | unknown {
    const runner = this.ops[name];
    if (!runner) throw new Error(`no runner for operation "${name}"`);
    return runner(args, ctx);
  }

  context(): ContextResult {
    return this.ctxFn ? this.ctxFn() : { view: null, selected: [] };
  }
}

/** Coerce a validated raw value into its stored form (booleans/numbers from
 *  strings). The guard already accepted it; this only normalizes the type. */
function coerce(field: NormalizedField, value: unknown): unknown {
  if (value === null || value === "") return value;
  if (field.type === "number" && typeof value === "string") return Number(value);
  if (field.type === "boolean" && typeof value === "string") return value === "true";
  return value;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return String(a) < String(b) ? -1 : 1;
}

/**
 * The single-clause grammar this binding implements: `field = "value"`,
 * `field != "value"`, or `field ~ "value"` (contains), optionally wrapped in one
 * pair of parentheses. The value may be double-quoted (with `\` escapes),
 * single-quoted, or a bare token containing no whitespace or quotes.
 *
 * The A2App filter grammar is the backend's own; this is the floor every adapter
 * must implement (section 4.2). Anything outside it is REFUSED, never ignored:
 * an adapter that accepts `filter` and returns unfiltered rows turns every label
 * lookup into a false multi-match and makes relation writes impossible, and it
 * does so silently, because the caller got a 200.
 */
const FILTER_CLAUSE =
  /^\s*\(?\s*([A-Za-z_]\w*)\s*(=|!=|~)\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'()]+))\s*\)?\s*$/;

function matchFilter(expr: string): (r: StoredRecord) => boolean {
  const m = FILTER_CLAUSE.exec(expr);
  if (!m) throw new UnsupportedFilterError(expr);
  const field = m[1]!;
  const op = m[2]!;
  // Only the double-quoted form carries escapes; unescape exactly what the
  // escaping side wrote (`\x` -> `x`), so a value ending in a backslash or
  // containing a quote round-trips.
  const val = m[3] !== undefined ? m[3].replace(/\\(.)/g, "$1") : (m[4] ?? m[5] ?? "");
  return (r) => {
    const cur = r[field];
    const s = cur === undefined || cur === null ? "" : String(cur);
    if (op === "=") return s === val;
    if (op === "!=") return s !== val;
    return s.includes(val);
  };
}
