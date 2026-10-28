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

/**
 * Which declared fields point at `target`, and would therefore be left dangling
 * if a record of it were deleted.
 *
 * Pure so it can be self-tested: the hook that calls it cannot be, because it
 * only runs inside PocketBase. `entities` is { name: { fields: [...] } } as the
 * adapter maps it; a field opts out with onDelete "ignore".
 */
function referencingFields(entities, target) {
  var out = [];
  var names = Object.keys(entities || {});
  for (var i = 0; i < names.length; i++) {
    var def = entities[names[i]];
    var fields = (def && def.fields) || [];
    for (var j = 0; j < fields.length; j++) {
      var f = fields[j];
      if (f.type !== "ref" && f.type !== "list<ref>") continue;
      if (f.entity !== target) continue;
      if ((f.onDelete || "restrict") !== "restrict") continue;
      out.push({ entity: names[i], field: f.name, list: f.type === "list<ref>" });
    }
  }
  return out;
}

/* ---------------- operation arguments ----------------
 * An operation IS a write, so its arguments go through the same guard as a
 * record write. Parity oracle: `paramFields` + `validate(…, {requireRequired})`
 * in adapter-core. Every parameter is supplied fresh on each call, so a declared
 * `required` is always enforced: absent or blank is `missing_required`. */

function paramFields(params) {
  var out = [];
  var names = Object.keys(params || {});
  for (var i = 0; i < names.length; i++) {
    var p = params[names[i]] || {};
    var f = { name: names[i], type: p.type };
    if (p.required !== undefined) f.required = p.required;
    if (p.max !== undefined) f.max = p.max;
    if (p.values !== undefined) f.values = p.values;
    if (p.entity !== undefined) f.entity = p.entity;
    out.push(f);
  }
  return out;
}

function validateArgs(params, args) {
  var fields = paramFields(params);
  var out = [];
  var keys = Object.keys(args || {});
  for (var i = 0; i < keys.length; i++) {
    var f = null;
    for (var j = 0; j < fields.length; j++) if (fields[j].name === keys[i]) f = fields[j];
    if (f && f.required && blank(args[keys[i]])) {
      out.push(violation("missing_required", keys[i], "a non-blank value (required field)", args[keys[i]]));
    }
  }
  if (fields.length === 0) {
    // "one of: " with nothing after it reads as a truncated message.
    for (var k = 0; k < keys.length; k++) {
      out.push(violation("unknown_field", keys[k], "nothing — no writable fields are declared", args[keys[k]]));
    }
  } else {
    var found = validate(fields, args || {}, {});
    for (var n = 0; n < found.length; n++) out.push(found[n]);
  }
  for (var m = 0; m < fields.length; m++) {
    if (fields[m].required && !Object.prototype.hasOwnProperty.call(args || {}, fields[m].name)) {
      out.push(violation("missing_required", fields[m].name, "a non-blank value (required field)", undefined));
    }
  }
  return out;
}

/* ---------------- canonical JSON (RFC 8785) ----------------
 * Parity oracle: adapters/adapter-core/src/canon.ts. The approval key and the
 * task dedup key are hashes of this text, so two adapters that canonicalize the
 * same call identically mint the same key. Hashing needs the runtime (PocketBase
 * `$security.sha256`, Node `crypto`), so this layer stops at the text. */

function canonicalize(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!isFinite(v)) throw new Error("cannot canonicalize a non-finite number");
    return String(v);
  }
  if (t === "string") return canonicalString(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (t === "object") {
    var keys = Object.keys(v).sort();
    return "{" + keys.map(function (k) { return canonicalString(k) + ":" + canonicalize(v[k]); }).join(",") + "}";
  }
  throw new Error("cannot canonicalize value of type " + t);
}

function canonicalString(s) {
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    var code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
    else out += ch;
  }
  return out + '"';
}

/** What a destructive call's approval key is the hash of: this exact operation
 *  with these exact arguments. */
function approvalText(operation, args) {
  return canonicalize({ operation: operation, args: args === null || args === undefined ? {} : args });
}

/** What a task's dedup key is the hash of. Keyed on the OCCURRENCE — the event
 *  type, the capability asked for, and the payload — never on the event record,
 *  whose id is fresh per emit and would deduplicate nothing (A2APP-SPEC 6.2). */
function occurrenceText(type, capability, payload) {
  return canonicalize({ type: type, capability: capability, payload: payload === undefined ? null : payload });
}

