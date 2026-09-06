/**
 * A2App pure rules (SYSTEM-OWNED — hash-locked in the ownership canon).
 *
 * The guard rules ported to the PocketBase JS (Goja) runtime. They MUST match
 * `@a2app/rules` behavior on rejections; the conformance suite is the parity
 * oracle. Written as CommonJS so both Goja (`require`) and Node (for the gate
 * self-test: `node _a2app_rules.js --selftest`) load it. No PocketBase globals
 * here — this layer is pure.
 */
var RULES_VERSION = "0.1.0";
var MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  var mx = MONTH[m - 1];
  if (m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) mx = 29;
  return d <= mx;
}
function looksLikeDate(v) {
  if (typeof v !== "string") return false;
  var m = v.match(/^(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  return !!m && validYmd(+m[1], +m[2], +m[3]);
}
function isDayKey(v) {
  if (typeof v !== "string") return false;
  var m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return !!m && validYmd(+m[1], +m[2], +m[3]);
}
function blank(v) {
  return v === null || v === undefined || v === "";
}
function violation(code, field, expected, got) {
  return { code: code, field: field, expected: expected, got: got === undefined ? null : got };
}

/** Validate a RAW body against normalized fields; returns every violation. */
function validate(fields, body, allow) {
  allow = allow || {};
  var byName = {};
  var writable = [];
  for (var i = 0; i < fields.length; i++) {
    byName[fields[i].name] = fields[i];
    if (!fields[i].readOnly) writable.push(fields[i].name);
  }
  var out = [];
  for (var key in body) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (allow[key]) continue;
    var f = byName[key];
    var val = body[key];
    if (!f) { out.push(violation("unknown_field", key, "one of: " + writable.join(", "), val)); continue; }
    if (f.readOnly) { out.push(violation("read_only_field", key, "not writable (server-managed)", val)); continue; }
    if (blank(val)) continue;
    if (f.type === "datetime" && !looksLikeDate(val)) out.push(violation("invalid_date", key, "an ISO 8601 date", val));
    else if (f.dayKey && !isDayKey(val)) out.push(violation("invalid_daykey", key, 'a day key "YYYY-MM-DD"', val));
    else if (f.type === "string" && typeof val !== "string") out.push(violation("invalid_string", key, "text", val));
    else if (f.type === "number" && typeof val !== "number" && !(typeof val === "string" && val.trim() !== "" && !isNaN(Number(val)))) out.push(violation("invalid_number", key, "a number", val));
    else if (f.type === "boolean" && typeof val !== "boolean" && val !== "true" && val !== "false") out.push(violation("invalid_boolean", key, "true or false", val));
    else if (f.type === "enum" && f.values && f.values.length && f.values.map(String).indexOf(String(val)) === -1) out.push(violation("invalid_enum", key, "one of: " + f.values.join(" | "), val));
  }
  return out;
}

function labelField(fields) {
  var names = fields.map(function (f) { return f.name; });
  var pref = ["title", "name", "label"];
  for (var i = 0; i < pref.length; i++) if (names.indexOf(pref[i]) !== -1) return pref[i];
  for (var j = 0; j < fields.length; j++) if (fields[j].type === "string" && fields[j].required && !fields[j].readOnly) return fields[j].name;
  return null;
}

/** Every published attribute of a field, rendered deterministically. Must match
 *  `fieldPrint` in @a2app/rules: a client caches describe against this value and
 *  is told never to write against a stale schema, so narrowing an enum or
 *  tightening a max has to move the hash. */
function fieldPrint(f) {
  var parts = [f.name + ":" + f.type];
  if (f.required) parts.push("req");
  if (f.readOnly) parts.push("ro");
  if (f.writeOnly) parts.push("wo");
  if (f.dayKey) parts.push("day");
  if (typeof f.max === "number") parts.push("max=" + f.max);
  if (f.entity) parts.push("entity=" + f.entity);
  if (f.values && f.values.length) parts.push("values=" + f.values.slice().sort().join("|"));
  return parts.join(":");
}

/** JSON with object keys sorted at every depth, so declaration key order cannot
 *  move the hash. */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  var keys = Object.keys(value).sort();
  return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + stableJson(value[k]); }).join(",") + "}";
}

function operationPrint(o) {
  var flags = (o.destructive ? "d" : "") + (o.readOnly ? "r" : "") + (o.idempotent ? "i" : "");
  var parts = [flags ? o.name + ":" + flags : o.name];
  if (o.module) parts.push("mod=" + o.module);
  if (o.entity) parts.push("on=" + o.entity);
  if (o.params && Object.keys(o.params).length) parts.push("params=" + stableJson(o.params));
  if (o.appliesWhen) parts.push("when=" + stableJson(o.appliesWhen));
  return parts.join(":");
}

