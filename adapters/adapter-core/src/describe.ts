/**
 * Navigational describe (A2APP-SPEC 3): the app's self-description, answered one
 * level at a time.
 *
 * Six levels — root, module, entity, record, relation, find — each generated
 * from the live model on every request, each carrying the legal moves from
 * where it landed, and each bounded by the per-response budget. Nothing here
 * caches, and no level is hand-written; a level that disagreed with another
 * would be a drift bug of exactly the kind describe exists to prevent.
 *
 * Two rules shape the whole file:
 *
 * - **Detail is deferred, existence is not.** A level always says what is here;
 *   it withholds only the detail of things the caller has not opened. Names are
 *   cheap (a dozen characters), schemas are not (hundreds), and that asymmetry
 *   is the entire reason this scales where one flat document does not.
 * - **Nothing is omitted silently.** Where a list is trimmed to fit the budget,
 *   the response reports how many entries it dropped. A silent truncation is
 *   indistinguishable from a complete answer, which is worse than being long.
 */
import {
  DESCRIBE_BUDGET_CHARS,
  evaluatePredicate,
  explainPredicate,
  indexFields,
  labelFieldOf,
  predicateFields,
  type NormalizedField,
} from "@a2app/rules";
import type { Binding, EntityDef, ModuleDecl, OperationDecl, StoredRecord } from "./types.js";

/* ------------------------------------------------------------------ access */

/**
 * What the calling credential may do. Resolved by the served surface from the
 * caller's grant, so a level can render access without re-deriving the scope
 * model — and so the root screen can tell an agent where it may not go before
 * it spends turns collecting refusals.
 */
export interface Access {
  canRead(entity: string): boolean;
  canWrite(entity: string): boolean;
  canRun(operation: string): boolean;
}

/** Unrestricted access, for callers the scope model exempts (the app's own UI,
 *  and anonymous reads on a single-user app). */
export const FULL_ACCESS: Access = {
  canRead: () => true,
  canWrite: () => true,
  canRun: () => true,
};

/** No access at all — an uncredentialled caller on a multi-user app. The root
 *  level still names every module, so such a caller learns the app's shape and
 *  that it needs a credential, rather than seeing an app that looks empty. */
export const NO_ACCESS: Access = {
  canRead: () => false,
  canWrite: () => false,
  canRun: () => false,
};

/* -------------------------------------------------------------------- deps */

export interface DescribeDeps {
  binding: Binding;
  operations: readonly OperationDecl[];
  modules: readonly ModuleDecl[];
  conventions(): Record<string, unknown>;
}

/** Every level carries this. */
type Level = Record<string, unknown> & { level: string; next: string[] };

/* ----------------------------------------------------------------- budget */

/** Serialized size of a level, in the same units the budget is stated in. */
export function levelSize(level: unknown): number {
  return JSON.stringify(level).length;
}

/**
 * Trim a list until the level fits, reporting what was dropped.
 *
 * Entries are dropped from the end so the order an app declared — which is
 * editorial, the most-used first — decides what survives. Binary search rather
 * than one-at-a-time because a large module would otherwise re-serialize
 * hundreds of times per request.
 */
