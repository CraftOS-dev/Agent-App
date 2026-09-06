/// <reference path="../pb_data/types.d.ts" />
/**
 * A2App adapter as PocketBase JS hooks (SYSTEM-OWNED — hash-locked in the
 * ownership canon).
 *
 * PocketBase already serves records natively at /api/collections/{c}/records.
 * This hook file adds the A2App control surface — identity, describe, whoami —
 * and a GUARD that validates the RAW request body before PocketBase coerces it.
 * The guard shares the pure rules in `_a2app_rules.js` VERBATIM, so this app
 * rejects payloads identically to every other A2App backend (verified by the
 * conformance suite).
 *
 * PocketBase runs each hook handler in its own pooled Goja runtime, so a handler
 * CANNOT close over variables declared at file scope. Every handler therefore
 * `require()`s its modules locally; the small `mapFields`/`readEntities` helpers
 * are duplicated inline for the same reason (kept tiny and identical).
 *
 * Runtime: PocketBase JSVM (Goja). `node --check` validates syntax in the gate;
 * the file only executes inside `pocketbase serve`.
 */

const A2APP = {
  ADAPTER_VERSION: "0.1.0",
  PROTOCOL_VERSION: "0.1",
};

/* --------------------------------------------------------------- identity */

routerAdd("GET", "/api/_a2app", (c) => {
  const rules = require(`${__hooks}/_a2app_rules.js`);

  // Map the live PocketBase collections onto protocol-typed fields. Reading the
  // live schema is why describe/schemaVersion can never drift.
  //
  // The module each collection belongs to comes from `manifest.modules[].entities`
  // (PocketBase collections cannot carry one), and it is part of the fingerprint:
  // moving an entity between modules changes what describe publishes, so a client
  // caching against schemaVersion has to be told.
  const entityModule = {};
  try {
    const mods = JSON.parse($os.readFile(`${__hooks}/../../manifest.json`)).modules || [];
    for (let i = 0; i < mods.length; i++) {
      const owned = mods[i].entities || [];
      for (let j = 0; j < owned.length; j++) entityModule[owned[j]] = mods[i].name;
    }
  } catch (_e) {
    // A manifest that cannot be read is a broken app part; the describe routes
    // report it. Identity still answers so a client can probe and see the app.
  }

  const entities = {};
  const collections = $app.dao().findCollectionsByType("base");
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (col.name.indexOf("_") === 0) continue; // skip system collections
    entities[col.name] = { fields: mapFields(col), module: entityModule[col.name] };
  }

  return c.json(200, {
    a2app: true,
    protocol: "0.1",
    adapterVersion: "0.1.0",
    app: { id: $app.settings().meta.appName || "pocketbase_app", name: $app.settings().meta.appName || null },
    schemaVersion: rules.schemaVersion(entities),
    serverNow: new Date().toISOString(),
    serverTzOffsetMinutes: 0,
  });

  function mapFields(col) {
    const out = [];
    const fields = col.schema.fields();
    for (let j = 0; j < fields.length; j++) out.push(normalize(fields[j]));
    return out;
  }
  function normalize(f) {
    const nf = { name: f.name, type: protocolType(f) };
    if (f.required) nf.required = true;
    if (f.type === "select" && f.options && f.options.values) nf.values = f.options.values;
    if (isDayKeyField(f)) nf.dayKey = true;
    return nf;
  }
  function protocolType(f) {
    switch (f.type) {
      case "number": return "number";
      case "bool": return "boolean";
      case "date": return "datetime";
      case "json": return "json";
      case "file": return "binary";
      case "select": return f.options && f.options.maxSelect && f.options.maxSelect > 1 ? "list<enum>" : "enum";
      case "relation": return f.options && f.options.maxSelect && f.options.maxSelect > 1 ? "list<ref>" : "ref";
      default: return "string";
    }
  }
  function isDayKeyField(f) {
    if (f.type !== "text") return false;
    const max = (f.options && f.options.max) || 0;
    if (max <= 0 || max > 12) return false;
    return /^(due|day|date)$|_(date|day)$/i.test(f.name);
  }
});

/* --------------------------------------------------------------- describe */

