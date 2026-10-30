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
 * Runtime: PocketBase JSVM (Goja) on the 0.39 line (pb-serve.mjs pins the binary
 * to v0.39.7): record hooks `onRecordCreateRequest`/`onRecordUpdateRequest` with
 * `e.next()`, DAO on `$app`, `collection.fields` (a FieldsList — iterate via
 * `fieldNames()`/`asMap()`, type via `field.type()`), request body via
 * `e.requestInfo().body`, routes via a RequestEvent `e` (`e.json`,
 * `e.request.pathValue`). `node --check` validates syntax in the gate; this file
 * only executes inside `pocketbase serve`.
 */

const A2APP = {
  ADAPTER_VERSION: "0.1.0",
  PROTOCOL_VERSION: "0.2",
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
    protocol: A2APP.PROTOCOL_VERSION,
    adapterVersion: A2APP.ADAPTER_VERSION,
    app: { id: manifest.id, name: manifest.name || null },
    schemaVersion: rules.schemaVersion(entities),
    serverNow: new Date().toISOString(),
    serverTzOffsetMinutes: 0,
    authMode: manifest.authMode === "multi-user" ? "multi-user" : "none",
    accountUrl: rules.AUTH.ACCOUNT_URL,
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
  const code = appCode();
  const entities = liveEntities();
  const problems = appPart.problems.concat(declarationProblems(code, entities, appPart.operations));
  if (problems.length > 0) {
    // Refuse rather than serve a describe that omits real capability while
    // answering 200 — the same refusal `createA2App` makes at boot on the stacks
    // that have a boot.
    return inconsistentAppPart(e, problems);
  }
  const modules = appPart.modules;
  const operations = appPart.operations;
  const entityModule = appPart.entityModule;

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

  // From here describe serves record VALUES, so the caller is checked as for
  // any other read of records — including whose records it may see (spec
  // §5): another member's record answers exactly like a missing one.
  const ctx = authorize(e, { scope: `data:${entityName}:read`, isWrite: false });
  if (ctx === null) return;
  const recordId = segments[2];
  let record = null;
  try {
    record = $app.findRecordById(entityName, recordId);
  } catch (_e) {
    record = null;
  }
  const ownerField = code.ownedBy[entityName];
  if (record && ownerField && isMultiUser() && ctx.role !== "owner" && record.getString(ownerField) !== ctx.principal) record = null;
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
    // The app's id and name come from the manifest, as in identity — never from
    // PocketBase's settings.meta.appName, which a fresh database answers "Acme".
    const app = manifest ? { id: manifest.id, name: manifest.name || null } : null;
    return { app: app, modules: mods, operations: ops, entityModule: map, problems: problems };
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
      app: appPart.app,
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
    const level = {
      level: "entity",
      path: `${moduleName}/${name}`,
      label: rules.labelField(def),
      records: `/api/collections/${name}/records`,
      fields: fields,
      operations: ops,
      next: [`describe/${moduleName}/${name}/{id}`, `data ${name} list`],
    };
    if (code.ownedBy[name]) level.ownedBy = code.ownedBy[name];
    return level;
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
 *
 * On create it also records whose record this is (spec/v0_2/auth.md §5): the
 * `ownedBy` field the app declares gets the caller's principal — the account
 * `nativeGate` made `e.auth`, or `owner`. PocketBase's collection rules then
 * decide who sees it. The create rule itself was checked before this hook ran
 * (PocketBase 0.27+), so it cannot depend on the owner set here.
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
  // `nativeGate` marks that request; an agent acting for the owner is also
  // a superuser to PocketBase, but it is held to the app's rules.
  const dashboard = e.hasSuperuserAuth() && e.get(DASHBOARD) === true;
  const code = appCode();
  if (!dashboard) {
    if (code.problem !== null) {
      // Fail closed: which fields are read-only is declared in operations.js,
      // so while it cannot load, a client write could overwrite one unnoticed.
      // Thrown, not written: inside a batch only an error rolls the batch back.
      throw new ApiError(503, `Writes are paused (app_code_unavailable): pb/pb_hooks/operations.js could not be loaded (${code.problem}).`, {});
    }
    rules.markReadOnly(fields, readOnlyOf(code)[col.name]);
  }

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

  // The owner is the adapter's to set, and the guard has already refused a
  // client that tried. The dashboard may name one by hand.
  const ownerField = code.ownedBy[col.name];
  if (ownerField && e.record.isNew() && !(dashboard && body[ownerField])) {
    const auth = info.auth;
    e.record.set(ownerField, auth && auth.collection().name === ACCOUNTS ? auth.id : OWNER);
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
 * claims, the second reads the first one's result and gets the 409. A raw
 * write through `$app.db()` goes to that same connection (PocketBase 0.28+),
 * so inside a transaction every write goes through the transaction's own
 * `tx.db()`: one through `$app.db()` would wait on the transaction forever.
 */

const TOKEN_FILE = ".agent-token";
const CREDENTIAL_HINT = "Read the app's .agent-token file (mode 0600) in the project directory, and send it as X-A2App-Token.";
/** Said to an agent whose credential stopped working (revoked, expired, or its
 *  person deactivated): a new one is the person's to give. */
const RENEW_HINT = "Ask the person this agent acts for to approve it again (a2app <app> login), or the app's owner for a new credential.";

/** The principal of the admin credential and of an `authMode: none` app. */
const OWNER = "owner";
const OWNER_INFO = { id: OWNER, name: "Owner", role: "owner", active: true };
/** The app's own `.agent-token`: the admin credential (spec/v0_2/auth.md §2.3). */
const ADMIN_GRANT = { credentialId: "cred_local", agentName: "local", principal: OWNER, scopes: ["*"] };
/** PocketBase's auth collection that holds the accounts of a multi-user app. */
const ACCOUNTS = "users";
/** Request-store key `nativeGate` sets on a request it passed as the PocketBase
 *  dashboard (a signed-in superuser, not an agent acting for the owner). */
const DASHBOARD = "a2app.dashboard";

/**
 * Create the adapter's own tables. Idempotent; runs on every bootstrap.
 *
 * Credentials, sessions, invites and device requests are adapter state like
 * the queue (spec/v0_2/auth.md): tables in data.db, never collections, every
 * secret stored as its SHA-256. Accounts are the one exception, kept as
 * records of PocketBase's `users` collection so collection rules can name them
 * (`@request.auth.id`); the accounts migration locks that collection.
 *
 * Then the app's `.agent-token` is seeded as the admin credential, hashed on
 * the way in — again at every boot, so a rotated file replaces the old token
 * and a deleted one revokes it — and credentials that ended more than 30 days
 * ago are pruned.
 */
function ensureStore(app) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const statements = [
    "CREATE TABLE IF NOT EXISTS _a2app_tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, dedup TEXT, body TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS _a2app_tasks_status ON _a2app_tasks (status)",
    "CREATE UNIQUE INDEX IF NOT EXISTS _a2app_tasks_dedup ON _a2app_tasks (dedup) WHERE dedup IS NOT NULL",
    // AUTOINCREMENT, not a plain rowid: a pruned seq must never be handed out
    // again, or a client holding an old cursor would skip the new event.
    "CREATE TABLE IF NOT EXISTS _a2app_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _a2app_approvals (key TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _a2app_idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (scope, key))",
    // Credentials are found by the SHA-256 of their token, never the token.
    "CREATE TABLE IF NOT EXISTS _a2app_grants (credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL)",
    // Keyed by the SHA-256 of the session secret, invite code or device code.
    "CREATE TABLE IF NOT EXISTS _a2app_sessions (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _a2app_invites (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _a2app_devices (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
  ];
  for (let i = 0; i < statements.length; i++) app.db().newQuery(statements[i]).execute();

  const db = app.db();
  const nowMs = Date.now();
  let token = "";
  try {
    token = toString($os.readFile(`${__hooks}/../../${TOKEN_FILE}`)).trim();
  } catch (_none) {
    token = ""; // no credential minted yet
  }
  const existing = grantById(db, ADMIN_GRANT.credentialId);
  if (token === "") {
    if (existing) deleteGrant(db, ADMIN_GRANT.credentialId);
  } else {
    putGrant(db, {
      credentialId: ADMIN_GRANT.credentialId,
      tokenHash: $security.sha256(token),
      principal: ADMIN_GRANT.principal,
      agentName: ADMIN_GRANT.agentName,
      scopes: ADMIN_GRANT.scopes,
      createdAt: existing ? existing.createdAt : new Date(nowMs).toISOString(),
      expiresAt: null,
      lastUsedAt: existing ? existing.lastUsedAt : null,
      revokedAt: null,
      task: null,
      admin: true,
    });
  }
  const all = listGrants(db);
  for (let i = 0; i < all.length; i++) if (rules.grantPrunable(all[i], nowMs)) deleteGrant(db, all[i].credentialId);
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

/** The app-owned seam: `pb/pb_hooks/operations.js` exports `{ events, runners,
 *  readOnly, ownedBy, capabilities, permissionsOf? }`. Absent is a valid app (no
 *  operations, no events); broken is reported. */
function appCode() {
  const none = (problem) => ({ events: [], runners: {}, readOnly: {}, ownedBy: {}, capabilities: {}, permissionsOf: null, problem: problem });
  try {
    if (!$os.stat(`${__hooks}/operations.js`)) return none(null);
  } catch (_absent) {
    return none(null);
  }
  try {
    const mod = require(`${__hooks}/operations.js`);
    return {
      events: mod.events || [],
      runners: mod.runners || {},
      readOnly: mod.readOnly || {},
      ownedBy: mod.ownedBy || {},
      capabilities: mod.capabilities || {},
      permissionsOf: typeof mod.permissionsOf === "function" ? mod.permissionsOf : null,
      problem: null,
    };
  } catch (err) {
    return none(String(err));
  }
}

/** The fields clients may not write, as `{ collection: [field, ...] }`: those
 *  the app declares read-only, and the field each owned collection records its
 *  owner in (`ownedBy`). PocketBase has no read-only flag for a field, so the
 *  app says it in operations.js, the same thing a schema's `readOnly: true`
 *  says on the other stacks. Describe publishes it, the fingerprint covers it,
 *  and the guard refuses a client write to it. */
function readOnlyOf(code) {
  const out = {};
  for (const name in code.readOnly) out[name] = code.readOnly[name].slice();
  for (const name in code.ownedBy) (out[name] = out[name] || []).push(code.ownedBy[name]);
  return out;
}

function readOnlyDeclared() {
  return readOnlyOf(appCode());
}

/** The 0.2 declarations in operations.js that do not fit the app — an `ownedBy`
 *  naming no string field, a capability needing scopes the app does not declare.
 *  adapter-core refuses these at construction; here, like the rest of the app
 *  part, they are reported by describe (`entities` maps a collection to its
 *  protocol fields). */
function declarationProblems(code, entities, operations) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const shaped = {};
  for (const name in entities) shaped[name] = { fields: entities[name] };
  const declared = rules.declaredScopes(Object.keys(entities), operations.map((o) => o.name));
  return rules.ownedByProblems(shaped, code.ownedBy).concat(rules.capabilityProblems(code.capabilities, declared));
}

function inconsistentAppPart(e, problems) {
  return e.json(500, {
    a2app: true,
    ok: false,
    code: "inconsistent_app_part",
    message: "The app's declarations are inconsistent and cannot be served.",
    problems: problems,
  });
}

/* ---------------------------------------------------------------- access */

/*
 * Who is calling, decided in the order spec/v0_2/auth.md §9 gives — the same
 * for PocketBase's own routes (`nativeGate`) and the adapter's (`authorize`):
 *
 *   host        a loopback name, or the host of A2APP_PUBLIC_URL. A page on
 *               evil.com whose DNS re-resolves to 127.0.0.1 is same-origin as
 *               far as the browser knows and sends no Origin on a GET; its
 *               Host header still says evil.com.
 *   origin      a foreign browser origin is refused.
 *   credential  X-A2App-Token, found by its SHA-256: unknown, revoked (or its
 *               task is over), expired, then whether its person may still act.
 *               It reaches its own scopes ∩ what its person may do now.
 *   session     multi-user: the account behind the session cookie, and a
 *               change must carry the app's own Origin (CSRF). Single-user:
 *               the app's own View, as the owner.
 *   nothing     single-user reads proceed as the owner; anything else is 401,
 *               `sign_in_required` when it came from the app's own page.
 *
 * What a principal may do — `permissionsOf` in operations.js, `*` by default —
 * is read on every request, never cached across requests. While operations.js
 * cannot load, nothing that depends on it is served (503 app_code_unavailable).
 */

/** What one request's access decision reads: the mode, the app code, and every
 *  scope the app declares (what `*` means). */
function accessEnv() {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  return {
    multiUser: isMultiUser(),
    code: appCode(),
    declared: rules.declaredScopes(entityNames(), readDeclaredOperations().map((o) => o.name)),
  };
}

function isMultiUser() {
  const manifest = readManifest();
  return !!manifest && manifest.authMode === "multi-user";
}

/** The entities: the app's base collections (PocketBase's own start with `_`). */
function entityNames() {
  const out = [];
  const collections = $app.findAllCollections("base");
  for (let i = 0; i < collections.length; i++) if (collections[i].name.indexOf("_") !== 0) out.push(collections[i].name);
  return out;
}

function callCtx(credentialId, agentName, info) {
  return { credentialId: credentialId, agentName: agentName, principal: info.id, role: info.role };
}

/** What a principal may do now (spec §3), expanded; null when it may do
 *  nothing — an unknown principal, or an account that is not active. */
function permissions(info, env) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (!info || !info.active) return null;
  const granted = env.code.permissionsOf
    ? env.code.permissionsOf({ id: info.id, name: info.name, role: info.role, active: info.active })
    : ["*"];
  return rules.expandScopes(Array.isArray(granted) ? granted : [], env.declared);
}