function fitList<T>(
  build: (items: T[], truncated: number) => Level,
  items: readonly T[],
  budget: number,
): Level {
  const whole = build([...items], 0);
  if (levelSize(whole) <= budget) return whole;

  // Largest prefix that fits. `lo` is always known-good (the empty list plus a
  // truncation count is the floor, and it is tiny).
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (levelSize(build(items.slice(0, mid), items.length - mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return build(items.slice(0, lo), items.length - lo);
}

/* ------------------------------------------------------------------ fields */

/** One field as the wire publishes it. Write-only fields never reach here. */
function fieldDoc(f: NormalizedField): Record<string, unknown> {
  const field: Record<string, unknown> = { type: f.type };
  if (f.required) field.required = true;
  if (f.readOnly) field.readOnly = true;
  if (f.max !== undefined) field.max = f.max;
  if (f.values) field.values = f.values;
  if (f.entity) field.entity = f.entity;
  if (f.dayKey) field.format = "YYYY-MM-DD";
  return field;
}

/** The fields an entity advertises: everything except write-only.
 *
 *  This is load-bearing beyond describe. A client treats a field absent from
 *  describe as write-only and exempts it from the read-back check, so anything
 *  dropped here quietly disables that backstop. Only `writeOnly` may be dropped,
 *  and only because it is genuinely never readable. */
function readableFields(def: EntityDef): NormalizedField[] {
  return def.fields.filter((f) => !f.writeOnly);
}

/* -------------------------------------------------------------- operations */

function operationDoc(o: OperationDecl): Record<string, unknown> {
  const decl: Record<string, unknown> = { name: o.name, destructive: o.destructive, params: o.params };
  if (o.description) decl.description = o.description;
  if (o.readOnly) decl.readOnly = true;
  if (o.idempotent) decl.idempotent = true;
  if (o.entity) decl.entity = o.entity;
  return decl;
}

/** Operations attached to one entity, that this caller may invoke. */
function entityOperations(deps: DescribeDeps, entity: string, access: Access): OperationDecl[] {
  return deps.operations.filter((o) => o.entity === entity && access.canRun(o.name));
}

/** Operations that belong to a module but no entity — the module's own screen. */
function moduleOperations(deps: DescribeDeps, module: string, access: Access): OperationDecl[] {
  return deps.operations.filter((o) => o.module === module && o.entity === undefined && access.canRun(o.name));
}

/* ----------------------------------------------------------------- indexes */

/** Entities of one module, in declaration order. */
function entitiesOfModule(entities: Record<string, EntityDef>, module: string): [string, EntityDef][] {
  return Object.entries(entities).filter(([, def]) => def.module === module);
}

/* -------------------------------------------------------------------- root */

/**
 * The app's home screen: what modules exist, how big each is, and whether the
 * caller can reach it.
 *
 * O(modules), never O(entities) — that is what makes the cost of arriving at an
 * app independent of the app's size. A module the caller cannot reach is still
 * named: its existence is not a secret, only its contents, and hiding it would
 * leave an agent unable to explain why it cannot do what it was asked.
 */
export function buildRoot(
  deps: DescribeDeps,
  access: Access,
  opts: { all?: boolean; budget?: number } = {},
): Level {
  const budget = opts.budget ?? DESCRIBE_BUDGET_CHARS;
  const entities = deps.binding.entities();
  const modules = deps.modules.map((m) => {
    const owned = entitiesOfModule(entities, m.name);
    const ops = deps.operations.filter((o) => o.module === m.name);
    const readable = owned.filter(([name]) => access.canRead(name)).length;
    const writable = owned.filter(([name]) => access.canWrite(name)).length;
    const runnable = ops.filter((o) => access.canRun(o.name)).length;

    // An ops-only module (an adopted foreign app has no entities at all) is
    // reachable when any of its operations is.
    const reach =
      owned.length === 0
        ? runnable === 0
          ? "none"
          : "full"
        : readable === 0 && runnable === 0
          ? "none"
          : writable === owned.length && runnable === ops.length
            ? "full"
            : "read-only";

    const row: Record<string, unknown> = {
      name: m.name,
      entities: owned.length,
      operations: ops.length,
      access: reach,
    };
    if (m.summary) row.summary = m.summary;
    return row;
  });

  const build = (rows: Record<string, unknown>[], truncated: number, summaries: boolean): Level => {
    const level: Level = {
      level: "root",
      app: { id: deps.binding.appId, name: deps.binding.appName },
      modules: summaries ? rows : rows.map(({ summary, ...rest }) => (void summary, rest)),
      conventions: deps.conventions(),
      next: truncated > 0 ? [...ROOT_NEXT, "describe?all=true"] : ROOT_NEXT,
    };
    if (truncated > 0) level.truncated = truncated;
    return level;
  };

  if (opts.all === true) return build(modules, 0, true);

  const whole = build(modules, 0, true);
  if (levelSize(whole) <= budget) return whole;

  // Shed DETAIL before shedding EXISTENCE. A module's one-line summary is prose;
  // its name, counts, and access are what make it reachable and plannable. An app
  // wide enough to overflow its own root is exactly the app where knowing that a
  // module exists matters most, so the summaries go first and every module stays
  // named. Only if the bare names still do not fit are rows dropped — and then
  // the count is reported and `?all=true` returns them, because a root that
  // silently omitted a branch would leave a whole part of the app unreachable
  // with nothing to indicate it was there.
  const withoutSummaries = build(modules, 0, false);
  if (levelSize(withoutSummaries) <= budget) return withoutSummaries;

  return fitList((rows, truncated) => build(rows, truncated, false), modules, budget);
}

const ROOT_NEXT = ["describe/{module}", "describe?find={term}"];

/* ------------------------------------------------------------------ module */

/** A module's contents by name and one-line summary, never by schema. */
export function buildModule(
  deps: DescribeDeps,
  module: ModuleDecl,
  access: Access,
  opts: { all?: boolean; budget?: number } = {},
): Level {
  const budget = opts.budget ?? DESCRIBE_BUDGET_CHARS;
  const entities = deps.binding.entities();
  const owned = entitiesOfModule(entities, module.name)
    .filter(([name]) => access.canRead(name))
    .map(([name, def]) => {
      const row: Record<string, unknown> = { name };
      if (def.summary) row.summary = def.summary;
      return row;
    });
  const ops = moduleOperations(deps, module.name, access).map((o) => {
    const row: Record<string, unknown> = { name: o.name, destructive: o.destructive };
    if (o.description) row.summary = o.description;
    return row;
  });

  const next = [
    `describe/${module.name}/{entity}`,
    ...(ops.length > 0 ? [`${module.name} <operation> [--params]`] : []),
  ];

  const build = (entityRows: Record<string, unknown>[], truncated: number): Level => {
    const level: Level = {
      level: "module",
      path: module.name,
      entities: entityRows,
      operations: ops,
      next: truncated > 0 ? [...next, `describe/${module.name}?all=true`] : next,
    };
    if (module.summary) level.summary = module.summary;
    if (truncated > 0) level.truncated = truncated;
    return level;
  };

  // `?all=true` returns every name — still without schemas, so it stays far
  // cheaper than the flat document it replaces, and it is the escape hatch that
  // keeps truncation honest rather than lossy.
  if (opts.all) return build(owned, 0);
  return fitList(build, owned, budget);
}

/* ------------------------------------------------------------------ entity */

/** The first level carrying schemas — and it carries them for one entity. */
export function buildEntity(
  deps: DescribeDeps,
  module: string,
  entity: string,
  def: EntityDef,
  access: Access,
  opts: { all?: boolean; budget?: number } = {},
): Level {
  const budget = opts.budget ?? DESCRIBE_BUDGET_CHARS;
  const fields: Record<string, unknown> = {};
  for (const f of readableFields(def)) fields[f.name] = fieldDoc(f);

  const path = `${module}/${entity}`;
  const next = [`describe/${path}/{id}`, `data ${entity} list`];
  const ops = entityOperations(deps, entity, access).map(operationDoc);

  const build = (operations: Record<string, unknown>[], truncated: number): Level => {
    const level: Level = {
      level: "entity",
      path,
      label: labelFieldOf(def.fields),
      records: `/api/collections/${entity}/records`,
      fields,
      operations,
      next: truncated > 0 ? [...next, `describe/${path}?all=true`] : next,
    };
    if (def.auth) level.auth = true;
    if (truncated > 0) level.truncated = truncated;
    return level;
  };

  // FIELDS ARE NEVER TRIMMED. A client treats a field absent from describe as
  // write-only and exempts it from the read-back check, so dropping one here
  // would silently disable the write-completeness backstop rather than fail
  // loudly. Operations can be trimmed — they are also reachable from the module
  // screen and from search, and the count is always reported.
  if (opts.all === true) return build(ops, 0);
  return fitList(build, ops, budget);
}

/* ------------------------------------------------------------------ record */

/**
 * One record, and the operations available *given its current state*.
 *
 * A blocked operation is shown with the reason it is blocked, never hidden: an
 * agent that cannot see why an action is unavailable will retry it, or invent a
 * worse route to the same goal, and a hidden action is indistinguishable from
 * one that does not exist. The reason is derived from the declared predicate and
 * the stored values — deterministic, and identical on every stack.
 *
 * Field VALUES are never echoed here beyond the record's label. This level
 * answers "what can I do to this record", and the data API answers "what is in
 * it"; keeping that line means describe cannot become a second, unguarded read
 * path around the scope model.
 */
export function buildRecord(
  deps: DescribeDeps,
  module: string,
  entity: string,
  def: EntityDef,
  record: StoredRecord,
  access: Access,
): Level {
  const fields = readableFields(def);
  const index = indexFields(fields);
  const labelField = labelFieldOf(def.fields);
  const labelValue = labelField === null ? null : record[labelField];

  const operations = entityOperations(deps, entity, access).map((o) => {
    const row: Record<string, unknown> = { name: o.name, available: true };
    if (o.destructive) row.destructive = true;
    if (o.appliesWhen && !evaluatePredicate(o.appliesWhen, record, index)) {
      row.available = false;
      row.blocked = explainPredicate(o.appliesWhen, record, index);
    }
    return row;
  });

  // Sub-resources are the record's own `list<ref>` fields: a forward relation is
  // derivable from the type vocabulary alone, with no query grammar and no extra
  // read. A reverse relation would need a filtered scan of every other entity,
  // which the protocol deliberately does not standardise (the filter grammar is
  // the backend's own).
  const relations = fields
    .filter((f) => f.type === "list<ref>" && f.entity !== undefined)
    .map((f) => {
      const value = record[f.name];
      const row: Record<string, unknown> = { name: f.name, entity: f.entity };
      if (Array.isArray(value)) row.count = value.length;
      return row;
    });

  const path = `${module}/${entity}/${record.id}`;
  const invocable = operations.filter((o) => o.available === true);
  return {
    level: "record",
    path,
    id: record.id,
    // A non-string label (a number, say) is stringified so the screen can show
    // it. Absence is NOT: `null` and `undefined` both mean "this entity has no
    // label field", and String() would turn that into the literal text "null",
    // rendering a record that appears to be named null. The Python and
    // PocketBase ports already drew this line here; this is the outlier being
    // brought back to them, so all three stacks label a record identically.
    label:
      typeof labelValue === "string"
        ? labelValue
        : labelValue === null || labelValue === undefined
          ? null
          : String(labelValue),
    operations,
    ...(relations.length > 0 ? { relations } : {}),
    next: [
      ...relations.map((r) => `describe/${path}/${String(r.name)}`),
      ...invocable.map((o) => `${path} ${String(o.name)}`),
      `data ${entity} get ${record.id}`,
    ],
  };
}

/* ---------------------------------------------------------------- relation */

/** A record's sub-resource: the referenced rows, by id and label. */
export function buildRelation(
  module: string,
  entity: string,
  recordId: string,
  relation: string,
  target: string,
  rows: readonly { id: string; label: string | null }[],
  budget = DESCRIBE_BUDGET_CHARS,
): Level {
  const path = `${module}/${entity}/${recordId}/${relation}`;
  const build = (items: { id: string; label: string | null }[], truncated: number): Level => {
    const level: Level = {
      level: "relation",
      path,
      entity: target,
      items,
      next: [`data ${target} get {id}`, `describe/${module}/${entity}/${recordId}`],
    };
    if (truncated > 0) level.truncated = truncated;
    return level;
  };
  return fitList(build, rows, budget);
}

/* -------------------------------------------------------------------- find */

/**
 * Name search across every level, returning locations only.
 *
 * Required, not a convenience. Without it the walk is a linked list: an agent
 * that guesses the wrong branch has to climb back out, and that backtrack costs
 * more than the flat document this replaces. Search restores random access
 * without restoring the cost, because it returns paths and never schemas.
 */
export function buildFind(
  deps: DescribeDeps,
  term: string,
  access: Access,
  budget = DESCRIBE_BUDGET_CHARS,
): Level {
  const needle = term.toLowerCase();
  const entities = deps.binding.entities();
  const matches: Record<string, unknown>[] = [];

  for (const m of deps.modules) {
    if (m.name.toLowerCase().includes(needle)) matches.push({ path: m.name, level: "module" });
  }
  for (const [name, def] of Object.entries(entities)) {
    if (!access.canRead(name)) continue;
    if (name.toLowerCase().includes(needle)) matches.push({ path: `${def.module}/${name}`, level: "entity" });
  }
  for (const o of deps.operations) {
    if (!access.canRun(o.name) || !o.name.toLowerCase().includes(needle)) continue;
    matches.push({
      path: o.entity ? `${o.module}/${o.entity}` : o.module,
      operation: o.name,
    });
  }

  const build = (items: Record<string, unknown>[], truncated: number): Level => {
    const level: Level = {
      level: "find",
      term,
      matches: items,
      next: ["describe/{path}"],
    };
    if (truncated > 0) level.truncated = truncated;
    return level;
  };
  return fitList(build, matches, budget);
}

/* ------------------------------------------------------------- model check */

/**
 * Everything wrong with an app's module/operation declarations, one message per
 * problem. Empty means the app part is internally consistent.
 *
 * Run at adapter construction so a malformed model fails at boot rather than at
 * a request, and reused verbatim by the build gate — one implementation, so the
 * gate can never pass a model the adapter would refuse.
 */
export function modelProblems(deps: DescribeDeps): string[] {
  const problems: string[] = [];
  const declared = new Set(deps.modules.map((m) => m.name));
  const entities = deps.binding.entities();

  if (deps.modules.length === 0) {
    problems.push("no modules declared: every entity and operation belongs to one, and the root screen lists them");
  }
  const seen = new Set<string>();
  for (const m of deps.modules) {
    if (seen.has(m.name)) problems.push(`duplicate module "${m.name}"`);
    seen.add(m.name);
  }

  for (const [name, def] of Object.entries(entities)) {
    if (!def.module) problems.push(`entity "${name}" declares no module`);
    else if (!declared.has(def.module)) problems.push(`entity "${name}" names undeclared module "${def.module}"`);
  }

  for (const o of deps.operations) {
    if (!o.module) problems.push(`operation "${o.name}" declares no module`);
    else if (!declared.has(o.module)) problems.push(`operation "${o.name}" names undeclared module "${o.module}"`);

    if (o.params === undefined || o.params === null || typeof o.params !== "object") {
      problems.push(`operation "${o.name}" declares no typed params (declare {} if it takes none)`);
    }
    if (o.entity !== undefined) {
      const def = entities[o.entity];
      if (!def) {
        problems.push(`operation "${o.name}" acts on unknown entity "${o.entity}"`);
      } else {
        if (def.module !== o.module) {
          problems.push(
            `operation "${o.name}" is in module "${o.module}" but acts on entity "${o.entity}" in module "${def.module}"`,
          );
        }
        if (o.appliesWhen) {
          const names = new Set(def.fields.map((f) => f.name));
          for (const referenced of predicateFields(o.appliesWhen)) {
            if (!names.has(referenced)) {
              problems.push(`operation "${o.name}" appliesWhen reads "${referenced}", not a field of "${o.entity}"`);
            }
          }
        }
      }
    } else if (o.appliesWhen) {
      problems.push(`operation "${o.name}" declares appliesWhen but no entity: there is no record to evaluate it against`);
    }
  }
  return problems;
}