/** `entities` maps a name to {fields, module, auth?}. `module` is required for
 *  the same reason it is in @a2app/rules: an entity that could move between
 *  modules without moving the hash would leave caches placing it in the old one. */
function schemaVersion(entities, operations) {
  var parts = [];
  for (var name in entities) {
    if (!Object.prototype.hasOwnProperty.call(entities, name)) continue;
    var value = entities[name];
    var attrs = [name + "(" + value.fields.map(fieldPrint).sort().join(",") + ")"];
    if (value.auth) attrs.push("auth");
    attrs.push("mod=" + value.module);
    parts.push(attrs.join(":"));
  }
  parts.sort();
  var ops = (operations || []).map(operationPrint).sort();
  var joined = parts.join(";") + "|" + ops.join(",");
  var h = 5381;
  for (var k = 0; k < joined.length; k++) h = ((h * 33) ^ joined.charCodeAt(k)) >>> 0;
  return "sv_" + h.toString(16);
}

/* ---------------- availability predicates (A2APP-SPEC 3.4) ----------------
 * Parity oracle: adapters/rules/src/predicate.ts. The same predicate and the
 * same record must yield the same availability and the same blocked reason on
 * every stack — a model never decides either. */

function asDeclared(value, type) {
  if (blank(value)) return null;
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (type === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      var n = Number(value);
      return isFinite(n) ? n : value;
    }
    return value;
  }
  return value;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return stableJson(a) === stableJson(b);
  return false;
}

function fieldIndex(fields) {
  var index = {};
  for (var i = 0; i < fields.length; i++) index[fields[i].name] = fields[i];
  return index;
}

function readField(record, name, index) {
  return asDeclared(record[name], index[name] ? index[name].type : undefined);
}

function evaluatePredicate(p, record, fields) {
  return evalPred(p, record, fieldIndex(fields));
}

function evalPred(p, record, index) {
  var i;
  if (p.all) {
    for (i = 0; i < p.all.length; i++) if (!evalPred(p.all[i], record, index)) return false;
    return true;
  }
  if (p.any) {
    for (i = 0; i < p.any.length; i++) if (evalPred(p.any[i], record, index)) return true;
    return false;
  }
  if (p.not) return !evalPred(p.not, record, index);

  var actual = readField(record, p.field, index);
  var type = index[p.field] ? index[p.field].type : undefined;
  if (Object.prototype.hasOwnProperty.call(p, "isBlank")) return (actual === null) === p.isBlank;
  if (Object.prototype.hasOwnProperty.call(p, "eq")) return sameValue(actual, asDeclared(p.eq, type));
  if (Object.prototype.hasOwnProperty.call(p, "ne")) return !sameValue(actual, asDeclared(p.ne, type));
  if (p["in"]) {
    for (i = 0; i < p["in"].length; i++) if (sameValue(actual, asDeclared(p["in"][i], type))) return true;
    return false;
  }
  if (p.notIn) {
    for (i = 0; i < p.notIn.length; i++) if (sameValue(actual, asDeclared(p.notIn[i], type))) return false;
    return true;
  }
  // Unrecognised form: refuse rather than default to available.
  return false;
}

function renderValue(v) {
  if (v === null || v === undefined) return "blank";
  if (typeof v === "string") return '"' + v + '"';
  if (typeof v === "object") return stableJson(v);
  return String(v);
}

function renderList(values) {
  var parts = values.map(renderValue);
  if (parts.length <= 1) return parts.join("");
  return parts.slice(0, -1).join(", ") + " or " + parts[parts.length - 1];
}

function explainPredicate(p, record, fields) {
  var index = fieldIndex(fields);
  if (evalPred(p, record, index)) return "the condition holds";
  return explainPred(p, record, index);
}

function explainPred(p, record, index) {
  var i;
  if (p.all) {
    for (i = 0; i < p.all.length; i++) if (!evalPred(p.all[i], record, index)) return explainPred(p.all[i], record, index);
    return "the condition holds";
  }
  if (p.any) return p.any.length ? explainPred(p.any[0], record, index) : "no condition is satisfiable";
  if (p.not) {
    var inner = p.not;
    if (Object.prototype.hasOwnProperty.call(inner, "isBlank")) {
      return inner.isBlank ? inner.field + " is blank" : inner.field + " is set";
    }
    if (Object.prototype.hasOwnProperty.call(inner, "eq")) {
      return inner.field + " is " + renderValue(readField(record, inner.field, index));
    }
    return "the condition is not met";
  }
  var actual = readField(record, p.field, index);
  if (Object.prototype.hasOwnProperty.call(p, "isBlank")) {
    return p.isBlank ? p.field + " is set to " + renderValue(actual) + ", not blank" : p.field + " is blank";
  }
  if (Object.prototype.hasOwnProperty.call(p, "eq")) {
    return p.field + " is " + renderValue(actual) + ", not " + renderValue(p.eq);
  }
  if (Object.prototype.hasOwnProperty.call(p, "ne")) return p.field + " is " + renderValue(actual);
  if (p["in"]) return p.field + " is " + renderValue(actual) + ", not " + renderList(p["in"]);
  if (p.notIn) return p.field + " is " + renderValue(actual);
  return "the condition is not met";
}