/** The X-A2App-Token this request presents, or "". */
function presentedToken(e) {
  return header(e, "X-A2App-Token") || header(e, "X-LUI-Token");
}

/**
 * The credential this request presents, checked: null when none was presented,
 * `{ refusal }` when it cannot be used, else the caller it makes — with the
 * account it acts for (null for the owner) and its effective scopes.
 */
function credentialOf(e, env) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const token = presentedToken(e);
  if (token === "") return null;
  const db = $app.db();
  const grant = grantByTokenHash(db, $security.sha256(token));
  if (grant === null) {
    return { refusal: refusal(401, "credential_invalid", "This credential is not one this app issued.", { how: RENEW_HINT }) };
  }
  const nowMs = Date.now();
  const state = rules.grantRefusal(grant, grant.task === null ? null : loadTask(db, grant.task), nowMs);
  if (state === "credential_revoked") return { refusal: refusal(401, state, "This credential was revoked.", { how: RENEW_HINT }) };
  if (state === "token_expired") {
    return { refusal: refusal(401, state, `This credential expired at ${grant.expiresAt}.`, { how: RENEW_HINT }) };
  }
  if (env.code.problem !== null) return { refusal: codeUnavailable(env.code.problem) };
  const account = grant.principal !== OWNER && env.multiUser ? accountById(grant.principal) : null;
  const info = grant.principal === OWNER ? OWNER_INFO : account ? infoOf(account) : null;
  const allowed = permissions(info, env);
  if (allowed === null) {
    return { refusal: refusal(401, "principal_inactive", "The person this credential acts for is no longer active.") };
  }
  if (rules.lastUsedDue(grant, nowMs)) {
    grant.lastUsedAt = new Date(nowMs).toISOString();
    putGrant(db, grant);
  }
  return {
    ctx: callCtx(grant.credentialId, grant.agentName, info),
    held: rules.intersectScopes(rules.expandScopes(grant.scopes, env.declared), allowed),
    grant: grant,
    account: account,
  };
}

/** The signed-in account behind this request's session cookie, if it is still
 *  active (a deactivated account's sessions stop on its next request). */
function sessionOf(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const secret = rules.parseCookies(header(e, "Cookie"))[sessionCookieName()];
  if (!secret) return null;
  const db = $app.db();
  const key = $security.sha256(secret);
  const session = rowBody(db, "_a2app_sessions", key);
  if (session === null) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    deleteRow(db, "_a2app_sessions", key);
    return null;
  }
  const account = accountById(session.principal);
  return account && account.getBool("active") ? { key: key, account: account } : null;
}

/**
 * The caller, or `{ refusal }`. `held` is the caller's effective scopes, or
 * "anonymous" for an uncredentialled read on a single-user app, which the scope
 * check does not apply to. `account` is the `users` record it acts for.
 */
