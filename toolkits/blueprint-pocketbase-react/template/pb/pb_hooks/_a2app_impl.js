/// <reference path="../pb_data/types.d.ts" />
/**
 * A2App adapter implementation (SYSTEM-OWNED — hash-locked in the ownership canon).
 *
 * PocketBase runs every hook handler in an ISOLATED runtime: a handler like
 * `(e) => a2appDescribe(e)` throws `ReferenceError: a2appDescribe is not defined`,
 * because the serialized handler cannot see functions declared at hook-file scope.
 * So `_a2app.pb.js` keeps each handler a self-contained one-liner that `require()`s
 * THIS module and calls into it, and all real logic lives here. A required module
 * is evaluated normally (not serialized), so its functions may freely call one
 * another. The PocketBase globals ($app, $os, ApiError, __hooks) and require() are
 * all available here because this module is first loaded from inside a handler.
 *
 * Runtime: PocketBase JSVM (Goja), 0.23+ API (the blueprint pins the binary to
 * v0.26.x): record hooks `onRecordCreateRequest`/`onRecordUpdateRequest` with
 * `e.next()`, DAO on `$app`, `collection.fields` (a FieldsList — iterate via
 * `fieldNames()`/`asMap()`, type via `field.type()`), request body via
 * `e.requestInfo().body`, routes via a RequestEvent `e` (`e.json`,
 * `e.request.pathValue`). `node --check` validates syntax in the gate; this file
 * only executes inside `pocketbase serve`.
 */

const A2APP = {
  ADAPTER_VERSION: "0.1.0",
  PROTOCOL_VERSION: "0.1",
};

/* --------------------------------------------------------------- identity */

function identity(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);

  // Map the live PocketBase collections onto protocol-typed fields. Reading the
  // live schema is why describe/schemaVersion can never drift.
  //
  // The module each collection belongs to comes from `manifest.modules[].entities`
  // (PocketBase collections cannot carry one), and it is part of the fingerprint:
  // moving an entity between modules changes what describe publishes, so a client
  // caching against schemaVersion has to be told.
  // The app's identity comes from manifest.json — NEVER from PocketBase's
  // settings.meta.appName. A fresh database answers "Acme" (PocketBase's
  // default) there, so an id derived from it breaks every identity check the
  // framework relies on (stop's pid-reuse guard, serve idempotency, dev-route
  // verification) on exactly the boots where the check matters most. `app.id`
  // must be stable across ports, URLs and database rebuilds; the manifest is
  // the one place that holds it.
  let manifest;
  try {
    manifest = JSON.parse(toString($os.readFile(`${__hooks}/../../manifest.json`)));
  } catch (_e) {
    manifest = null;
  }
  if (manifest === null || typeof manifest.id !== "string" || manifest.id === "") {
    // Answering with an invented id would defeat the "verify the id before
    // writing" contract more subtly than an error does.
    return e.json(500, { error: "manifest.json is unreadable or has no id — the app part is broken" });
  }

  const entityModule = {};
  const mods = manifest.modules || [];
  for (let i = 0; i < mods.length; i++) {
    const owned = mods[i].entities || [];
    for (let j = 0; j < owned.length; j++) entityModule[owned[j]] = mods[i].name;
  }

  const entities = {};
  const readOnly = readOnlyDeclared();
  const collections = $app.findAllCollections("base");
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (col.name.indexOf("_") === 0) continue; // skip system collections
    entities[col.name] = { fields: rules.markReadOnly(mapFields(col), readOnly[col.name]), module: entityModule[col.name] };
  }

  return e.json(200, {
    a2app: true,
    protocol: "0.1",
    adapterVersion: "0.1.0",
    app: { id: manifest.id, name: manifest.name || null },
    schemaVersion: rules.schemaVersion(entities),
    serverNow: new Date().toISOString(),
    serverTzOffsetMinutes: 0,
  });

  function mapFields(col) {
    const out = [];
    const names = col.fields.fieldNames();
    const byName = col.fields.asMap();
    for (let j = 0; j < names.length; j++) {
      const f = byName[names[j]];
      if (f.system) continue; // id/created/updated are not protocol fields
      out.push(normalize(f));
    }
    return out;
  }
  function normalize(f) {
    const nf = { name: f.name, type: protocolType(f) };
    if (f.required) nf.required = true;
    if (f.type() === "select" && f.values) nf.values = f.values;
    // A relation's TARGET is part of what describe publishes, so it has to be
    // part of what schemaVersion covers. `describe`'s own field mapping carries
    // it and this one did not — and this is the copy the fingerprint is built
    // from, so retargeting a ref at a different collection changed what describe
    // published without moving the hash. A client caching against it kept a
    // describe pointing the ref at the old collection, which the fingerprint's
    // contract names as exactly the case it must not allow.
    if (f.type() === "relation" && f.collectionId) {
      try {
        nf.entity = $app.findCollectionByNameOrId(f.collectionId).name;
      } catch (_unresolved) {
        /* a target that cannot be resolved is left absent, as before */
      }
    }
    if (isDayKeyField(f)) nf.dayKey = true;
    return nf;
  }
  function protocolType(f) {
    switch (f.type()) {
      case "number": return "number";
      case "bool": return "boolean";
      case "date": return "datetime";
      case "json": return "json";
      case "file": return "binary";
      case "select": return f.maxSelect && f.maxSelect > 1 ? "list<enum>" : "enum";
      case "relation": return f.maxSelect && f.maxSelect > 1 ? "list<ref>" : "ref";
      default: return "string";
    }
  }
  function isDayKeyField(f) {
    if (f.type() !== "text") return false;
    const max = f.max || 0;
    if (max <= 0 || max > 12) return false;
    return /^(due|day|date)$|_(date|day)$/i.test(f.name);
  }
}