/** One human+machine readable sentence. Adapters MUST NOT invent their own —
 *  identical rules must produce identical text on every backend. */
function describeViolation(v, serverNow) {
  var msg = "Rejected by a2app (" + v.code + '): field "' + v.field + '" expects ' + v.expected + "; got " + JSON.stringify(v.got);
  if ((v.code === "invalid_date" || v.code === "invalid_daykey") && serverNow) msg += '. Example: "' + String(serverNow).slice(0, 10) + '"';
  if (serverNow) msg += ". Server time is " + serverNow;
  return msg + ".";
}

function describeIncomplete(lost) {
  var names = lost.map(function (l) { return l.field; }).join(", ");
  return "Rejected by a2app (not_stored): the database did not store " + names + ". Do NOT report this as done.";
}

module.exports = { RULES_VERSION: RULES_VERSION, validate: validate, looksLikeDate: looksLikeDate, isDayKey: isDayKey, labelField: labelField, schemaVersion: schemaVersion, describeViolation: describeViolation, describeIncomplete: describeIncomplete, evaluatePredicate: evaluatePredicate, explainPredicate: explainPredicate };

/* -------- gate self-test: `node _a2app_rules.js --selftest` -------- */
if (typeof process !== "undefined" && process.argv && process.argv.indexOf("--selftest") !== -1) {
  var fields = [
    { name: "title", type: "string", required: true, max: 200 },
    { name: "status", type: "enum", values: ["todo", "done"] },
    { name: "due", type: "string", max: 10, dayKey: true },
    { name: "created", type: "datetime", readOnly: true },
  ];
  var vs = validate(fields, { title: "x", status: "nope", bogus: 1, due: "tomorrow", created: "2020" }, {});
  var codes = vs.map(function (v) { return v.code; }).sort();
  var expect = ["invalid_daykey", "invalid_enum", "read_only_field", "unknown_field"];
  var failures = [];
  if (JSON.stringify(codes) !== JSON.stringify(expect)) failures.push("guard codes: " + JSON.stringify(codes));
  if (validate(fields, { title: "ok", status: "done", due: "2026-07-30" }, {}).length !== 0) failures.push("a good body was rejected");
  if (labelField(fields) !== "title") failures.push("label field: " + labelField(fields));

  // Predicate parity: availability AND the stated reason are both contractual,
  // so a blocked operation says the same thing on every stack.
  var rec = { id: "t1", title: "Ship it", status: "todo" };
  if (evaluatePredicate({ field: "status", ne: "done" }, rec, fields) !== true) failures.push("ne should hold");
  if (evaluatePredicate({ field: "status", eq: "done" }, rec, fields) !== false) failures.push("eq should fail");
  var why = explainPredicate({ field: "status", eq: "done" }, rec, fields);
  if (why !== 'status is "todo", not "done"') failures.push("eq explanation: " + why);
  var whyIn = explainPredicate({ field: "status", "in": ["done"] }, rec, fields);
  if (whyIn !== 'status is "todo", not "done"') failures.push("in explanation: " + whyIn);
  if (evaluatePredicate({ field: "done", eq: true }, { id: "x", done: "true" }, [{ name: "done", type: "boolean" }]) !== true) {
    failures.push("boolean must compare by declared type, not storage shape");
  }
  if (evaluatePredicate({ field: "status" }, rec, fields) !== false) failures.push("unknown predicate form must refuse");

  // Fingerprint must move with anything describe publishes.
  var base = {}; base.tasks = { fields: fields, module: "planning" };
  var moved = {}; moved.tasks = { fields: fields, module: "other" };
  if (schemaVersion(base) === schemaVersion(moved)) failures.push("fingerprint ignores an entity's module");
  if (schemaVersion(base, [{ name: "op", params: {} }]) === schemaVersion(base, [{ name: "op", params: { x: { type: "string" } } }])) {
    failures.push("fingerprint ignores operation params");
  }

  if (failures.length) console.log("a2app_rules selftest FAILED:\n  - " + failures.join("\n  - "));
  else console.log("a2app_rules selftest: all rules pass (guard, predicates, fingerprint)");
  process.exit(failures.length ? 1 : 0);
}