function resolve(e, isWrite, env) {
  if (originOf(e) === "foreign") return { refusal: FOREIGN_ORIGIN };
  const presented = credentialOf(e, env);
  if (presented !== null) return presented;
  if (env.multiUser) {
    const session = sessionOf(e);
    if (session === null) return { refusal: unauthenticated(e, true, "This app needs a credential.") };
    if (isWrite && originOf(e) !== "own") return { refusal: CROSS_SITE_CHANGE };
    if (env.code.problem !== null) return { refusal: codeUnavailable(env.code.problem) };
    const info = infoOf(session.account);
    return { ctx: callCtx("session", null, info), held: permissions(info, env) || [], grant: null, account: session.account };
  }
  // The app's own View is trusted as the owner. A browser sends Origin only on
  // a change; on a read it marks the request with Sec-Fetch-Site, which a web
  // page cannot forge. A local program can, but on this mode it already reads
  // everything without a credential, so only a change needs the Origin.
  if (originOf(e) === "own" || (!isWrite && fromOwnPage(e))) {
    if (env.code.problem !== null) return { refusal: codeUnavailable(env.code.problem) };
    return { ctx: callCtx("ui", null, OWNER_INFO), held: permissions(OWNER_INFO, env) || [], grant: null, account: null };
  }
  if (isWrite) return { refusal: unauthenticated(e, false, "This write requires an agent credential.") };
  return { ctx: callCtx("anonymous", null, OWNER_INFO), held: "anonymous", grant: null, account: null };
}

/**
 * The adapter's routes: host, then the caller, then the scope. Returns the
 * call context `{ credentialId, agentName, principal, role }`, or null once the
 * refusal has been written — the caller must then return without writing
 * anything else. (`e.json` returns nothing to pass along, so a refusal cannot
 * be handed back as a value.)
 */
function authorize(e, opts) {
  const caller = callerOf(e, opts.isWrite);
  if (caller === null) return null;
  if (opts.scope && caller.held !== "anonymous" && caller.held.indexOf(opts.scope) === -1) return deny(e, insufficientScope(opts.scope));
  return caller.ctx;
}

/** Host, then the caller: what `resolve` found (`{ ctx, held, grant, account }`),
 *  or null once the refusal has been written. The task routes read the grant
 *  as well as the context, since a task credential reaches only its own task. */
function callerOf(e, isWrite) {
  const hostRefusal = refuseHost(e);
  if (hostRefusal) return deny(e, hostRefusal);
  const caller = resolve(e, isWrite, accessEnv());
  return caller.refusal ? deny(e, caller.refusal) : caller;
}

/**
 * The caller as a manager of accounts and credentials (spec §2.4): a signed-in
 * person, the app's own View on a single-user app, or the admin credential —
 * never an agent's delegated credential. `{ principal, role }`, or null once
 * the refusal has been written.
 */
function managerOf(e, write) {
  const env = accessEnv();
  const caller = resolve(e, write, env);
  if (caller.refusal) return deny(e, caller.refusal);
  if (caller.grant) {
    if (!caller.grant.admin) return deny(e, refusal(403, "not_a_manager", "An agent's credential cannot manage accounts or credentials."));
    return { principal: OWNER, role: "owner" };
  }
  if (caller.ctx.credentialId === "anonymous") return deny(e, unauthenticated(e, env.multiUser, "Managing this app needs a credential."));
  return { principal: caller.ctx.principal, role: caller.ctx.role };
}

/**
 * The same rule in front of PocketBase's OWN routes — records, realtime, file
 * downloads, batch — which never pass through `authorize`. PocketBase serves
 * those itself and decides what each caller sees with collection rules
 * evaluated against `e.auth`, so this is where the caller becomes `e.auth`:
 *
 *   an account (its session, or a credential acting for it)
 *               that `users` record — the collection rules decide what it sees;
 *   the owner (the admin credential, or one minted for `owner`)
 *               the app's superuser, the one pb-serve.mjs ensures from
 *               `.superuser`: the owner sees everything;
 *   the single-user View, an anonymous single-user read
 *               nobody, as before: the starter's rules are public there.
 *
 * Before that, the caller's scopes are enforced here, as they are on every
 * adapter route: `data:<collection>:read` for record and file reads,
 * `data:<collection>:write` for record writes and for every request in a
 * batch. Realtime is for signed-in people, not agent credentials: its
 * subscriptions are not per-scope. A signed-in superuser — the PocketBase
 * dashboard, by its own Authorization header — passes as itself. Auth
 * endpoints carry their own credentials and only get the host and origin
 * checks; the accounts migration turns off sign-in on `users`, so the
 * adapter's session is the only way in.
 *
 * The adapter's own routes get the host and origin checks here too (identity
 * and describe would otherwise answer a rebound Host); their handlers decide
 * the caller with `authorize`. The static View passes untouched.
 *
 * This middleware wraps the whole request, so a realtime connection holds a
 * hook runtime for as long as it is open; pb-serve.mjs sizes the pool for it.
 */
function nativeGate(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const method = String(e.request.method || "GET").toUpperCase();
  if (method === "OPTIONS") return e.next(); // CORS preflight: --origins answers it
  const path = String(e.request.url.path || "");
  let kind = null;
  if (RECORDS_PATH.test(path)) kind = method === "GET" || method === "HEAD" ? "read" : "write";
  else if (path === "/api/realtime") kind = "realtime";
  else if (path.indexOf("/api/files/") === 0) kind = "read";
  else if (path === "/api/batch") kind = "write";
  else if (path.indexOf("/api/collections/") === 0) kind = "auth";
  else if (path === "/api/_a2app" || path.indexOf("/api/_a2app/") === 0 || path.indexOf("/api/ops/") === 0 || path === rules.AUTH.ACCOUNT_URL) kind = "adapter";
  if (kind === null) return e.next();

  const early = refuseHost(e) || (originOf(e) === "foreign" ? FOREIGN_ORIGIN : null);
  if (early) return failWith(e, early);
  if (kind === "adapter" || kind === "auth") return e.next();

  if (presentedToken(e) === "" && e.hasSuperuserAuth()) {
    e.set(DASHBOARD, true);
    return e.next();
  }

  const caller = resolve(e, kind === "write", accessEnv());
  if (caller.refusal) return failWith(e, caller.refusal);
  if (kind === "realtime" && caller.grant) {
    return failWith(e, refusal(403, "insufficient_scope", "Realtime is for signed-in people: an agent credential reads records through the records API, where its scopes apply."));
  }
  if (caller.held !== "anonymous") {
    const needed = requiredScopes(e, kind, path);
    for (let i = 0; i < needed.length; i++) if (caller.held.indexOf(needed[i]) === -1) return failWith(e, insufficientScope(needed[i]));
  }
  if (caller.account) {
    e.auth = caller.account;
  } else if (caller.grant) {
    const superuser = ownerAuth();
    if (superuser === null) {
      return fail(e, 503, "owner_unavailable", "The app's superuser (.superuser) cannot be found, so a credential acting for the owner cannot be served.");
    }
    e.auth = superuser;
  }
  return e.next();
}

const RECORDS_PATH = /^\/api\/collections\/([^/]+)\/records(\/|$)/;

/** The scopes a request to PocketBase's own routes needs. A collection that
 *  does not exist needs none: PocketBase answers it with a 404. */
function requiredScopes(e, kind, path) {
  const scopes = [];
  const need = (idOrName, access) => {
    const name = collectionName(idOrName);
    if (name !== null) scopes.push(`data:${name}:${access}`);
  };
  const records = path.match(RECORDS_PATH);
  const file = path.match(/^\/api\/files\/([^/]+)\//);
  if (records) need(records[1], kind === "write" ? "write" : "read");
  else if (file) need(file[1], "read");
  else if (path === "/api/batch") {
    const requests = bodyOf(e).requests;
    for (let i = 0; Array.isArray(requests) && i < requests.length; i++) {
      const url = String((requests[i] && requests[i].url) || "").split("?")[0];
      const sub = url.match(RECORDS_PATH);
      if (sub) need(sub[1], "write");
    }
  }
  return scopes;
}

/** A collection's name from the id or name a route was given, or null. */
function collectionName(idOrName) {
  try {
    return $app.findCachedCollectionByNameOrId(idOrName).name;
  } catch (_missing) {
    return null;
  }
}

/** The superuser pb-serve.mjs ensures from `.superuser`: who the owner is to
 *  PocketBase's collection rules. */
function ownerAuth() {
  try {
    const su = JSON.parse(toString($os.readFile(`${__hooks}/../../.superuser`)));
    return $app.findAuthRecordByEmail("_superusers", String(su.email));
  } catch (_missing) {
    return null;
  }
}

const FOREIGN_ORIGIN = { status: 403, code: "forbidden_origin", message: "Refused: request Origin is not this app's own.", extra: {} };
/** A signed-in change must come from this app's own page (CSRF, spec §4). */
const CROSS_SITE_CHANGE = { status: 403, code: "forbidden_origin", message: "A signed-in change must come from this app's own page.", extra: {} };

function refusal(status, code, message, extra) {
  return { status: status, code: code, message: message, extra: extra || {} };
}

function insufficientScope(scope) {
  return refusal(403, "insufficient_scope", `This credential does not hold ${scope}.`, { required: scope });
}

function codeUnavailable(problem) {
  return refusal(503, "app_code_unavailable", `Requests are paused (app_code_unavailable): pb/pb_hooks/operations.js could not be loaded (${problem}).`);
}

/** No usable caller: from the app's own page on a multi-user app, the person is
 *  asked to sign in; anything else is told how to get a credential. */
function unauthenticated(e, multiUser, message) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (multiUser && fromOwnPage(e)) {
    return refusal(401, "sign_in_required", "Sign in to use this app.", { signInUrl: `${rules.AUTH.ACCOUNT_URL}#sign-in` });
  }
  return refusal(401, "agent_token_required", message, { how: CREDENTIAL_HINT });
}