/* ---------------- the app→agent queue (A2APP-SPEC 6) ----------------
 * Parity oracle: `handleTasks` in adapters/adapter-core/src/server.ts and
 * `sweep` in store.ts. Storage is the adapter's business; what a task may
 * become, and when, is decided here so the gate's self-test can hold it. */

var QUEUE = {
  /** A `working` task with no update for this long goes back to the queue. */
  TASK_TIMEOUT_MS: 60000,
  /** …until it has been handed out this many times; then it fails. */
  TASK_MAX_DELIVERIES: 5,
  POLL_AFTER_MS: 2000,
  EVENTS_POLL_AFTER_MS: 3000,
  /** The event log is a ring; `seq` stays monotonic so cursors survive a prune. */
  EVENT_RETENTION: 5000,
  APPROVAL_TTL_MS: 10 * 60 * 1000,
};

var TERMINAL = ["completed", "failed", "canceled"];

function newTask(input) {
  var request = { capability: input.capability };
  if (input.payload !== undefined) request.payload = input.payload;
  return {
    id: input.id,
    app: input.app,
    event: input.event === undefined ? null : input.event,
    status: "submitted",
    request: request,
    claim: null,
    progress: { step: null, percent: 0 },
    result: null,
    reason: null,
    ask: null,
    createdAt: input.now,
    updatedAt: input.now,
    dedupKey: input.dedupKey || null,
    deliveries: 1,
  };
}

/** The task as the protocol publishes it — never the dedup key or the delivery
 *  count, which are the adapter's bookkeeping. */
function taskWire(t) {
  return {
    id: t.id,
    app: t.app,
    event: t.event,
    status: t.status,
    request: t.request,
    claim: t.claim,
    progress: t.progress,
    result: t.result,
    reason: t.reason,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    pollAfterMs: QUEUE.POLL_AFTER_MS,
  };
}

function refusal(status, code, message, extra) {
  return { error: { status: status, code: code, message: message, extra: extra || {} } };
}

/**
 * One lifecycle step: `claim`, `progress`, `complete` or `cancel`, by `ctx`
 * ({credentialId, agentName, principal}) at `now`. Returns `{task}` (a new
 * object; the input is not touched) or `{error: {status, code, message}}`.
 */
function applyTaskAction(task, action, body, ctx, now) {
  body = body || {};
  var t = JSON.parse(JSON.stringify(task));
  var id = t.id;
  switch (action) {
    case "claim": {
      if (t.status !== "submitted") {
        return refusal(409, "task_not_claimable", "Task " + id + " is " + t.status + ", not claimable.");
      }
      // An explicit principal is honoured ONLY when it names the caller's own
      // credential. Naming a different one is a claim-as-someone-else attempt.
      var requested = typeof body.agent === "string" && body.agent ? body.agent : null;
      if (requested && requested !== ctx.credentialId && requested !== ctx.agentName) {
        return refusal(403, "principal_mismatch",
          "Cannot claim task " + id + ' as "' + requested + '": the credential presented is ' + ctx.credentialId + ".",
          { requested: requested, actual: ctx.credentialId });
      }
      t.status = "working";
      t.claim = { credentialId: ctx.credentialId, principal: ctx.principal, claimedAt: now };
      break;
    }
    case "progress": {
      if (t.status === "canceled") return refusal(409, "task_canceled", "Task " + id + " was canceled.");
      if (t.status !== "working" && t.status !== "input-required") {
        return refusal(409, "task_not_claimable", "Task " + id + " is " + t.status + ".");
      }
      if (!t.progress) t.progress = { step: null, percent: 0 };
      if (typeof body.step === "string") t.progress.step = body.step;
      if (typeof body.percent === "number") t.progress.percent = body.percent;
      if (body.ask !== undefined && body.ask !== null) {
        t.ask = body.ask;
        t.status = "input-required";
      } else if (t.status === "input-required") {
        t.status = "working";
      }
      break;
    }
    case "complete": {
      if (t.status === "canceled") return refusal(409, "task_canceled", "Task " + id + " was canceled.");
      // A terminal write closes a live claim. A task nobody holds — never
      // claimed, or swept back to the queue under a run that went quiet — has no
      // claim to close, and a late report must not close work someone else may
      // now be doing.
      if (t.status !== "working" && t.status !== "input-required") {
        return refusal(409, "task_not_claimable", "Task " + id + " is " + t.status + ", not in progress.");
      }
      if (body.status === "completed") {
        t.status = "completed";
        t.result = body.result && typeof body.result === "object" ? body.result : {};
      } else if (body.status === "failed") {
        t.status = "failed";
        t.reason = typeof body.reason === "string" ? body.reason : "unspecified";
      } else {
        return refusal(400, "usage", 'complete requires status "completed" or "failed".');
      }
      break;
    }
    case "cancel": {
      // Terminal is terminal: relabelling finished work as canceled would
      // rewrite an outcome that already happened.
      if (TERMINAL.indexOf(t.status) !== -1) {
        return refusal(409, "task_not_claimable", "Task " + id + " already reached " + t.status + ".");
      }
      t.status = "canceled";
      break;
    }
    default:
      return refusal(404, "usage", 'Unknown task action "' + action + '".');
  }
  t.updatedAt = now;
  return { task: t };
}

