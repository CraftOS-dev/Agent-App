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

function schemaVersion(entities) {
  var parts = [];
  for (var name in entities) {
    if (!Object.prototype.hasOwnProperty.call(entities, name)) continue;
    var fs = entities[name].map(function (f) { return f.name + ":" + f.type; }).sort();
    parts.push(name + "(" + fs.join(",") + ")");
  }
  parts.sort();
  var joined = parts.join(";");
  var h = 5381;
  for (var k = 0; k < joined.length; k++) h = ((h * 33) ^ joined.charCodeAt(k)) >>> 0;
  return "sv_" + h.toString(16);
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

module.exports = { RULES_VERSION: RULES_VERSION, validate: validate, looksLikeDate: looksLikeDate, isDayKey: isDayKey, labelField: labelField, schemaVersion: schemaVersion, describeViolation: describeViolation, describeIncomplete: describeIncomplete };

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
  var okAll = JSON.stringify(codes) === JSON.stringify(expect) && validate(fields, { title: "ok", status: "done", due: "2026-07-30" }, {}).length === 0 && labelField(fields) === "title";
  console.log(okAll ? "a2app_rules selftest: all rules pass" : "a2app_rules selftest FAILED: " + JSON.stringify(codes));
  process.exit(okAll ? 0 : 1);
}