// Describe is navigational: one request answers for one place in the app, never
// for the whole app (A2APP-SPEC 3). PocketBase collections cannot carry a module
// of their own, so the entity→module mapping is read from `manifest.modules[].entities`
// — the same app part that already supplies the declared operations. The served
// document is identical to every other stack's; only where the fact is written differs.

routerAdd("GET", "/api/_a2app/describe", (c) => a2appDescribe(c, []));
routerAdd("GET", "/api/_a2app/describe/{p1}", (c) => a2appDescribe(c, [c.pathParam("p1")]));
routerAdd("GET", "/api/_a2app/describe/{p1}/{p2}", (c) => a2appDescribe(c, [c.pathParam("p1"), c.pathParam("p2")]));
routerAdd("GET", "/api/_a2app/describe/{p1}/{p2}/{p3}", (c) =>
  a2appDescribe(c, [c.pathParam("p1"), c.pathParam("p2"), c.pathParam("p3")]),
);
routerAdd("GET", "/api/_a2app/describe/{p1}/{p2}/{p3}/{p4}", (c) =>
  a2appDescribe(c, [c.pathParam("p1"), c.pathParam("p2"), c.pathParam("p3"), c.pathParam("p4")]),
);

function a2appDescribe(c, segments) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const BUDGET = 2000;

  const appPart = readAppPart();
  if (appPart.problems.length > 0) {
    // Refuse rather than serve a describe that omits real capability while
    // answering 200 — the same refusal `createA2App` makes at boot on the stacks
    // that have a boot.
    return c.json(500, {
      a2app: true,
      ok: false,
      code: "inconsistent_app_part",
      message: "The app's declarations are inconsistent and cannot be served.",
      problems: appPart.problems,
    });
  }
  const modules = appPart.modules;
  const operations = appPart.operations;
  const entityModule = appPart.entityModule;

  const entities = liveEntities();

  // The scope model gates only the record levels here (they read real records);
  // the shallower levels publish shape, never values.
  const access = { read: () => true, write: () => true, run: () => true };

  const find = c.queryParam("find");
  if (find !== null && find !== undefined && find !== "" && segments.length === 0) {
    return c.json(200, fitList(
      (items, truncated) => {
        const level = { level: "find", term: find, matches: items, next: ["describe/{path}"] };
        if (truncated) level.truncated = truncated;
        return level;
      },
      findMatches(find),
    ));
  }

  if (segments.length === 0) return c.json(200, rootLevel());

  const moduleName = segments[0];
  const module = modules.filter((m) => m.name === moduleName)[0];
  if (!module) {
    return c.json(404, {
      a2app: true, ok: false, code: "unknown_module",
      message: `No module "${moduleName}".`,
      modules: modules.map((m) => m.name),
    });
  }
  if (segments.length === 1) return c.json(200, moduleLevel(module, c.queryParam("all") === "true"));

  const entityName = segments[1];
  const def = entities[entityName];
  if (!def) {
    return c.json(404, { a2app: true, ok: false, code: "unknown_entity", message: `No such entity "${entityName}".` });
  }
  if (entityModule[entityName] !== moduleName) {
    return c.json(404, {
      a2app: true, ok: false, code: "unknown_entity",
      message: `Entity "${entityName}" is in module "${entityModule[entityName]}", not "${moduleName}".`,
    });
  }
  if (segments.length === 2) return c.json(200, entityLevel(moduleName, entityName, def));

  const recordId = segments[2];
  let record = null;
  try {
    record = $app.dao().findRecordById(entityName, recordId);
  } catch (_e) {
    record = null;
  }
  if (!record) {
    return c.json(404, {
      a2app: true, ok: false, code: "record_not_found",
      message: `No ${entityName} record "${recordId}".`,
    });
  }
  const values = plainRecord(record, def);
  if (segments.length === 3) return c.json(200, recordLevel(moduleName, entityName, def, values));

  const relationName = segments[3];
  const field = def.filter((f) => f.name === relationName && f.type === "list<ref>")[0];
  if (!field) {
    return c.json(404, {
      a2app: true, ok: false, code: "unknown_relation",
      message: `"${relationName}" is not a sub-resource of ${entityName}.`,
    });
  }
  const target = field.entity;
  const targetDef = entities[target] || [];
  const targetLabel = rules.labelField(targetDef);
  const ids = values[relationName];
  const rows = [];
  for (let i = 0; i < (Array.isArray(ids) ? ids.length : 0); i++) {
    let referenced = null;
    try {
      referenced = $app.dao().findRecordById(target, String(ids[i]));
    } catch (_e) {
      referenced = null;
    }
    const label = referenced && targetLabel ? referenced.get(targetLabel) : null;
    rows.push({ id: String(ids[i]), label: label === undefined || label === null ? null : String(label) });
  }
  const relPath = `${moduleName}/${entityName}/${recordId}/${relationName}`;
  return c.json(200, fitList((items, truncated) => {
    const level = {
      level: "relation", path: relPath, entity: target, items: items,
      next: [`data ${target} get {id}`, `describe/${moduleName}/${entityName}/${recordId}`],
    };
    if (truncated) level.truncated = truncated;
    return level;
  }, rows));

  /* ------------------------------------------------------------ app part */

  function readAppPart() {
    // Other stacks refuse an inconsistent app part at construction; PocketBase
    // hooks have no such moment, so the problems are collected here and every
    // describe route reports them instead of serving a plausible-looking app
    // with no modules in it. An unreadable manifest is a broken app, not an app
    // that happens to be empty.
    const problems = [];
    let manifest = null;
    let ops = [];
    try {
      manifest = JSON.parse($os.readFile(`${__hooks}/../../manifest.json`));
    } catch (e) {
      problems.push("manifest.json is missing or not valid JSON: " + String(e));
    }
    try {
      const parsed = JSON.parse($os.readFile(`${__hooks}/../../operations.json`));
      ops = parsed.operations || [];
    } catch (_e) {
      ops = []; // operations.json is optional for a data-only app
    }

    const mods = (manifest && manifest.modules) || [];
    if (manifest && mods.length === 0) {
      problems.push("manifest.json declares no modules: every entity and operation belongs to one, and the root screen lists them");
    }
    const map = {};
    for (let i = 0; i < mods.length; i++) {
      const owned = mods[i].entities || [];
      for (let j = 0; j < owned.length; j++) map[owned[j]] = mods[i].name;
    }
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (!o.module) problems.push('operation "' + o.name + '" declares no module');
      else if (!mods.some((m) => m.name === o.module)) {
        problems.push('operation "' + o.name + '" names undeclared module "' + o.module + '"');
      }
      if (!o.params || typeof o.params !== "object") {
        problems.push('operation "' + o.name + '" declares no typed params (declare {} if it takes none)');
      }
    }
    return { modules: mods, operations: ops, entityModule: map, problems: problems };
  }

  /* ------------------------------------------------------------- levels */

  function rootLevel() {
    const rows = [];
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      const owned = Object.keys(entities).filter((n) => entityModule[n] === m.name);
      const ops = operations.filter((o) => o.module === m.name);
      const row = { name: m.name, entities: owned.length, operations: ops.length, access: "full" };
      if (m.summary) row.summary = m.summary;
      rows.push(row);
    }
    return {
      level: "root",
      app: {
        id: $app.settings().meta.appName || "pocketbase_app",
        name: $app.settings().meta.appName || null,
      },
      modules: rows,
      conventions: conventions(),
      next: ["describe/{module}", "describe?find={term}"],
    };
  }

  function moduleLevel(module, showAll) {
    const owned = Object.keys(entities)
      .filter((n) => entityModule[n] === module.name)
      .map((n) => ({ name: n }));
    const ops = operations
      .filter((o) => o.module === module.name && !o.entity)
      .map((o) => {
        const row = { name: o.name, destructive: !!o.destructive };
        if (o.description) row.summary = o.description;
        return row;
      });
    const baseNext = [`describe/${module.name}/{entity}`];
    if (ops.length) baseNext.push(`${module.name} <operation> [--params]`);

    const build = (rows, truncated) => {
      const level = {
        level: "module", path: module.name, entities: rows, operations: ops,
        next: truncated ? baseNext.concat([`describe/${module.name}?all=true`]) : baseNext,
      };
      if (module.summary) level.summary = module.summary;
      if (truncated) level.truncated = truncated;
      return level;
    };
    return showAll ? build(owned, 0) : fitList(build, owned);
  }

  function entityLevel(moduleName, name, def) {
    const fields = {};
    for (let i = 0; i < def.length; i++) {
      const f = def[i];
      const field = { type: f.type };
      if (f.required) field.required = true;
      if (f.readOnly) field.readOnly = true;
      if (f.values) field.values = f.values;
      if (f.entity) field.entity = f.entity;
      if (f.dayKey) field.format = "YYYY-MM-DD";
      fields[f.name] = field;
    }
    const ops = operations.filter((o) => o.entity === name).map((o) => {
      const decl = { name: o.name, destructive: !!o.destructive, params: o.params, entity: name };
      if (o.description) decl.description = o.description;
      if (o.readOnly) decl.readOnly = true;
      if (o.idempotent) decl.idempotent = true;
      return decl;
    });
    return {
      level: "entity",
      path: `${moduleName}/${name}`,
      label: rules.labelField(def),
      records: `/api/collections/${name}/records`,
      fields: fields,
      operations: ops,
      next: [`describe/${moduleName}/${name}/{id}`, `data ${name} list`],
    };
  }

  function recordLevel(moduleName, name, def, values) {
    const labelField = rules.labelField(def);
    const label = labelField ? values[labelField] : null;
    const ops = operations.filter((o) => o.entity === name).map((o) => {
      const row = { name: o.name, available: true };
      if (o.destructive) row.destructive = true;
      if (o.appliesWhen && !rules.evaluatePredicate(o.appliesWhen, values, def)) {
        row.available = false;
        row.blocked = rules.explainPredicate(o.appliesWhen, values, def);
      }
      return row;
    });
    const relations = def
      .filter((f) => f.type === "list<ref>" && f.entity)
      .map((f) => {
        const row = { name: f.name, entity: f.entity };
        if (Array.isArray(values[f.name])) row.count = values[f.name].length;
        return row;
      });
    const path = `${moduleName}/${name}/${values.id}`;
    const level = {
      level: "record",
      path: path,
      id: values.id,
      label: label === undefined || label === null ? null : String(label),
      operations: ops,
      next: relations
        .map((r) => `describe/${path}/${r.name}`)
        .concat(ops.filter((o) => o.available).map((o) => `${path} ${o.name}`))
        .concat([`data ${name} get ${values.id}`]),
    };
    if (relations.length) level.relations = relations;
    return level;
  }

  function findMatches(term) {
    const needle = term.toLowerCase();
    const out = [];
    for (let i = 0; i < modules.length; i++) {
      if (modules[i].name.toLowerCase().indexOf(needle) !== -1) {
        out.push({ path: modules[i].name, level: "module" });
      }
    }
    const names = Object.keys(entities);
    for (let i = 0; i < names.length; i++) {
      if (names[i].toLowerCase().indexOf(needle) !== -1) {
        out.push({ path: `${entityModule[names[i]]}/${names[i]}`, level: "entity" });
      }
    }
    for (let i = 0; i < operations.length; i++) {
      const o = operations[i];
      if (o.name.toLowerCase().indexOf(needle) === -1) continue;
      out.push({ path: o.entity ? `${o.module}/${o.entity}` : o.module, operation: o.name });
    }
    return out;
  }

  /* ------------------------------------------------------------ helpers */

  /** Trim a list until the level fits, always reporting what was dropped. */
  function fitList(build, items) {
    const whole = build(items.slice(), 0);
    if (JSON.stringify(whole).length <= BUDGET) return whole;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(build(items.slice(0, mid), items.length - mid)).length <= BUDGET) lo = mid;
      else hi = mid - 1;
    }
    return build(items.slice(0, lo), items.length - lo);
  }

  function liveEntities() {
    const out = {};
    const collections = $app.dao().findCollectionsByType("base");
    for (let i = 0; i < collections.length; i++) {
      const col = collections[i];
      if (col.name.indexOf("_") === 0) continue; // skip system collections
      out[col.name] = mapFields(col);
    }
    return out;
  }

  /** A record as a plain value bag, so predicates read the same shape on every
   *  stack. Only declared fields are read: a describe level must never become a
   *  second, unguarded route to data the data API would have gated. */
  function plainRecord(record, def) {
    const out = { id: record.id };
    for (let i = 0; i < def.length; i++) out[def[i].name] = record.get(def[i].name);
    return out;
  }

  function conventions() {
    return {
      writes: "Prefer a declared operation over a raw write where one exists.",
      labels: "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
      dates: 'Relative words ("tomorrow") are rejected by the app; resolve them to ISO 8601 client-side.',
      honesty: "If the app cannot express what was asked, say so instead of approximating into a wrong field.",
    };
  }

  function mapFields(col) {
    const out = [];
    const fields = col.schema.fields();
    for (let j = 0; j < fields.length; j++) {
      const f = fields[j];
      const nf = { name: f.name, type: protocolType(f) };
      if (f.required) nf.required = true;
      if (f.type === "select" && f.options && f.options.values) nf.values = f.options.values;
      if (f.type === "relation" && f.options && f.options.collectionId) {
        nf.entity = collectionNameOf(f.options.collectionId);
      }
      if (isDayKeyField(f)) nf.dayKey = true;
      out.push(nf);
    }
    return out;
  }
  function collectionNameOf(id) {
    try {
      return $app.dao().findCollectionByNameOrId(id).name;
    } catch (_e) {
      return undefined;
    }
  }
  function protocolType(f) {
    switch (f.type) {
      case "number": return "number";
      case "bool": return "boolean";
      case "date": return "datetime";
      case "json": return "json";
      case "file": return "binary";
      case "select": return f.options && f.options.maxSelect && f.options.maxSelect > 1 ? "list<enum>" : "enum";
      case "relation": return f.options && f.options.maxSelect && f.options.maxSelect > 1 ? "list<ref>" : "ref";
      default: return "string";
    }
  }
  function isDayKeyField(f) {
    if (f.type !== "text") return false;
    const max = (f.options && f.options.max) || 0;
    if (max <= 0 || max > 12) return false;
    return /^(due|day|date)$|_(date|day)$/i.test(f.name);
  }
}