/**
 * Return an abandoned claim to the queue. A `working` task with no update for
 * `timeoutMs` goes back to `submitted` so another run can take it, and fails as
 * `redelivery_exhausted` once it has been handed out `maxDeliveries` times —
 * never a silent drop. Returns the swept task (a new object), or null when this
 * one is not due.
 */
function sweepTask(task, nowMs, timeoutMs, maxDeliveries) {
  if (task.status !== "working") return null;
  var updated = Date.parse(task.updatedAt);
  if (!isNaN(updated) && nowMs - updated < timeoutMs) return null;
  var t = JSON.parse(JSON.stringify(task));
  if ((t.deliveries || 1) >= maxDeliveries) {
    t.status = "failed";
    t.reason = "redelivery_exhausted";
  } else {
    t.status = "submitted";
    t.claim = null;
    t.deliveries = (t.deliveries || 1) + 1;
  }
  t.updatedAt = new Date(nowMs).toISOString();
  return t;
}

/** Mark the named fields read-only, in place, and return the list. `names` is
 *  what the app declared for this entity (absent means none). */
function markReadOnly(fields, names) {
  if (!names || !names.length) return fields;
  for (var i = 0; i < fields.length; i++) if (names.indexOf(fields[i].name) !== -1) fields[i].readOnly = true;
  return fields;
}

/** Is this event type one the app declared? An app that declares none has not
 *  opted into the restriction (parity with adapter-core's `trigger`). */
function eventDeclared(declared, type) {
  if (!declared || declared.length === 0) return true;
  for (var i = 0; i < declared.length; i++) if (declared[i] && declared[i].type === type) return true;
  return false;
}