/* --------------------------------------------------------------- describe */

// Describe is navigational: one request answers for one place in the app, never
// for the whole app (A2APP-SPEC 3). PocketBase collections cannot carry a module
// of their own, so the entity→module mapping is read from `manifest.modules[].entities`
// — the same app part that already supplies the declared operations. The served
// document is identical to every other stack's; only where the fact is written differs.

function describe(e, segments) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const BUDGET = 2000;
  const query = e.requestInfo().query || {};

  const appPart = readAppPart();
  if (appPart.problems.length > 0) {
    // Refuse rather than serve a describe that omits real capability while
    // answering 200 — the same refusal `createA2App` makes at boot on the stacks
    // that have a boot.
    return e.json(500, {
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

  const find = query.find;
  if (find !== null && find !== undefined && find !== "" && segments.length === 0) {
    return e.json(200, fitList(
      (items, truncated) => {
        const level = { level: "find", term: find, matches: items, next: ["describe/{path}"] };
        if (truncated) level.truncated = truncated;
        return level;
      },
      findMatches(find),
    ));
  }

  if (segments.length === 0) return e.json(200, rootLevel());

  const moduleName = segments[0];
  const module = modules.filter((m) => m.name === moduleName)[0];
  if (!module) {
    return e.json(404, {
      a2app: true, ok: false, code: "unknown_module",
      message: `No module "${moduleName}".`,
      modules: modules.map((m) => m.name),
    });
  }
  if (segments.length === 1) return e.json(200, moduleLevel(module, query.all === "true"));

  const entityName = segments[1];
  const def = entities[entityName];
  if (!def) {
    return e.json(404, { a2app: true, ok: false, code: "unknown_entity", message: `No such entity "${entityName}".` });
  }
  if (entityModule[entityName] !== moduleName) {
    return e.json(404, {
      a2app: true, ok: false, code: "unknown_entity",
      message: `Entity "${entityName}" is in module "${entityModule[entityName]}", not "${moduleName}".`,
    });
  }
  if (segments.length === 2) return e.json(200, entityLevel(moduleName, entityName, def));

  const recordId = segments[2];
  let record = null;
  try {
    record = $app.findRecordById(entityName, recordId);
  } catch (_e) {
    record = null;
  }
  if (!record) {
    return e.json(404, {
      a2app: true, ok: false, code: "record_not_found",
      message: `No ${entityName} record "${recordId}".`,
    });
  }
  const values = plainRecord(record, def);
  if (segments.length === 3) return e.json(200, recordLevel(moduleName, entityName, def, values));

  const relationName = segments[3];
  const field = def.filter((f) => f.name === relationName && f.type === "list<ref>")[0];
  if (!field) {
    return e.json(404, {
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
      referenced = $app.findRecordById(target, String(ids[i]));
    } catch (_e) {
      referenced = null;
    }
    const label = referenced && targetLabel ? referenced.get(targetLabel) : null;
    rows.push({ id: String(ids[i]), label: label === undefined || label === null ? null : String(label) });
  }
  const relPath = `${moduleName}/${entityName}/${recordId}/${relationName}`;
  return e.json(200, fitList((items, truncated) => {
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
      manifest = JSON.parse(toString($os.readFile(`${__hooks}/../../manifest.json`)));
    } catch (err) {
      problems.push("manifest.json is missing or not valid JSON: " + String(err));
    }
    try {
      const parsed = JSON.parse(toString($os.readFile(`${__hooks}/../../operations.json`)));
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
      // The parameter that receives THIS record when the operation is invoked
      // at its path: the one required `ref` to this entity. With none, or more
      // than one, nothing is named and the caller passes it explicitly — the
      // framework never guesses which record an operation meant.
      const targets = Object.keys(o.params || {}).filter((p) => {
        const decl = o.params[p] || {};
        return decl.type === "ref" && decl.entity === name && decl.required === true;
      });
      if (targets.length === 1) row.targetParam = targets[0];
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
    const readOnly = readOnlyDeclared();
    const collections = $app.findAllCollections("base");
    for (let i = 0; i < collections.length; i++) {
      const col = collections[i];
      if (col.name.indexOf("_") === 0) continue; // skip system collections
      out[col.name] = rules.markReadOnly(mapFields(col), readOnly[col.name]);
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
    const names = col.fields.fieldNames();
    const byName = col.fields.asMap();
    for (let j = 0; j < names.length; j++) {
      const f = byName[names[j]];
      if (f.system) continue; // id/created/updated are not protocol fields
      const nf = { name: f.name, type: protocolType(f) };
      if (f.required) nf.required = true;
      if (f.type() === "select" && f.values) nf.values = f.values;
      if (f.type() === "relation" && f.collectionId) {
        nf.entity = collectionNameOf(f.collectionId);
      }
      if (isDayKeyField(f)) nf.dayKey = true;
      out.push(nf);
    }
    return out;
  }
  function collectionNameOf(id) {
    try {
      return $app.findCollectionByNameOrId(id).name;
    } catch (_e) {
      return undefined;
    }
  }
  function protocolType(f) {
    switch (f.type()) {
      case "number": return "number";
      case "bool": return "boolean";
      case "date": return "datetime";
      case "json": return "json";
      case "file": return "binary";
      case "select": return f.maxSelect && f.maxSelect > 1 ? "list<enum>" : "enum";
      case "relation": return f.maxSelect && f.maxSelect > 1 ? "list<ref>" : "ref";
      default: return "string";
    }
  }
  function isDayKeyField(f) {
    if (f.type() !== "text") return false;
    const max = f.max || 0;
    if (max <= 0 || max > 12) return false;
    return /^(due|day|date)$|_(date|day)$/i.test(f.name);
  }
}

/* ----------------------------------------------------------------- guard */

/**
 * Validate the RAW submitted body before PocketBase coerces it. Rejecting here,
 * on the raw values, is the whole point: once PocketBase has coerced, an invalid
 * date and a deliberately-cleared field are indistinguishable.
 *
 * Only requests reach this hook. A runner writing through `a2app.app.save()`
 * does not, which is how it sets a field the app declares read-only.
 */
function guard(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const col = e.record.collection();

  // Normalize this collection's fields to the protocol vocabulary.
  const fields = [];
  const names = col.fields.fieldNames();
  const byName = col.fields.asMap();
  for (let j = 0; j < names.length; j++) {
    const f = byName[names[j]];
    if (f.system) continue; // id/created/updated are not protocol fields
    const ftype = f.type();
    let type = "string";
    if (ftype === "number") type = "number";
    else if (ftype === "bool") type = "boolean";
    else if (ftype === "date") type = "datetime";
    else if (ftype === "json") type = "json";
    else if (ftype === "file") type = "binary";
    else if (ftype === "select") type = f.maxSelect > 1 ? "list<enum>" : "enum";
    else if (ftype === "relation") type = f.maxSelect > 1 ? "list<ref>" : "ref";
    const nf = { name: f.name, type: type };
    if (f.required) nf.required = true;
    if (ftype === "select" && f.values) nf.values = f.values;
    if (ftype === "text") {
      const max = f.max || 0;
      if (max > 0 && max <= 12 && /^(due|day|date)$|_(date|day)$/i.test(f.name)) nf.dayKey = true;
    }
    fields.push(nf);
  }

  // Fields the app declares read-only are written by its own runners, never by
  // a client. The PocketBase dashboard is the exception: a signed-in superuser
  // is the owner editing by hand, and the dashboard sends every field on save.
  if (!e.hasSuperuserAuth()) rules.markReadOnly(fields, readOnlyDeclared()[col.name]);

  // The raw submitted data (before coercion).
  const info = e.requestInfo();
  const body = info.body || {};

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

/**
 * Refuse to delete a record that other records still point at.
 *
 * PocketBase serves records natively, so writes are guarded by hooking the
 * request — and delete was not hooked at all. An app that refuses to delete a
 * client with invoices inside its own operation guards one way in;
 * `DELETE /api/collections/clients/records/{id}` is the other, and it went
 * straight through, leaving invoices pointing at nothing and reporting success.
 *
 * The relationships are read from PocketBase itself: a `relation` field already
 * names the collection it targets, so nothing extra is asked of the app.
 *
 * FAILS OPEN, deliberately. If the scan cannot run — an API shape this adapter
 * did not expect, a collection it cannot read — the delete proceeds rather than
 * being blocked. A guard that cannot run must not be able to brick every delete
 * in an app: the worst case here is the behaviour that existed before this hook,
 * never an app that can no longer delete anything.
 */
function deleteGuard(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const target = e.record.collection().name;
  const recordId = e.record.id;
  // Examples, not an inventory: a caller does not need every blocking row.
  const LIMIT = 10;

  const blockers = [];
  try {
    // Relation targets, read live. Built here rather than shared because this
    // module is required fresh inside each pooled runtime.
    const entities = {};
    const collections = $app.findAllCollections("base");
    for (let i = 0; i < collections.length; i++) {
      const col = collections[i];
      if (col.name.indexOf("_") === 0) continue; // skip system collections
      const names = col.fields.fieldNames();
      const byName = col.fields.asMap();
      const mapped = [];
      for (let j = 0; j < names.length; j++) {
        const f = byName[names[j]];
        if (f.system || f.type() !== "relation" || !f.collectionId) continue;
        let targetName;
        try {
          targetName = $app.findCollectionByNameOrId(f.collectionId).name;
        } catch (_unresolved) {
          continue; // a relation whose target cannot be resolved blocks nothing
        }
        mapped.push({ name: f.name, type: f.maxSelect > 1 ? "list<ref>" : "ref", entity: targetName });
      }
      entities[col.name] = { fields: mapped };
    }

    const pointing = rules.referencingFields(entities, target);
    for (let k = 0; k < pointing.length; k++) {
      const p = pointing[k];
      // `~` matches inside a multi-relation; `=` is exact for a single one. The
      // id travels as a bound parameter, never spliced into the filter string.
      const expr = p.list ? `${p.field} ~ {:id}` : `${p.field} = {:id}`;
      const rows = $app.findRecordsByFilter(p.entity, expr, "", LIMIT, 0, { id: recordId });
      if (rows && rows.length) {
        const ids = [];
        for (let r = 0; r < rows.length; r++) ids.push(rows[r].id);
        blockers.push({ entity: p.entity, field: p.field, ids: ids });
      }
    }
  } catch (err) {
    try {
      console.log(`a2app: referential delete check could not run for ${target} — allowing the delete: ${err}`);
    } catch (_ignored) {
      /* a logger that is not there must not become the failure */
    }
    return e.next();
  }

  if (blockers.length) {
    let total = 0;
    const where = [];
    for (let i = 0; i < blockers.length; i++) {
      total += blockers[i].ids.length;
      where.push(`${blockers[i].entity}.${blockers[i].field}`);
    }
    const said = total === 1 ? "a record still references" : `${total} records still reference`;
    throw new ApiError(409, `Cannot delete ${target} "${recordId}": ${said} it (${where.join(", ")}).`, {
      a2app: true,
      ok: false,
      code: "record_referenced",
      referencedBy: blockers,
      resolution:
        "Remove or repoint the referencing records first, or run an operation the app provides for this. " +
        'An app that intends references to outlive the record sets the relation\'s onDelete to "ignore".',
    });
  }

  e.next();
}

/* ------------------------------------------------- the app→agent plane */

/*
 * Operations, the task queue and the event log (A2APP-SPEC 5–6), served with
 * the same wire format as every other adapter. Parity oracle: adapter-core's
 * `handleOperation`/`handleTasks`/`handleEvents`; the lifecycle rules
 * themselves live in `_a2app_rules.js`, where the gate's self-test holds them.
 *
 * STORAGE. Tasks, events and approval keys are adapter state, not records, so
 * they are not collections: an agent must not be able to list, edit or delete
 * them through the records API, and describe must not publish them. They are
 * tables of their own in PocketBase's data.db, created at bootstrap. That puts
 * them in the app's data directory — they survive a restart, ride along in a
 * backup, and a dev boot (fresh data directory) starts with an empty queue.
 *
 * ATOMICITY. PocketBase runs hooks on a pool of runtimes, so two requests can
 * race. Every read-modify-write runs inside `runInTransaction`, which
 * PocketBase serialises on its single write connection: of two simultaneous
 * claims, the second reads the first one's result and gets the 409.
 */

const TOKEN_FILE = ".agent-token";
const LOCAL_GRANT = { credentialId: "cred_local", agentName: "local", principal: "owner" };
const CREDENTIAL_HINT = "Read the app's .agent-token file (mode 0600) in the project directory, and send it as X-A2App-Token.";

/** Create the adapter's own tables. Idempotent; runs on every bootstrap. */
function ensureStore(app) {
  const statements = [
    "CREATE TABLE IF NOT EXISTS _a2app_tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, dedup TEXT, body TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS _a2app_tasks_status ON _a2app_tasks (status)",
    "CREATE UNIQUE INDEX IF NOT EXISTS _a2app_tasks_dedup ON _a2app_tasks (dedup) WHERE dedup IS NOT NULL",
    // AUTOINCREMENT, not a plain rowid: a pruned seq must never be handed out
    // again, or a client holding an old cursor would skip the new event.
    "CREATE TABLE IF NOT EXISTS _a2app_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _a2app_approvals (key TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
  ];
  for (let i = 0; i < statements.length; i++) app.db().newQuery(statements[i]).execute();
}

/* ------------------------------------------------------------- envelopes */

function fail(e, status, code, message, extra) {
  const body = { a2app: true, ok: false, code: code, message: message };
  const more = extra || {};
  for (const k in more) if (Object.prototype.hasOwnProperty.call(more, k)) body[k] = more[k];
  return e.json(status, body);
}

/** The request body as plain JS. PocketBase hands it over as a Go map; a JSON
 *  round trip makes it the same shape the rules were written against. */
function bodyOf(e) {
  let raw;
  try {
    raw = e.requestInfo().body;
  } catch (_e) {
    raw = null;
  }
  if (raw === null || raw === undefined) return {};
  const plain = JSON.parse(JSON.stringify(raw));
  return plain && typeof plain === "object" && !Array.isArray(plain) ? plain : {};
}

function header(e, name) {
  const v = e.request.header.get(name);
  return v === undefined || v === null ? "" : String(v);
}

function queryParam(e, name) {
  const v = e.request.url.query().get(name);
  return v === undefined || v === null ? "" : String(v);
}

function readManifest() {
  try {
    return JSON.parse(toString($os.readFile(`${__hooks}/../../manifest.json`)));
  } catch (_e) {
    return null;
  }
}

function readDeclaredOperations() {
  try {
    return JSON.parse(toString($os.readFile(`${__hooks}/../../operations.json`))).operations || [];
  } catch (_e) {
    return [];
  }
}

/** The app-owned seam: `pb/pb_hooks/operations.js` exports `{ events, runners, readOnly }`.
 *  Absent is a valid app (no operations, no events); broken is reported. */
function appCode() {
  try {
    if (!$os.stat(`${__hooks}/operations.js`)) return { events: [], runners: {}, readOnly: {}, problem: null };
  } catch (_absent) {
    return { events: [], runners: {}, readOnly: {}, problem: null };
  }
  try {
    const mod = require(`${__hooks}/operations.js`);
    return { events: mod.events || [], runners: mod.runners || {}, readOnly: mod.readOnly || {}, problem: null };
  } catch (err) {
    return { events: [], runners: {}, readOnly: {}, problem: String(err) };
  }
}

/** The fields the app declares read-only, as `{ collection: [field, ...] }`.
 *  PocketBase has no read-only flag for a field, so the app says it here
 *  (`readOnly` in operations.js), the same thing a schema's `readOnly: true`
 *  says on the other stacks. Describe publishes it, the fingerprint covers it,
 *  and the guard refuses a client write to it. */
function readOnlyDeclared() {
  return appCode().readOnly;
}

/* ---------------------------------------------------------------- access */

/**
 * Who is calling, decided in a fixed order: host, origin, credential. Returns
 * the call context, or null once the refusal has been written — the caller
 * must then return without writing anything else. (`e.json` returns nothing to
 * pass along, so a refusal cannot be handed back as a value.)
 *
 *   host        Only a loopback name. A page on evil.com whose DNS re-resolves
 *               to 127.0.0.1 is same-origin as far as the browser knows and
 *               sends no Origin on a GET; its Host header still says evil.com.
 *   origin      A foreign browser origin is refused. The app's own View
 *               (Origin equal to this host) is the owner on a single-user app;
 *               on a multi-user app it needs a signed-in PocketBase user.
 *   credential  The agent token from `.agent-token`, sent as X-A2App-Token. A
 *               write always needs one; a read needs one on a multi-user app.
 */
function authorize(e, isWrite) {
  const host = String(e.request.host || "").toLowerCase();
  const name = host.indexOf("[") === 0 ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  const loopback = name === "localhost" || name === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
  if (!loopback) {
    fail(e, 403, "forbidden_host", `Refused: this app answers only on its own host, not "${host}".`);
    return null;
  }

  const manifest = readManifest();
  const multiUser = !!manifest && manifest.authMode === "multi-user";

  const origin = header(e, "Origin");
  if (origin !== "") {
    if (origin.toLowerCase() !== `http://${host}`) {
      fail(e, 403, "forbidden_origin", "Refused: request Origin is not this app's own.");
      return null;
    }
    if (!multiUser) return { credentialId: "ui", agentName: null, principal: "owner" };
    if (e.auth) return { credentialId: "ui", agentName: null, principal: String(e.auth.id) };
  }

  const presented = header(e, "X-A2App-Token") || header(e, "X-LUI-Token");
  let expected = "";
  try {
    expected = toString($os.readFile(`${__hooks}/../../${TOKEN_FILE}`)).trim();
  } catch (_none) {
    expected = ""; // no credential minted: nothing can match it
  }
  if (presented !== "" && expected !== "" && $security.equal(presented, expected)) {
    return { credentialId: LOCAL_GRANT.credentialId, agentName: LOCAL_GRANT.agentName, principal: LOCAL_GRANT.principal };
  }
  if (isWrite || multiUser || presented !== "") {
    // A token that does not match is refused even for a read: an agent holding
    // a stale credential should learn so, not be served as anonymous.
    fail(e, 401, "agent_token_required",
      presented !== "" ? "The agent credential presented is not this app's." : "This write requires an agent credential.",
      { how: CREDENTIAL_HINT });
    return null;
  }
  return { credentialId: "anonymous", agentName: null, principal: "owner" };
}

/* ----------------------------------------------------------------- store */

function rows(db, sql, params, shape) {
  const out = arrayOf(new DynamicModel(shape));
  db.newQuery(sql).bind(params || {}).all(out);
  return out;
}

function loadTask(db, id) {
  const found = rows(db, "SELECT body FROM _a2app_tasks WHERE id = {:id}", { id: id }, { body: "" });
  return found.length ? JSON.parse(found[0].body) : null;
}

function saveTask(db, task) {
  db.newQuery("UPDATE _a2app_tasks SET status = {:status}, body = {:body} WHERE id = {:id}")
    .bind({ id: task.id, status: task.status, body: JSON.stringify(task) })
    .execute();
}

/** Return abandoned claims to the queue (or fail them, once exhausted). Read
 *  first without a transaction: on almost every poll nothing is due, and a poll
 *  should not take the write lock to find that out. */
function sweep(app) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const Q = rules.QUEUE;
  const nowMs = Date.now();
  const working = rows(app.db(), "SELECT body FROM _a2app_tasks WHERE status = 'working'", {}, { body: "" });
  const due = [];
  for (let i = 0; i < working.length; i++) {
    const t = JSON.parse(working[i].body);
    if (rules.sweepTask(t, nowMs, Q.TASK_TIMEOUT_MS, Q.TASK_MAX_DELIVERIES)) due.push(t.id);
  }
  if (due.length === 0) return;
  app.runInTransaction((tx) => {
    for (let i = 0; i < due.length; i++) {
      // Re-read inside the transaction: a heartbeat may have landed since.
      const current = loadTask(tx.db(), due[i]);
      const swept = current && rules.sweepTask(current, Date.now(), Q.TASK_TIMEOUT_MS, Q.TASK_MAX_DELIVERIES);
      if (swept) saveTask(tx.db(), swept);
    }
  });
}

/**
 * Emit a declared event and, when `capability` is given, queue a task for an
 * agent. The same occurrence (type, capability, payload) dedupes to one task,
 * even after it finished — a re-ask names the previous task in its payload.
 * `app` is the app (or the transaction) to write through; `env` is what
 * `triggerEnv()` read, so a runner that fires many times reads it once.
 */
function triggerWith(app, env, type, payload, capability) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (typeof type !== "string" || type === "") throw new Error("trigger needs an event type");
  if (!rules.eventDeclared(env.events, type)) {
    throw new Error(`event type "${type}" is not declared (add it to \`events\` in pb/pb_hooks/operations.js)`);
  }
  const plain = payload === undefined || payload === null ? {} : JSON.parse(JSON.stringify(payload));
  const appId = env.appId;
  const now = new Date().toISOString();
  const hex = "0123456789abcdef";

  const db = app.db();
  const event = { id: "evt_" + $security.randomStringWithAlphabet(16, hex), app: appId, type: type, payload: plain, createdAt: now };
  db.newQuery("INSERT INTO _a2app_events (id, body) VALUES ({:id}, {:body})")
    .bind({ id: event.id, body: JSON.stringify(event) })
    .execute();
  db.newQuery("DELETE FROM _a2app_events WHERE seq <= (SELECT MAX(seq) FROM _a2app_events) - {:keep}")
    .bind({ keep: rules.QUEUE.EVENT_RETENTION })
    .execute();

  let taskId = null;
  if (typeof capability === "string" && capability !== "") {
    const dedup = "sha256:" + $security.sha256(rules.occurrenceText(type, capability, plain));
    const existing = rows(db, "SELECT id FROM _a2app_tasks WHERE dedup = {:dedup}", { dedup: dedup }, { id: "" });
    if (existing.length) {
      taskId = existing[0].id;
    } else {
      const task = rules.newTask({
        id: "tsk_" + $security.randomStringWithAlphabet(16, hex),
        app: appId, event: event.id, capability: capability, payload: plain, dedupKey: dedup, now: now,
      });
      db.newQuery("INSERT INTO _a2app_tasks (id, status, dedup, body) VALUES ({:id}, {:status}, {:dedup}, {:body})")
        .bind({ id: task.id, status: task.status, dedup: dedup, body: JSON.stringify(task) })
        .execute();
      taskId = task.id;
    }
  }
  return { eventId: event.id, taskId: taskId };
}

/** The declared event types and the app id, read from disk once per call site. */
function triggerEnv() {
  const manifest = readManifest();
  return { events: appCode().events, appId: manifest && manifest.id ? String(manifest.id) : "" };
}

/** `trigger` for code outside an operation (a record hook, a cron job). Inside
 *  an operation, use the `a2app.trigger` the runner is handed instead.
 *
 *  It runs in a transaction of its own, so the event and its task land together
 *  or not at all. Code already inside a transaction passes it as `txApp`:
 *  opening a second one there would wait forever on the first, because
 *  PocketBase writes through a single connection. */
function trigger(type, payload, capability, txApp) {
  if (txApp) return triggerWith(txApp, triggerEnv(), type, payload, capability);
  let fired = null;
  $app.runInTransaction((tx) => {
    fired = triggerWith(tx, triggerEnv(), type, payload, capability);
  });
  return fired;
}

/* ------------------------------------------------------------ operations */

/**
 * POST /api/ops/{name}: guard the arguments, gate a destructive call behind an
 * approval key, then run the app's own runner from `pb/pb_hooks/operations.js`.
 *
 * The runner runs inside ONE transaction with everything it writes — records
 * through `a2app.app`, tasks through `a2app.trigger` — so an operation either
 * happened or did not: a runner that throws leaves no half-written record and
 * no task queued for work that never started.
 */
function runOperation(e, name) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const decls = readDeclaredOperations();
  let decl = null;
  for (let i = 0; i < decls.length; i++) if (decls[i].name === name) decl = decls[i];
  if (!decl) return fail(e, 404, "unknown_operation", `No declared operation "${name}".`);

  const ctx = authorize(e, decl.readOnly !== true);
  if (ctx === null) return;
  const args = bodyOf(e);

  // Guard the RAW args before anything acts on them, and before an approval
  // key is minted: a human must never be asked to approve a call that cannot run.
  const violations = rules.validateArgs(decl.params || {}, args);
  if (violations.length) {
    const first = violations[0];
    return e.json(400, {
      a2app: true, ok: false, code: first.code, field: first.field, expected: first.expected, got: first.got,
      message: rules.describeViolation(first, new Date().toISOString()), violations: violations,
    });
  }

  if (decl.destructive) {
    const key = $security.sha256(rules.approvalText(name, args));
    const provided = header(e, "X-A2App-Approval") || header(e, "X-LUI-Approval");
    const nowMs = Date.now();
    if (provided === "") {
      $app.runInTransaction((tx) => {
        tx.db().newQuery("DELETE FROM _a2app_approvals WHERE expires < {:now}").bind({ now: nowMs }).execute();
        tx.db().newQuery("INSERT OR REPLACE INTO _a2app_approvals (key, expires) VALUES ({:key}, {:expires})")
          .bind({ key: key, expires: nowMs + rules.QUEUE.APPROVAL_TTL_MS })
          .execute();
      });
      return fail(e, 428, "approval_required", `Operation "${name}" is destructive and requires approval.`, { approvalKey: key });
    }
    let consumed = false;
    if (provided === key) {
      $app.runInTransaction((tx) => {
        const held = rows(tx.db(), "SELECT expires FROM _a2app_approvals WHERE key = {:key}", { key: key }, { expires: 0 });
        if (held.length === 0) return;
        tx.db().newQuery("DELETE FROM _a2app_approvals WHERE key = {:key}").bind({ key: key }).execute();
        consumed = held[0].expires >= nowMs;
      });
    }
    if (!consumed) {
      return fail(e, 428, "approval_required", "Approval key does not match this exact call (or has expired).", { approvalKey: key });
    }
  }

  const code = appCode();
  if (code.problem !== null) {
    return fail(e, 500, "operation_failed", `pb/pb_hooks/operations.js could not be loaded: ${code.problem}`);
  }
  const runner = code.runners[name];
  if (typeof runner !== "function") {
    return fail(e, 501, "not_implemented", `This app declares "${name}" but implements no operation runner.`);
  }
  const manifest = readManifest();
  const env = { events: code.events, appId: manifest && manifest.id ? String(manifest.id) : "" };

  // A JS exception crossing runInTransaction comes back as a Go error and loses
  // its fields, so the runner's own failure is caught inside and carried out.
  let result = null;
  let thrown = null;
  try {
    $app.runInTransaction((tx) => {
      const a2app = {
        app: tx,
        trigger: (type, payload, capability) => triggerWith(tx, env, type, payload, capability),
        error: operationError,
      };
      try {
        result = runner(args, ctx, a2app);
      } catch (err) {
        thrown = err;
        throw new Error("a2app: rolled back");
      }
    });
  } catch (err) {
    if (thrown === null) thrown = err;
  }
  if (thrown !== null) {
    if (thrown && thrown.a2appOperationError) {
      return fail(e, thrown.status, thrown.code, thrown.message, thrown.extra);
    }
    return fail(e, 500, "operation_failed", `Operation "${name}" threw: ${thrown && thrown.message ? thrown.message : String(thrown)}`);
  }
  return e.json(200, {
    a2app: true, ok: true, operation: name,
    result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
  });
}

/** What a runner throws to refuse with its own status and code:
 *  `throw a2app.error(409, "already_done", "That task is already done.")`. */
function operationError(status, code, message, extra) {
  return { a2appOperationError: true, status: status, code: code, message: message, extra: extra || {} };
}

/* ----------------------------------------------------------------- tasks */

/** GET /api/_a2app/tasks[?status=] */
function listTasks(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (authorize(e, false) === null) return;
  sweep($app);
  const status = queryParam(e, "status");
  const found = status
    ? rows($app.db(), "SELECT body FROM _a2app_tasks WHERE status = {:status} ORDER BY seq", { status: status }, { body: "" })
    : rows($app.db(), "SELECT body FROM _a2app_tasks ORDER BY seq", {}, { body: "" });
  const tasks = [];
  for (let i = 0; i < found.length; i++) tasks.push(rules.taskWire(JSON.parse(found[i].body)));
  return e.json(200, { a2app: true, tasks: tasks, pollAfterMs: rules.QUEUE.POLL_AFTER_MS });
}

/** GET /api/_a2app/tasks/{id} */
function getTask(e, id) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (authorize(e, false) === null) return;
  sweep($app);
  const task = loadTask($app.db(), id);
  if (!task) return fail(e, 404, "task_not_found", `No task "${id}".`);
  return e.json(200, rules.taskWire(task));
}

/** POST /api/_a2app/tasks/{id}/{claim|progress|complete|cancel} */
function taskAction(e, id, action) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const ctx = authorize(e, true);
  if (ctx === null) return;
  sweep($app);
  const body = bodyOf(e);
  let outcome = null;
  $app.runInTransaction((tx) => {
    const task = loadTask(tx.db(), id);
    if (!task) {
      outcome = { error: { status: 404, code: "task_not_found", message: `No task "${id}".`, extra: {} } };
      return;
    }
    outcome = rules.applyTaskAction(task, action, body, ctx, new Date().toISOString());
    if (outcome.task) saveTask(tx.db(), outcome.task);
  });
  if (outcome.error) return fail(e, outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.extra);
  return e.json(200, rules.taskWire(outcome.task));
}

/* ---------------------------------------------------------------- events */

/** GET /api/_a2app/events[?since=<cursor>] */
function listEvents(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (authorize(e, false) === null) return;
  const since = Number(queryParam(e, "since")) || 0;
  const found = rows($app.db(), "SELECT seq, body FROM _a2app_events WHERE seq > {:since} ORDER BY seq", { since: since }, { seq: 0, body: "" });
  const events = [];
  for (let i = 0; i < found.length; i++) {
    const ev = JSON.parse(found[i].body);
    events.push({ id: ev.id, app: ev.app, type: ev.type, payload: ev.payload, createdAt: ev.createdAt });
  }
  const nextCursor = String(found.length ? found[found.length - 1].seq : since);
  return e.json(200, { a2app: true, events: events, nextCursor: nextCursor, pollAfterMs: rules.QUEUE.EVENTS_POLL_AFTER_MS });
}

/** GET /api/_a2app/context — what the person is looking at. This View does not
 *  publish a selection, so the answer is the honest empty one. */
function context(e) {
  if (authorize(e, false) === null) return;
  return e.json(200, { a2app: true, view: null, selected: [] });
}

/** Anything but POST on an operation: say how it is invoked, rather than
 *  leaving the router's bare 405 or the View's index page to answer. */
function operationMethod(e) {
  return fail(e, 405, "usage", "Operations are POST-only.");
}

module.exports = {
  identity: identity, describe: describe, guard: guard, deleteGuard: deleteGuard,
  ensureStore: ensureStore, runOperation: runOperation, trigger: trigger,
  listTasks: listTasks, getTask: getTask, taskAction: taskAction,
  listEvents: listEvents, context: context, operationMethod: operationMethod,
};