/** Whether a request came from one of the app's own pages. Only ever used to
 *  pick which 401 to send, and on a single-user app to trust a View read —
 *  a browser marks same-origin fetches, GETs included, with Sec-Fetch-Site. */
function fromOwnPage(e) {
  return originOf(e) === "own" || header(e, "Sec-Fetch-Site") === "same-origin";
}

/** A refusal if the Host is not one this app answers to, else null: a loopback
 *  name, or the host of A2APP_PUBLIC_URL. */
function refuseHost(e) {
  const host = String(e.request.host || "").toLowerCase();
  const name = hostnameOf(host);
  const pub = publicOrigin();
  if (isLoopbackName(name) || (pub !== "" && name === hostnameOf(pub.slice(pub.indexOf("//") + 2)))) return null;
  return refusal(403, "forbidden_host", `Refused: this app answers only on its own host, not "${host}".`);
}

/** "none" (a program, or a same-origin GET), "own" (this app's View) or "foreign".
 *  The View is reached on loopback (`http://<Host>`) or at the public URL. */
function originOf(e) {
  const origin = header(e, "Origin").toLowerCase();
  if (origin === "") return "none";
  const host = String(e.request.host || "").toLowerCase();
  if (origin === publicOrigin()) return "own";
  return isLoopbackName(hostnameOf(host)) && origin === `http://${host}` ? "own" : "foreign";
}

/** The origin people and agents reach the app at, normalized by pb-serve.mjs
 *  (which refuses an unsafe one before PocketBase starts), or "". */
function publicOrigin() {
  return String($os.getenv("A2APP_PUBLIC_URL") || "").toLowerCase();
}

/** Where this app is reached, for links handed to a person (an invite, a device
 *  approval). The Host header has passed the host check by now. */
function publicLink(e) {
  return publicOrigin() || `http://${String(e.request.host || "")}`;
}