module.exports = { RULES_VERSION: RULES_VERSION, validate: validate, looksLikeDate: looksLikeDate, isDayKey: isDayKey, labelField: labelField, schemaVersion: schemaVersion, describeViolation: describeViolation, describeIncomplete: describeIncomplete, evaluatePredicate: evaluatePredicate, explainPredicate: explainPredicate, referencingFields: referencingFields, validateArgs: validateArgs, canonicalize: canonicalize, approvalText: approvalText, occurrenceText: occurrenceText, QUEUE: QUEUE, newTask: newTask, taskWire: taskWire, applyTaskAction: applyTaskAction, sweepTask: sweepTask, eventDeclared: eventDeclared, markReadOnly: markReadOnly };

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

  // Referential deletes: which fields would be left dangling. The hook that
  // uses this cannot run outside PocketBase; the decision it makes can.
  var model = {
    clients: { fields: [{ name: "name", type: "string" }] },
    invoices: {
      fields: [
        { name: "client", type: "ref", entity: "clients" },
        { name: "projects", type: "list<ref>", entity: "projects" },
      ],
    },
  };
  var blocking = referencingFields(model, "clients");
  if (blocking.length !== 1 || blocking[0].entity !== "invoices" || blocking[0].field !== "client") {
    failures.push("referencingFields misses a ref pointing at the target");
  }
  if (blocking.length && blocking[0].list !== false) failures.push("a scalar ref reported as a list");
  var listed = referencingFields(model, "projects");
  if (listed.length !== 1 || listed[0].list !== true) failures.push("referencingFields misses a list<ref>");
  if (referencingFields(model, "nobody").length !== 0) failures.push("referencingFields invents a blocker");
  var opted = {
    invoices: { fields: [{ name: "client", type: "ref", entity: "clients", onDelete: "ignore" }] },
  };
  if (referencingFields(opted, "clients").length !== 0) failures.push('onDelete "ignore" must not block');

  // Operation arguments are guarded like a write, and required means required.
  var params = { task: { type: "ref", entity: "tasks", required: true } };
  var argCodes = function (args) { return validateArgs(params, args).map(function (v) { return v.code + ":" + v.field; }).join(","); };
  if (argCodes({ task: "t1" }) !== "") failures.push("good operation args were rejected: " + argCodes({ task: "t1" }));
  if (argCodes({}) !== "missing_required:task") failures.push("an absent required arg: " + argCodes({}));
  if (argCodes({ task: "" }) !== "missing_required:task") failures.push("a blank required arg: " + argCodes({ task: "" }));
  if (argCodes({ task: "t1", bogus: 1 }) !== "unknown_field:bogus") failures.push("an undeclared arg: " + argCodes({ task: "t1", bogus: 1 }));
  if (validateArgs({}, { x: 1 }).length !== 1) failures.push("an op with no params must refuse an arg");

  // Canonical JSON and the keys hashed from it must match adapter-core byte for
  // byte, or "approve this exact call" stops being portable between stacks.
  // Expected values computed with adapters/adapter-core/src/canon.ts.
  var canon = canonicalize({ b: [1, 'x\n"', null, true], a: { z: 1.5, y: "é" } });
  if (canon !== '{"a":{"y":"é","z":1.5},"b":[1,"x\\n\\"",null,true]}') failures.push("canonical JSON: " + canon);
  var sha = function (text) { return require("crypto").createHash("sha256").update(text, "utf8").digest("hex"); };
  if (sha(approvalText("clear-done", {})) !== "7d745c845ebc004f343ea667d5b6e711ae3a8b842858cb0e79e4d3026519c00c") {
    failures.push("approval key differs from adapter-core (no args)");
  }
  if (sha(approvalText("complete-task", { task: "abc123" })) !== "8e779421bc9b0823c1c9e8f86228561e8091531fa830e5950985a7964f1fe223") {
    failures.push("approval key differs from adapter-core (with args)");
  }
  if (sha(occurrenceText("task.needs_triage", "triage", { task: "abc123" })) !== "d2d0fe3a22e6080c8c12cd4f064c8741243022ce19c1ab83aac097c8ce99f05e") {
    failures.push("dedup key differs from adapter-core");
  }
  // The same occurrence dedupes whatever its key order; a different one does not.
  if (occurrenceText("e", "c", { a: 1, b: 2 }) !== occurrenceText("e", "c", { b: 2, a: 1 })) failures.push("dedup key depends on key order");
  if (occurrenceText("e", "c", { task: "t1" }) === occurrenceText("e", "c", { task: "t1", previous: "tsk_1" })) {
    failures.push("naming the previous task must make a new occurrence");
  }
  if (!eventDeclared([{ type: "a" }], "a") || eventDeclared([{ type: "a" }], "b")) failures.push("undeclared event types must be refused");

  // A field the app declares read-only is refused on a client write, and moves
  // the fingerprint (describe publishes it).
  var withTask = fields.concat([{ name: "agentTask", type: "string", max: 64 }]);
  var guarded = markReadOnly(JSON.parse(JSON.stringify(withTask)), ["agentTask"]);
  var roCodes = validate(guarded, { title: "x", agentTask: "tsk_1" }, {}).map(function (v) { return v.code + ":" + v.field; }).join(",");
  if (roCodes !== "read_only_field:agentTask") failures.push("a declared read-only field must refuse a client write: " + roCodes);
  if (validate(markReadOnly(JSON.parse(JSON.stringify(withTask)), undefined), { agentTask: "tsk_1" }, {}).length !== 0) {
    failures.push("with nothing declared, the field stays writable");
  }
  if (schemaVersion({ tasks: { fields: withTask, module: "planning" } }) === schemaVersion({ tasks: { fields: guarded, module: "planning" } })) {
    failures.push("fingerprint ignores a declared read-only field");
  }

  // The task lifecycle: claim, contention, progress, completion, cancel.
  var now = "2026-10-05T10:00:00.000Z";
  var agentCtx = { credentialId: "cred_local", agentName: "local", principal: "owner" };
  var t0 = newTask({ id: "tsk_1", app: "app", event: "evt_1", capability: "triage", payload: { task: "t1" }, dedupKey: "k", now: now });
  var wire = taskWire(t0);
  if (wire.status !== "submitted" || wire.request.capability !== "triage" || wire.pollAfterMs !== QUEUE.POLL_AFTER_MS) failures.push("task wire shape");
  if ("dedupKey" in wire || "deliveries" in wire) failures.push("the wire form leaks the adapter's bookkeeping");
  var claimed = applyTaskAction(t0, "claim", { agent: "cred_local" }, agentCtx, now);
  if (!claimed.task || claimed.task.status !== "working" || claimed.task.claim.credentialId !== "cred_local") failures.push("claim should move a task to working");
  if (t0.status !== "submitted") failures.push("a lifecycle step must not mutate its input");
  var again = applyTaskAction(claimed.task, "claim", {}, agentCtx, now);
  if (!again.error || again.error.status !== 409 || again.error.code !== "task_not_claimable") failures.push("a second claim must be 409 task_not_claimable");
  var imposter = applyTaskAction(t0, "claim", { agent: "cred_other" }, agentCtx, now);
  if (!imposter.error || imposter.error.code !== "principal_mismatch") failures.push("claiming as another credential must be refused");
  var early = applyTaskAction(t0, "complete", { status: "completed" }, agentCtx, now);
  if (!early.error || early.error.code !== "task_not_claimable") failures.push("an unclaimed task cannot be completed");
  var prog = applyTaskAction(claimed.task, "progress", { step: "reading", percent: 40 }, agentCtx, now);
  if (!prog.task || prog.task.progress.step !== "reading" || prog.task.progress.percent !== 40) failures.push("progress should record step and percent");
  var asked = applyTaskAction(prog.task, "progress", { ask: { question: "which?" } }, agentCtx, now);
  if (!asked.task || asked.task.status !== "input-required") failures.push("an ask moves the task to input-required");
  var resumed = applyTaskAction(asked.task, "progress", { step: "resumed" }, agentCtx, now);
  if (!resumed.task || resumed.task.status !== "working") failures.push("progress without an ask resumes work");
  var done = applyTaskAction(prog.task, "complete", { status: "completed", result: { summary: "ok" } }, agentCtx, now);
  if (!done.task || done.task.status !== "completed" || done.task.result.summary !== "ok") failures.push("complete should reach completed");
  var failed = applyTaskAction(prog.task, "complete", { status: "failed" }, agentCtx, now);
  if (!failed.task || failed.task.reason !== "unspecified") failures.push("a failure with no reason says so");
  var vague = applyTaskAction(prog.task, "complete", { status: "done" }, agentCtx, now);
  if (!vague.error || vague.error.status !== 400) failures.push("complete with an unknown status is a usage error");
  var late = applyTaskAction(done.task, "cancel", {}, agentCtx, now);
  if (!late.error || late.error.code !== "task_not_claimable") failures.push("a finished task cannot be canceled");
  var canceled = applyTaskAction(t0, "cancel", {}, agentCtx, now).task;
  var afterCancel = applyTaskAction(canceled, "progress", { step: "x" }, agentCtx, now);
  if (!afterCancel.error || afterCancel.error.code !== "task_canceled") failures.push("progress on a canceled task is task_canceled");

  // The sweeper: a quiet claim goes back to the queue, then fails as exhausted.
  var stale = Date.parse(now) + QUEUE.TASK_TIMEOUT_MS + 1;
  if (sweepTask(claimed.task, Date.parse(now) + 1000, QUEUE.TASK_TIMEOUT_MS, QUEUE.TASK_MAX_DELIVERIES) !== null) failures.push("a live claim must not be swept");
  if (sweepTask(t0, stale, QUEUE.TASK_TIMEOUT_MS, QUEUE.TASK_MAX_DELIVERIES) !== null) failures.push("only working tasks are swept");
  var back = sweepTask(claimed.task, stale, QUEUE.TASK_TIMEOUT_MS, QUEUE.TASK_MAX_DELIVERIES);
  if (!back || back.status !== "submitted" || back.claim !== null || back.deliveries !== 2) failures.push("a quiet claim should be redelivered");
  var spent = JSON.parse(JSON.stringify(claimed.task));
  spent.deliveries = QUEUE.TASK_MAX_DELIVERIES;
  var exhausted = sweepTask(spent, stale, QUEUE.TASK_TIMEOUT_MS, QUEUE.TASK_MAX_DELIVERIES);
  if (!exhausted || exhausted.status !== "failed" || exhausted.reason !== "redelivery_exhausted") failures.push("the last delivery should fail as redelivery_exhausted");

  if (failures.length) console.log("a2app_rules selftest FAILED:\n  - " + failures.join("\n  - "));
  else console.log("a2app_rules selftest: all rules pass (guard, predicates, fingerprint, referential deletes, operation args, read-only fields, canonical keys, task lifecycle, sweep)");
  process.exit(failures.length ? 1 : 0);
}