/* ----------------------------------------------------------------- guard */

/**
 * Validate the RAW submitted body before PocketBase coerces it. Rejecting here,
 * on the raw values, is the whole point: once PocketBase has coerced, an invalid
 * date and a deliberately-cleared field are indistinguishable.
 */
function guard(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const col = e.record.collection();

  // Normalize this collection's fields to the protocol vocabulary.
  const fields = [];
  const schemaFields = col.schema.fields();
  for (let j = 0; j < schemaFields.length; j++) {
    const f = schemaFields[j];
    let type = "string";
    if (f.type === "number") type = "number";
    else if (f.type === "bool") type = "boolean";
    else if (f.type === "date") type = "datetime";
    else if (f.type === "json") type = "json";
    else if (f.type === "file") type = "binary";
    else if (f.type === "select") type = f.options && f.options.maxSelect > 1 ? "list<enum>" : "enum";
    else if (f.type === "relation") type = f.options && f.options.maxSelect > 1 ? "list<ref>" : "ref";
    const nf = { name: f.name, type: type };
    if (f.required) nf.required = true;
    if (f.type === "select" && f.options && f.options.values) nf.values = f.options.values;
    if (f.type === "text") {
      const max = (f.options && f.options.max) || 0;
      if (max > 0 && max <= 12 && /^(due|day|date)$|_(date|day)$/i.test(f.name)) nf.dayKey = true;
    }
    fields.push(nf);
  }

  // The raw submitted data (before coercion).
  const info = $apis.requestInfo(e.httpContext);
  const body = info.data || {};

  const violations = rules.validate(fields, body, {});
  if (violations.length) {
    const first = violations[0];
    const serverNow = new Date().toISOString();
    throw new ApiError(400, rules.describeViolation(first, serverNow), {
      a2app: true,
      code: first.code,
      field: first.field,
      expected: first.expected,
      got: first.got,
      violations: violations,
    });
  }

  e.next();
}

onRecordCreateRequest((e) => guard(e));
onRecordUpdateRequest((e) => guard(e));
