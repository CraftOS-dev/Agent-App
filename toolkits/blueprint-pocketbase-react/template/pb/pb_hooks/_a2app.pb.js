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
  const entities = {};
  const collections = $app.dao().findCollectionsByType("base");
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (col.name.indexOf("_") === 0) continue; // skip system collections
    entities[col.name] = mapFields(col);
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

routerAdd("GET", "/api/_a2app/describe", (c) => {
  const rules = require(`${__hooks}/_a2app_rules.js`);

  const entities = {};
  const collections = $app.dao().findCollectionsByType("base");
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (col.name.indexOf("_") === 0) continue;
    const nf = mapFields(col);
    const fields = {};
    for (let j = 0; j < nf.length; j++) {
      const f = nf[j];
      const field = { type: f.type };
      if (f.required) field.required = true;
      if (f.readOnly) field.readOnly = true;
      if (f.values) field.values = f.values;
      if (f.dayKey) field.format = "YYYY-MM-DD";
      fields[f.name] = field;
    }
    entities[col.name] = {
      label: rules.labelField(nf),
      records: `/api/collections/${col.name}/records`,
      fields,
    };
  }

  // Declared operations mirror operations.json (kept in sync by the agent).
  let operations = [];
  try {
    operations = JSON.parse($os.readFile(`${__hooks}/../../operations.json`)).operations || [];
  } catch (_e) {
    operations = [];
  }

  return c.json(200, {
    entities,
    operations,
    conventions: {
      writes: "Prefer a declared operation over a raw write where one exists.",
      labels: "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
      dates: 'Relative words ("tomorrow") are rejected by the app; resolve them to ISO 8601 client-side.',
      honesty: "If the app cannot express what was asked, say so instead of approximating into a wrong field.",
    },
  });

  function mapFields(col) {
    const out = [];
    const fields = col.schema.fields();
    for (let j = 0; j < fields.length; j++) {
      const f = fields[j];
      const nf = { name: f.name, type: protocolType(f) };
      if (f.required) nf.required = true;
      if (f.type === "select" && f.options && f.options.values) nf.values = f.options.values;
      if (isDayKeyField(f)) nf.dayKey = true;
      out.push(nf);
    }
    return out;
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