/** The host name in a Host value: `name`, `name:port`, or `[v6]:port`. */
function hostnameOf(host) {
  return host.indexOf("[") === 0 ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

function isLoopbackName(name) {
  if (name === "localhost" || name === "[::1]") return true;
  const parts = name.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (parts[i] === "" || !Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function failWith(e, r) {
  return fail(e, r.status, r.code, r.message, r.extra);
}

/** Write a refusal and return null, which tells the caller to stop. */
function deny(e, r) {
  failWith(e, r);
  return null;
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

/* Keyed tables — sessions, invites, device requests — hold one JSON body per
 * key, the key being the SHA-256 of the secret that finds the row. `table` is
 * always one of the names in ensureStore, never caller input. */

function rowBody(db, table, key) {
  const found = rows(db, `SELECT body FROM ${table} WHERE key = {:key}`, { key: key }, { body: "" });
  return found.length ? JSON.parse(found[0].body) : null;
}

function putRowBody(db, table, key, body) {
  db.newQuery(`INSERT OR REPLACE INTO ${table} (key, body) VALUES ({:key}, {:body})`).bind({ key: key, body: JSON.stringify(body) }).execute();
}

/** Delete one row; returns how many went, so a single-use row is used once. */
function deleteRow(db, table, key) {
  return db.newQuery(`DELETE FROM ${table} WHERE key = {:key}`).bind({ key: key }).execute().rowsAffected();
}

function allRows(db, table) {
  const found = rows(db, `SELECT key, body FROM ${table}`, {}, { key: "", body: "" });
  const out = [];
  for (let i = 0; i < found.length; i++) out.push({ key: found[i].key, body: JSON.parse(found[i].body) });
  return out;
}

/* Grants (spec/v0_2/auth.md §2.1): one row per credential, found by the hex
 * SHA-256 of its token. No token is ever stored. */

function grantByTokenHash(db, tokenHash) {
  const found = rows(db, "SELECT body FROM _a2app_grants WHERE token_hash = {:hash}", { hash: tokenHash }, { body: "" });
  return found.length ? JSON.parse(found[0].body) : null;
}

function grantById(db, credentialId) {
  const found = rows(db, "SELECT body FROM _a2app_grants WHERE credential_id = {:id}", { id: credentialId }, { body: "" });
  return found.length ? JSON.parse(found[0].body) : null;
}

function putGrant(db, grant) {
  db.newQuery("INSERT OR REPLACE INTO _a2app_grants (credential_id, token_hash, body) VALUES ({:id}, {:hash}, {:body})")
    .bind({ id: grant.credentialId, hash: grant.tokenHash, body: JSON.stringify(grant) })
    .execute();
}

function deleteGrant(db, credentialId) {
  db.newQuery("DELETE FROM _a2app_grants WHERE credential_id = {:id}").bind({ id: credentialId }).execute();
}

function listGrants(db) {
  const found = rows(db, "SELECT body FROM _a2app_grants", {}, { body: "" });
  const out = [];
  for (let i = 0; i < found.length; i++) out.push(JSON.parse(found[i].body));
  return out;
}

/** 256 random bits, base64url (43 characters): a token, session, invite or
 *  device code. Returned once; only its SHA-256 is kept. */
function newSecret() {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  return $security.randomStringWithAlphabet(42, rules.SECRET_ALPHABET) + $security.randomStringWithAlphabet(1, rules.SECRET_LAST_ALPHABET);
}

/** `XXXX-XXXX` from the user-code alphabet: a device request's user code, or
 *  the confirmation code its approval issues. */
function newUserCode() {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  return rules.formatUserCode($security.randomStringWithAlphabet(8, rules.USER_CODE_ALPHABET));
}

/** An id that is not a secret: `prefix_` + 64 random bits, hex. */
function newId(prefix) {
  return `${prefix}_${$security.randomStringWithAlphabet(16, "0123456789abcdef")}`;
}

/**
 * Issue a credential (spec §2): a token returned once, its SHA-256 stored, bound
 * to one principal, always expiring. `input` is { principal, agentName, scopes,
 * expiresInSeconds, task? }. Every credential this app issues is made here.
 */
function mintCredential(db, input) {
  const token = "a2a_" + newSecret();
  const nowMs = Date.now();
  const grant = {
    credentialId: newId("cred"),
    tokenHash: $security.sha256(token),
    principal: input.principal,
    agentName: input.agentName,
    scopes: input.scopes,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + input.expiresInSeconds * 1000).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    task: input.task || null,
    admin: false,
  };
  putGrant(db, grant);
  return { token: token, grant: grant };
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
 * agent. The same occurrence (type, capability, payload, who asked) joins its
 * task while that task is open; once it is completed, failed or canceled, it
 * queues a new one. `principal` is who asked (spec/v0_2/auth.md §6.1): the
 * caller of the operation that fires it, null for work the app queues on its
 * own; the agent that takes the task acts as them. `app` is the app (or the
 * transaction) to write through; `env` is what `triggerEnv()` read, so a runner
 * that fires many times reads it once.
 */
function triggerWith(app, env, type, payload, capability, principal) {
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
    const dedup = "sha256:" + $security.sha256(rules.occurrenceText(type, capability, plain, principal));
    const existing = rows(db, "SELECT id, status FROM _a2app_tasks WHERE dedup = {:dedup}", { dedup: dedup }, { id: "", status: "" });
    if (existing.length && rules.OPEN_TASK.indexOf(existing[0].status) !== -1) {
      taskId = existing[0].id;
    } else {
      // A finished task gives its key up to the new one: the key is unique,
      // and it is the open task a repeated request joins.
      if (existing.length) {
        db.newQuery("UPDATE _a2app_tasks SET dedup = NULL WHERE id = {:id}").bind({ id: existing[0].id }).execute();
      }
      const task = rules.newTask({
        id: "tsk_" + $security.randomStringWithAlphabet(16, hex),
        app: appId, event: event.id, capability: capability, payload: plain, principal: principal, dedupKey: dedup, now: now,
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
 *  an operation, use the `a2app.trigger` the runner is handed instead. Work
 *  queued this way is the app's own: nobody asked for it, so it runs as the
 *  owner.
 *
 *  It runs in a transaction of its own, so the event and its task land together
 *  or not at all. Code already inside a transaction passes it as `txApp`:
 *  opening a second one there would wait forever on the first, because
 *  PocketBase writes through a single connection. */
function trigger(type, payload, capability, txApp) {
  if (txApp) return triggerWith(txApp, triggerEnv(), type, payload, capability, null);
  let fired = null;
  $app.runInTransaction((tx) => {
    fired = triggerWith(tx, triggerEnv(), type, payload, capability, null);
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

  const ctx = authorize(e, { scope: `op:${name}`, isWrite: decl.readOnly !== true });
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

  // Idempotency, as adapter-core: a retried call carrying a key that already
  // ran is a 409, not a second run. Checked before approval so a replay never
  // mints a key; checked again inside the run's transaction, where it counts.
  const idemKey = header(e, "Idempotency-Key");
  const idemScope = `op:${name}`;
  if (idemKey !== "" && idempotencySeen($app.db(), idemScope, idemKey)) return duplicateRequest(e, name);

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
  let duplicate = false;
  try {
    $app.runInTransaction((tx) => {
      if (idemKey !== "") {
        if (idempotencySeen(tx.db(), idemScope, idemKey)) {
          duplicate = true;
          return;
        }
        tx.db().newQuery("DELETE FROM _a2app_idempotency WHERE created < {:cutoff}")
          .bind({ cutoff: Date.now() - IDEMPOTENCY_TTL_MS })
          .execute();
        tx.db().newQuery("INSERT INTO _a2app_idempotency (scope, key, created) VALUES ({:scope}, {:key}, {:now})")
          .bind({ scope: idemScope, key: idemKey, now: Date.now() })
          .execute();
      }
      const a2app = {
        app: tx,
        // The caller is who asked for the work, so the agent that takes the
        // task acts as them (spec/v0_2/auth.md §6).
        trigger: (type, payload, capability) => triggerWith(tx, env, type, payload, capability, ctx.principal),
        task: (id) => {
          const found = loadTask(tx.db(), String(id));
          if (!found) return null;
          // A claim abandoned since the last poll is settled here, so a dead
          // run is not reported as open. (sweep() would open a second
          // transaction and wait on this one forever.)
          const swept = rules.sweepTask(found, Date.now(), rules.QUEUE.TASK_TIMEOUT_MS, rules.QUEUE.TASK_MAX_DELIVERIES);
          if (swept) saveTask(tx.db(), swept);
          return rules.taskWire(swept || found);
        },
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
  if (duplicate) return duplicateRequest(e, name);
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

/** How long an operation's Idempotency-Key is remembered. A retry comes within
 *  seconds; a day covers a harness that retries after being restarted. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function idempotencySeen(db, scope, key) {
  return rows(db, "SELECT key FROM _a2app_idempotency WHERE scope = {:scope} AND key = {:key}", { scope: scope, key: key }, { key: "" }).length > 0;
}

function duplicateRequest(e, name) {
  return fail(e, 409, "duplicate_request", "This idempotency key already ran this operation.", { operation: name });
}

/** What a runner throws to refuse with its own status and code:
 *  `throw a2app.error(409, "already_done", "That task is already done.")`. */
function operationError(status, code, message, extra) {
  return { a2appOperationError: true, status: status, code: code, message: message, extra: extra || {} };
}

/* ----------------------------------------------------------------- tasks */

/*
 * A task holds who asked and what was asked and answered, so it is reached like
 * a record (spec/v0_2/auth.md §6.3): an owner reaches every task, a task
 * credential its own, anyone else the tasks they queued (`rules.reachesTask`).
 * A task out of reach is left out of the list and answers as one that does not
 * exist: its existence is itself something the caller may not learn.
 */

function taskNotFound(e, id) {
  return fail(e, 404, "task_not_found", `No task "${id}".`);
}

/** GET /api/_a2app/tasks[?status=] */
function listTasks(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const caller = callerOf(e, false);
  if (caller === null) return;
  sweep($app);
  const status = queryParam(e, "status");
  const found = status
    ? rows($app.db(), "SELECT body FROM _a2app_tasks WHERE status = {:status} ORDER BY seq", { status: status }, { body: "" })
    : rows($app.db(), "SELECT body FROM _a2app_tasks ORDER BY seq", {}, { body: "" });
  const tasks = [];
  for (let i = 0; i < found.length; i++) {
    const task = JSON.parse(found[i].body);
    if (rules.reachesTask(task, caller.ctx, caller.grant)) tasks.push(rules.taskWire(task));
  }
  return e.json(200, { a2app: true, tasks: tasks, pollAfterMs: rules.QUEUE.POLL_AFTER_MS });
}

/** GET /api/_a2app/tasks/{id} */
function getTask(e, id) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const caller = callerOf(e, false);
  if (caller === null) return;
  sweep($app);
  const task = loadTask($app.db(), id);
  if (!task || !rules.reachesTask(task, caller.ctx, caller.grant)) return taskNotFound(e, id);
  return e.json(200, rules.taskWire(task));
}

/** POST /api/_a2app/tasks/{id}/{claim|progress|complete|cancel|credential} */
function taskAction(e, id, action) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const caller = callerOf(e, true);
  if (caller === null) return;
  sweep($app);
  const body = bodyOf(e);
  if (action === "credential") return taskCredential(e, id, body, caller);
  let outcome = null;
  $app.runInTransaction((tx) => {
    const task = loadTask(tx.db(), id);
    if (!task || !rules.reachesTask(task, caller.ctx, caller.grant)) return;
    outcome = rules.applyTaskAction(task, action, body, caller.ctx, new Date().toISOString(), caller.grant);
    if (outcome.task) saveTask(tx.db(), outcome.task);
  });
  if (outcome === null) return taskNotFound(e, id);
  if (outcome.error) return fail(e, outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.extra);
  return e.json(200, rules.taskWire(outcome.task));
}

/**
 * POST /api/_a2app/tasks/{id}/credential — what the bridge runs the task's
 * harness with (spec/v0_2/auth.md §6.2): a credential for the person who
 * queued the task, holding the scopes the app declares its capability needs
 * (`capabilities` in operations.js, else `*`) and always limited by what that
 * person may do; an hour at most, and dead once the task ends.
 */
function taskCredential(e, id, body, caller) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const task = loadTask($app.db(), id);
  if (!task || !rules.reachesTask(task, caller.ctx, caller.grant)) return taskNotFound(e, id);
  const manager = managerOf(e, true);
  if (manager === null) return;
  if (manager.role !== "owner") return fail(e, 403, "not_a_manager", "Only an owner issues a task's credential.");
  if (rules.TERMINAL.indexOf(task.status) !== -1) {
    return fail(e, 409, "task_not_claimable", `Task ${id} already reached ${task.status}.`);
  }
  const principal = task.request.principal || OWNER;
  const info = principalInfo(principal);
  if (!info || !info.active) return fail(e, 401, "principal_inactive", "The person who queued this task is no longer active.");
  const agentName = rules.parseAgentName(body.agentName);
  if (agentName !== null && typeof agentName === "object") return fail(e, 400, "usage", agentName.problem);
  const env = accessEnv();
  const problems = rules.capabilityProblems(env.code.capabilities, env.declared);
  if (problems.length > 0) return inconsistentAppPart(e, problems);
  const minted = mintCredential($app.db(), {
    principal: principal,
    agentName: agentName,
    scopes: rules.capabilityScopes(env.code.capabilities, task.request.capability),
    expiresInSeconds: rules.AUTH.TASK_CREDENTIAL_SECONDS,
    task: task.id,
  });
  return e.json(201, { a2app: true, token: minted.token, credential: rules.credentialWire(minted.grant, info.name) });
}

/* ---------------------------------------------------------------- events */

/** GET /api/_a2app/events[?since=<cursor>] */
function listEvents(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (authorize(e, { scope: null, isWrite: false }) === null) return;
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
  if (authorize(e, { scope: null, isWrite: false }) === null) return;
  return e.json(200, { a2app: true, view: null, selected: [] });
}

/** Anything but POST on an operation: say how it is invoked, rather than
 *  leaving the router's bare 405 or the View's index page to answer. */
function operationMethod(e) {
  return fail(e, 405, "usage", "Operations are POST-only.");
}

/* ---------------------------------------------------------------- whoami */

/**
 * GET /api/_a2app/whoami — who this app will serve this caller as, asking the
 * same question `authorize` asks: the credential, its person, until when, and
 * its effective scopes. An anonymous read on a single-user app was never
 * scope-checked, so it reports what it may actually do there: read, and run
 * read-only operations.
 */
function whoami(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const env = accessEnv();
  const caller = resolve(e, false, env);
  if (caller.refusal) return failWith(e, caller.refusal);
  let scopes = caller.held;
  if (scopes === "anonymous") {
    const reads = entityNames().map((name) => `data:${name}:read`);
    const ops = readDeclaredOperations().filter((o) => o.readOnly === true).map((o) => `op:${o.name}`);
    scopes = reads.concat(ops);
  }
  const info = caller.ctx.principal === OWNER ? OWNER_INFO : caller.account ? infoOf(caller.account) : null;
  return e.json(200, {
    a2app: true,
    credentialId: caller.ctx.credentialId,
    agentName: caller.ctx.agentName,
    principal: caller.ctx.principal,
    principalName: info ? info.name : null,
    role: caller.ctx.role,
    expiresAt: caller.grant ? caller.grant.expiresAt : null,
    scopes: scopes.slice().sort(),
  });
}

/* -------------------------------------------------------------- accounts */

/*
 * Accounts, sessions and invites on a multi-user app (spec/v0_2/auth.md §4):
 *
 *   GET/POST/DELETE /api/_a2app/session        who is signed in · sign in · sign out
 *   POST /api/_a2app/invites                    a one-time setup link (owner manager)
 *   GET/POST /api/_a2app/invites/{code}         read · accept (creates the account)
 *   GET /api/_a2app/users                       every account (owner manager)
 *   PATCH /api/_a2app/users/{id}                activate/deactivate, change role
 *
 * An account is a record of PocketBase's `users` collection — so collection
 * rules can say `@request.auth.id` and `@request.auth.role` — which the
 * accounts migration locks: no rule lets anyone list, create or change one, and
 * PocketBase's own sign-in is off. These routes are the only way in.
 *
 * Passwords use that collection's password field. bcrypt reads at most 72
 * bytes and a password may be 256 characters, so the field holds the bcrypt of
 * the password's SHA-256 (`passwordKey`).
 */

function notMultiUser(e) {
  return fail(e, 404, "not_multi_user", "This app has no accounts: its authMode is none.");
}

function sessionCookieName() {
  const manifest = readManifest();
  return `a2app_session_${manifest && manifest.id ? manifest.id : ""}`;
}

/** Session cookies are `Secure` when the app is reached over https. */
function secureCookies() {
  return publicOrigin().indexOf("https:") === 0;
}

function passwordKey(password) {
  return $security.sha256(password);
}

function accountById(id) {
  try {
    return $app.findRecordById(ACCOUNTS, String(id));
  } catch (_missing) {
    return null;
  }
}

function accountByLogin(app, login) {
  try {
    return app.findFirstRecordByData(ACCOUNTS, "login", login);
  } catch (_missing) {
    return null;
  }
}

function infoOf(account) {
  return {
    id: account.id,
    name: account.getString("name"),
    role: account.getString("role") === "owner" ? "owner" : "member",
    active: account.getBool("active"),
  };
}

/** Who a principal is: `owner`, or an account on a multi-user app; null when
 *  it is unknown. */
function principalInfo(id) {
  if (id === OWNER) return OWNER_INFO;
  if (!isMultiUser()) return null;
  const account = accountById(id);
  return account ? infoOf(account) : null;
}

/** The account as served: never its password. */
function accountWire(account) {
  const created = String(account.getDateTime("created").string());
  return {
    id: account.id,
    name: account.getString("name"),
    login: account.getString("login"),
    role: account.getString("role"),
    active: account.getBool("active"),
    createdAt: created === "" ? null : created.replace(" ", "T"),
  };
}

/** Checked when a login does not exist, so a missing account takes as long to
 *  refuse as a wrong password and the timing does not say which. One unsaved
 *  record whose password was set once, shared by every hook runtime. */
function unknownAccount() {
  return $app.store().getOrSet("a2app.unknownAccount", () => {
    const record = new Record($app.findCollectionByNameOrId(ACCOUNTS));
    record.setPassword(passwordKey(newSecret()));
    return record;
  });
}

function startSession(e, account, status) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const secret = newSecret();
  const createdAt = Date.now();
  putRowBody($app.db(), "_a2app_sessions", $security.sha256(secret), {
    principal: account.id,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + rules.AUTH.SESSION_TTL_MS).toISOString(),
  });
  e.response.header().add("Set-Cookie", rules.sessionCookie(sessionCookieName(), secret, {
    maxAgeSeconds: rules.AUTH.SESSION_TTL_MS / 1000,
    secure: secureCookies(),
  }));
  return e.json(status, Object.assign({ a2app: true }, accountWire(account)));
}

/** GET/POST/DELETE /api/_a2app/session */
function session(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (!isMultiUser()) return notMultiUser(e);
  const method = String(e.request.method).toUpperCase();
  if (method === "GET") {
    const current = sessionOf(e);
    if (current === null) return fail(e, 401, "sign_in_required", "Not signed in.", { signInUrl: `${rules.AUTH.ACCOUNT_URL}#sign-in` });
    return e.json(200, Object.assign({ a2app: true }, accountWire(current.account)));
  }
  if (method === "DELETE") {
    const current = sessionOf(e);
    if (current !== null) deleteRow($app.db(), "_a2app_sessions", current.key);
    e.response.header().add("Set-Cookie", rules.sessionCookie(sessionCookieName(), "", { maxAgeSeconds: 0, secure: secureCookies() }));
    return e.json(200, { a2app: true, ok: true });
  }

  const body = bodyOf(e);
  if (typeof body.login !== "string" || typeof body.password !== "string") return fail(e, 400, "usage", "Sign in with { login, password }.");
  const login = rules.normalizeLogin(body.login);
  // Failures are counted per login in PocketBase's app store, which every
  // hook runtime shares; a restart forgets them, which costs an attacker
  // nothing they could not get by waiting out the window.
  const store = $app.store();
  const key = `a2app.signInFailures.${login}`;
  const windowOf = (raw) => (typeof raw === "string" && raw !== "" ? JSON.parse(raw) : null);
  const limit = rules.signInRetryAfter(windowOf(store.get(key)), Date.now());
  if (limit.lapsed) store.remove(key);
  if (limit.wait > 0) {
    return fail(e, 429, "rate_limited", "Too many failed sign-ins for this login. Try again later.", { retryAfterSeconds: limit.wait });
  }
  const account = accountByLogin($app, login);
  let matches = false;
  if (account) matches = account.validatePassword(passwordKey(body.password));
  else unknownAccount().validatePassword(passwordKey(body.password));
  if (!account || !matches || !account.getBool("active")) {
    store.setFunc(key, (old) => JSON.stringify(rules.signInFailed(windowOf(old), Date.now())));
    return fail(e, 401, "sign_in_failed", "That login and password do not match an active account.");
  }
  store.remove(key);
  return startSession(e, account, 200);
}

/** The invite behind a code, while it is still good. */
function liveInvite(code) {
  const db = $app.db();
  const key = $security.sha256(code);
  const invite = rowBody(db, "_a2app_invites", key);
  if (invite === null) return null;
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    deleteRow(db, "_a2app_invites", key);
    return null;
  }
  return { key: key, invite: invite };
}

/** POST /api/_a2app/invites — a one-time setup link (an owner manager). */
function createInvite(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (!isMultiUser()) return notMultiUser(e);
  const manager = managerOf(e, true);
  if (manager === null) return;
  if (manager.role !== "owner") return fail(e, 403, "not_a_manager", "Only an owner can invite people.");
  const body = bodyOf(e);
  const role = body.role === undefined || body.role === null ? "member" : body.role;
  if (role !== "owner" && role !== "member") return fail(e, 400, "usage", 'role is "owner" or "member".');
  const secret = newSecret();
  const createdAt = Date.now();
  const invite = { role: role, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + rules.AUTH.INVITE_TTL_MS).toISOString() };
  putRowBody($app.db(), "_a2app_invites", $security.sha256(secret), invite);
  return e.json(201, {
    a2app: true,
    code: secret,
    url: `${publicLink(e)}${rules.AUTH.ACCOUNT_URL}#setup/${secret}`,
    role: invite.role,
    expiresAt: invite.expiresAt,
  });
}

/** GET/POST /api/_a2app/invites/{code} — read an invite, or accept it. */
function invite(e, code) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (!isMultiUser()) return notMultiUser(e);
  const invalid = () => fail(e, 404, "invite_invalid", "This invite link is not valid: it was used, or it expired.");
  const found = liveInvite(code);
  if (found === null) return invalid();
  if (String(e.request.method).toUpperCase() === "GET") return e.json(200, { a2app: true, role: found.invite.role, expiresAt: found.invite.expiresAt });

  const body = bodyOf(e);
  const problem = rules.accountProblem(body);
  if (problem) return fail(e, 400, "usage", problem);
  const login = rules.normalizeLogin(body.login);
  if (accountByLogin($app, login)) return fail(e, 409, "login_taken", "That login is already in use.");
  const account = new Record($app.findCollectionByNameOrId(ACCOUNTS));
  account.set("name", body.name.trim());
  account.set("login", login);
  account.set("role", found.invite.role);
  account.set("active", true);
  account.setPassword(passwordKey(body.password));
  // Using the invite and creating the account are one step: a second
  // acceptance of the same invite, or a second account racing for the same
  // login, sees this one's result.
  let outcome = "created";
  try {
    $app.runInTransaction((tx) => {
      if (deleteRow(tx.db(), "_a2app_invites", found.key) !== 1) {
        outcome = "invite_invalid";
        return;
      }
      if (accountByLogin(tx, login)) {
        outcome = "login_taken";
        throw new Error("a2app: rolled back"); // keeps the invite for another try
      }
      tx.save(account);
    });
  } catch (err) {
    if (outcome === "created") throw err;
  }
  if (outcome === "invite_invalid") return invalid();
  if (outcome === "login_taken") return fail(e, 409, "login_taken", "That login is already in use.");
  return startSession(e, account, 201);
}

/** GET /api/_a2app/users, PATCH /api/_a2app/users/{id} (an owner manager). */
function users(e, id) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  if (!isMultiUser()) return notMultiUser(e);
  const method = String(e.request.method).toUpperCase();
  const manager = managerOf(e, method !== "GET");
  if (manager === null) return;
  if (manager.role !== "owner") return fail(e, 403, "not_a_manager", "Only an owner can manage people.");

  if (id === null) {
    const records = $app.findAllRecords(ACCOUNTS);
    const all = [];
    for (let i = 0; i < records.length; i++) all.push(accountWire(records[i]));
    all.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return e.json(200, { a2app: true, users: all });
  }
  const account = accountById(id);
  if (account === null) return fail(e, 404, "not_found", `No account "${id}".`);
  const body = bodyOf(e);
  if (body.active !== undefined && typeof body.active !== "boolean") return fail(e, 400, "usage", "active is true or false.");
  if (body.role !== undefined && body.role !== "owner" && body.role !== "member") return fail(e, 400, "usage", 'role is "owner" or "member".');
  const was = infoOf(account);
  const next = {
    role: body.role === "owner" || body.role === "member" ? body.role : was.role,
    active: typeof body.active === "boolean" ? body.active : was.active,
  };
  // Counted and changed in one transaction, so two owners demoting each other
  // at once cannot leave the app with none.
  let lastOwner = false;
  $app.runInTransaction((tx) => {
    const owners = tx.countRecords(ACCOUNTS, $dbx.hashExp({ role: "owner", active: true }));
    if (rules.losesLastOwner(was, next, owners)) {
      lastOwner = true;
      return;
    }
    account.set("role", next.role);
    account.set("active", next.active);
    tx.save(account);
  });
  if (lastOwner) return fail(e, 409, "last_owner", "This is the last active owner. Make someone else an owner first.");
  return e.json(200, Object.assign({ a2app: true }, accountWire(account)));
}

/* ----------------------------------------------------------- credentials */

/*
 * Delegated agent credentials (spec/v0_2/auth.md §2, §8):
 *
 *   GET /api/_a2app/credentials          a manager's own (an owner: everyone's)
 *   POST /api/_a2app/credentials         issue one; the token is in this reply only
 *   DELETE /api/_a2app/credentials/{id}  revoke (a manager, or the credential itself)
 */

/** GET /api/_a2app/credentials */
function listCredentials(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const manager = managerOf(e, false);
  if (manager === null) return;
  const db = $app.db();
  const nowMs = Date.now();
  const credentials = listGrants(db)
    .filter((g) => rules.grantLive(g, g.task === null ? null : loadTask(db, g.task), nowMs))
    .filter((g) => manager.role === "owner" || g.principal === manager.principal)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((g) => {
      const info = principalInfo(g.principal);
      return rules.credentialWire(g, info ? info.name : null);
    });
  return e.json(200, { a2app: true, credentials: credentials });
}

/** POST /api/_a2app/credentials */
function issueCredential(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const manager = managerOf(e, true);
  if (manager === null) return;
  const body = bodyOf(e);
  const principal = body.principal === undefined || body.principal === null ? manager.principal : body.principal;
  if (typeof principal !== "string") return fail(e, 400, "usage", 'principal is an account id (or "owner").');
  if (principal !== manager.principal && manager.role !== "owner") {
    return fail(e, 403, "not_a_manager", "Only an owner can issue a credential for someone else.");
  }
  const info = principalInfo(principal);
  if (!info || !info.active) return fail(e, 400, "usage", `"${principal}" is not an active account of this app.`);
  const agentName = rules.parseAgentName(body.agentName);
  if (agentName !== null && typeof agentName === "object") return fail(e, 400, "usage", agentName.problem);
  const parsed = rules.parseGrantRequest(body, accessEnv().declared);
  if (parsed.problem) return fail(e, 400, "usage", parsed.problem);
  const minted = mintCredential($app.db(), { principal: principal, agentName: agentName, scopes: parsed.scopes, expiresInSeconds: parsed.expiresInSeconds });
  return e.json(201, { a2app: true, token: minted.token, credential: rules.credentialWire(minted.grant, info.name) });
}

/** DELETE /api/_a2app/credentials/{id} */
function revokeCredential(e, id) {
  const db = $app.db();
  const grant = grantById(db, id);
  if (grant === null) return fail(e, 404, "not_found", `No credential "${id}".`);
  if (grant.admin) return fail(e, 403, "not_a_manager", "The admin credential is the app's .agent-token: rotate that file instead.");
  // A credential may always revoke itself — the one thing an agent may do
  // with credentials — so an agent can hand back access it no longer needs.
  const presented = credentialOf(e, accessEnv());
  const self = presented !== null && !presented.refusal && presented.grant.credentialId === id;
  if (!self) {
    const manager = managerOf(e, true);
    if (manager === null) return;
    if (manager.role !== "owner" && grant.principal !== manager.principal) return fail(e, 404, "not_found", `No credential "${id}".`);
  }
  if (grant.revokedAt === null) {
    grant.revokedAt = new Date().toISOString();
    putGrant(db, grant);
  }
  return e.json(200, { a2app: true, ok: true, revoked: id });
}

/* ------------------------------------------------------ device sign-in */

/*
 * Device-code sign-in for agents (spec/v0_2/auth.md §7, RFC 8628 shape):
 *
 *   POST /api/_a2app/auth/device               an agent asks; gets a code to show
 *   GET  /api/_a2app/auth/device/{userCode}     the person reviews (a manager)
 *   POST /api/_a2app/auth/device/{userCode}     the person approves or denies
 *   POST /api/_a2app/auth/token                 the agent polls; gets its credential
 *
 * The person approves on the app's own account page, signed in as themselves;
 * the credential issued acts for them, with the scopes they approved. Codes
 * live 10 minutes, are single use, and the device code is stored only as its
 * hash.
 *
 * Approving is not enough on its own: anyone can start a request and send the
 * person its link. So approval issues a one-time confirmation code (stored as
 * its hash), and the credential goes only to whoever presents it. An agent on
 * the person's own computer receives it on a loopback port (RFC 8252) when the
 * page returns the browser there; an agent elsewhere is given it by the person.
 */

/** Live requests by key, dropping the expired as it goes. */
function liveDevices(db) {
  const nowMs = Date.now();
  const out = [];
  const all = allRows(db, "_a2app_devices");
  for (let i = 0; i < all.length; i++) {
    if (Date.parse(all[i].body.expiresAt) <= nowMs) deleteRow(db, "_a2app_devices", all[i].key);
    else out.push(all[i]);
  }
  return out;
}

/** The pending request a person's typed code names, or null. */
function deviceByUserCode(db, input) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const code = rules.normalizeUserCode(input);
  if (code === "") return null;
  const live = liveDevices(db);
  for (let i = 0; i < live.length; i++) if (live[i].body.userCode === code && live[i].body.status === "pending") return live[i];
  return null;
}

/** POST /api/_a2app/auth/device {agentName?, scopes?, expiresIn?, loopbackPort?} */
function startDevice(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const body = bodyOf(e);
  const parsed = rules.parseGrantRequest(body, accessEnv().declared);
  if (parsed.problem) return fail(e, 400, "usage", parsed.problem);
  const agentName = body.agentName;
  if (agentName !== undefined && (typeof agentName !== "string" || agentName.trim() === "" || agentName.length > 100)) {
    return fail(e, 400, "usage", "agentName is 1–100 characters.");
  }
  const loopbackPort = rules.parseLoopbackPort(body.loopbackPort);
  if (loopbackPort !== null && typeof loopbackPort === "object") return fail(e, 400, "usage", loopbackPort.problem);
  const db = $app.db();
  const taken = liveDevices(db).map((d) => d.body.userCode);
  let userCode = newUserCode();
  while (taken.indexOf(userCode) !== -1) userCode = newUserCode();
  const deviceCode = newSecret();
  const nowMs = Date.now();
  putRowBody(db, "_a2app_devices", $security.sha256(deviceCode), {
    userCode: userCode,
    agentName: typeof agentName === "string" ? agentName.trim() : null,
    scopes: parsed.scopes,
    expiresInSeconds: parsed.expiresInSeconds,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + rules.AUTH.DEVICE_CODE_TTL_SECONDS * 1000).toISOString(),
    interval: rules.AUTH.DEVICE_POLL_INTERVAL_SECONDS,
    lastPolledAt: null,
    status: "pending",
    approvedBy: null,
    approvedScopes: null,
    // the 127.0.0.1 port the agent waits on, when it is on the person's computer
    loopbackPort: loopbackPort,
    // SHA-256 of the confirmation code issued at approval
    confirmationHash: null,
    confirmAttempts: 0,
  });
  const approve = `${publicLink(e)}${rules.AUTH.ACCOUNT_URL}#approve`;
  return e.json(200, {
    a2app: true,
    deviceCode: deviceCode,
    userCode: userCode,
    verificationUri: approve,
    verificationUriComplete: `${approve}/${userCode}`,
    expiresIn: rules.AUTH.DEVICE_CODE_TTL_SECONDS,
    interval: rules.AUTH.DEVICE_POLL_INTERVAL_SECONDS,
  });
}

/** GET /api/_a2app/auth/device/{userCode} — the person reviews the request. */
function reviewDevice(e, userCode) {
  const manager = managerOf(e, false);
  if (manager === null) return;
  const found = deviceByUserCode($app.db(), userCode);
  if (found === null) return fail(e, 404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.");
  const row = found.body;
  return e.json(200, {
    a2app: true,
    userCode: row.userCode,
    agentName: row.agentName,
    scopes: row.scopes,
    expiresIn: row.expiresInSeconds,
    expiresAt: row.expiresAt,
    requestedAt: row.createdAt,
    loopback: typeof row.loopbackPort === "number",
  });
}

/** POST /api/_a2app/auth/device/{userCode} {approve, scopes?} — the person decides. */
function decideDevice(e, userCode) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const manager = managerOf(e, true);
  if (manager === null) return;
  const db = $app.db();
  const found = deviceByUserCode(db, userCode);
  if (found === null) return fail(e, 404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.");
  const row = found.body;
  const body = bodyOf(e);
  if (typeof body.approve !== "boolean") return fail(e, 400, "usage", "Decide with { approve: true | false }.");
  if (!body.approve) {
    row.status = "denied";
    putRowBody(db, "_a2app_devices", found.key, row);
    return e.json(200, { a2app: true, ok: true, status: "denied" });
  }
  // The person may only narrow what was asked for.
  let scopes = row.scopes;
  if (body.scopes !== undefined) {
    const parsed = rules.parseGrantRequest({ scopes: body.scopes }, accessEnv().declared);
    if (parsed.problem) return fail(e, 400, "usage", parsed.problem);
    const wider = rules.widerThanAsked(row.scopes, parsed.scopes);
    if (wider.length > 0) return fail(e, 400, "usage", `Approval can only narrow what the agent asked for, not add ${wider.join(", ")}.`);
    scopes = parsed.scopes;
  }
  // Approval hands nothing over by itself: the credential goes only to a poll
  // presenting this code, which the page passes on (to the agent's loopback
  // port, or to the person to give their agent).
  const confirmation = newUserCode();
  row.status = "approved";
  row.approvedBy = manager.principal;
  row.approvedScopes = scopes;
  row.confirmationHash = $security.sha256(confirmation);
  putRowBody(db, "_a2app_devices", found.key, row);
  return e.json(200, { a2app: true, ok: true, status: "approved", confirmation: confirmation, redirect: rules.loopbackRedirect(row.loopbackPort, confirmation) });
}

/** POST /api/_a2app/auth/token {deviceCode, confirmation?} — the agent polls. */
function pollDevice(e) {
  const rules = require(`${__hooks}/_a2app_rules.js`);
  const body = bodyOf(e);
  const deviceCode = body.deviceCode;
  if (typeof deviceCode !== "string") return fail(e, 400, "usage", "Poll with { deviceCode }.");
  const key = $security.sha256(deviceCode);
  // The confirmation code as typed (any case, dash optional), by its hash.
  const confirmation = typeof body.confirmation === "string" ? rules.normalizeUserCode(body.confirmation) : "";
  const presented = confirmation === "" ? null : $security.sha256(confirmation);
  // Read, decide and write back in one transaction: of two polls at once, the
  // second sees the first's result, so an approved request issues once.
  let poll = null;
  let row = null;
  let issued = null;
  let inactive = false;
  $app.runInTransaction((tx) => {
    row = rowBody(tx.db(), "_a2app_devices", key);
    poll = rules.pollDevice(row, Date.now(), presented);
    if (poll.row === null) {
      if (row !== null) deleteRow(tx.db(), "_a2app_devices", key);
    } else {
      putRowBody(tx.db(), "_a2app_devices", key, poll.row);
    }
    if (poll.outcome !== "issue") return;
    const info = principalInfo(row.approvedBy);
    if (!info || !info.active) {
      inactive = true;
      return;
    }
    issued = mintCredential(tx.db(), { principal: row.approvedBy, agentName: row.agentName, scopes: row.approvedScopes, expiresInSeconds: row.expiresInSeconds });
    issued.principalName = info.name;
  });
  switch (poll.outcome) {
    case "expired":
      return fail(e, 400, "expired_token", "This sign-in request expired or was already used. Start again.");
    case "denied":
      return fail(e, 400, "access_denied", "The person declined this agent's request.");
    case "confirmation_required":
      return fail(e, 400, "confirmation_required", "Approved. Present the confirmation code the approval produced.", { interval: poll.row.interval });
    case "confirmation_invalid":
      return fail(e, 400, "confirmation_invalid", `That is not this request's confirmation code (${rules.AUTH.DEVICE_CONFIRM_ATTEMPTS - poll.row.confirmAttempts} tries left).`);
    case "void":
      return fail(e, 400, "access_denied", "Too many wrong confirmation codes: this request is void. Start again.");
    case "issue":
      if (inactive) return fail(e, 400, "access_denied", "The person who approved this is no longer active.");
      return e.json(200, { a2app: true, token: issued.token, credential: rules.credentialWire(issued.grant, issued.principalName) });
    case "slow_down":
      return fail(e, 400, "slow_down", `Polling too fast: wait ${poll.row.interval} s between polls.`, { interval: poll.row.interval });
    default:
      return fail(e, 400, "authorization_pending", "Waiting for the person to approve.", { interval: poll.row.interval });
  }
}

/* ------------------------------------------------------- account page */

/** GET /_a2app/account — the framework's account page (sign in, invites,
 *  people, the agents acting for you), the same file in every blueprint. */
function accountPage(e) {
  let page;
  try {
    page = toString($os.readFile(`${__hooks}/../../a2app-account.html`));
  } catch (_missing) {
    return fail(e, 404, "not_found", "This app ships no account page (a2app-account.html).");
  }
  return e.html(200, page);
}

module.exports = {
  identity: identity, describe: describe, guard: guard, deleteGuard: deleteGuard,
  nativeGate: nativeGate,
  ensureStore: ensureStore, runOperation: runOperation, trigger: trigger,
  listTasks: listTasks, getTask: getTask, taskAction: taskAction,
  listEvents: listEvents, context: context, operationMethod: operationMethod,
  whoami: whoami,
  session: session, createInvite: createInvite, invite: invite, users: users,
  listCredentials: listCredentials, issueCredential: issueCredential, revokeCredential: revokeCredential,
  startDevice: startDevice, reviewDevice: reviewDevice, decideDevice: decideDevice, pollDevice: pollDevice,
  accountPage: accountPage,
};
