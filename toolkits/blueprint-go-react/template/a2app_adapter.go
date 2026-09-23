// A2App adapter (SYSTEM-OWNED — hash-locked in the ownership canon).
//
// A native Go port of the A2App served surface: identity, describe, whoami,
// context, guarded records CRUD, declared operations (with approval for
// destructive ops), and the app->agent task/event plane. It enforces the fixed
// validation chain: origin -> credential -> scope -> guard -> backend -> read-back.
// Records persist in SQLite (modernc.org/sqlite via database/sql — a pure-Go
// driver, so the stack builds without cgo), and the live database is a real
// on-disk file inside the toolkit's declared lifecycle dataDir.
//
// The pure validation rules below MUST match `@a2app/rules` — and the Python
// port in blueprint-python-fastapi, which is this file's line-for-line oracle —
// so a Go app and a Node app reject identical payloads identically, verified by
// the conformance suite. HTTP wiring lives in `main.go`; this file never touches
// net/http. An agent evolves the app by editing `schema.go`, never this file.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

// M is the JSON-object shape everything on this surface speaks: records,
// fields, declarations, envelopes. Decoded JSON numbers arrive as float64.
type M = map[string]any

const (
	RULES_VERSION    = "0.1.0"
	PROTOCOL_VERSION = "0.1"
	ADAPTER_VERSION  = "0.1.0"
)

// Wire error codes — identical to ERROR_CODES in every other adapter port.
const (
	codeUnknownField       = "unknown_field"
	codeReadOnlyField      = "read_only_field"
	codeInvalidDate        = "invalid_date"
	codeInvalidDaykey      = "invalid_daykey"
	codeInvalidString      = "invalid_string"
	codeInvalidNumber      = "invalid_number"
	codeInvalidBoolean     = "invalid_boolean"
	codeInvalidEnum        = "invalid_enum"
	codeNotStored          = "not_stored"
	codeDuplicateRequest   = "duplicate_request"
	codeApprovalRequired   = "approval_required"
	codeInsufficientScope  = "insufficient_scope"
	codeAmbiguousRef       = "ambiguous_ref"
	codeInvalidEvent       = "invalid_event"
	codeTaskNotFound       = "task_not_found"
	codeTaskNotClaimable   = "task_not_claimable"
	codeTaskCanceled       = "task_canceled"
	codeAgentTokenRequired = "agent_token_required"
	codeRateLimited        = "rate_limited"
	// The record is still referenced, and a `ref` pointing at it says `restrict`.
	codeRecordReferenced = "record_referenced"
)

// What a `ref` does when nothing says otherwise: refuse the delete. Silently
// orphaning is the worse default — it is invisible at the moment it happens, and
// the app that has to cope with it is the one reading the record weeks later. A
// field opts out with `onDelete: "ignore"`.
//
// There is deliberately no `cascade` or `detach`: both would let one delete write
// to records the caller never named, which an agent cannot approve in advance and
// an audit log cannot explain afterwards. That belongs in a declared operation.
const defaultOnDelete = "restrict"

// Page size for the referential scan a delete runs before it commits.
const referenceScanPage = 500

// How many blocking record ids are reported per field: the answer is "yes, and
// here are examples", not a dump of every row in the way.
const referenceScanLimit = 10

// Hard stop on paging, so a store that ignores `page` cannot spin forever.
const referenceScanMaxPages = 200

/* --------------------------------------------------------- shape helpers */

// The small, boring accessors a dynamically-shaped model costs in Go. They
// answer with the zero value on a miss, which is exactly the Python `.get()`
// semantics the oracle is written in.

func getStr(m M, k string) string { s, _ := m[k].(string); return s }
func getBool(m M, k string) bool  { b, _ := m[k].(bool); return b }
func hasKey(m M, k string) bool   { _, ok := m[k]; return ok }

func fieldsOf(d M) []M {
	f, _ := d["fields"].([]M)
	return f
}

// toMList normalizes a JSON-decoded list ([]any of objects) or a literal []M.
func toMList(v any) []M {
	switch t := v.(type) {
	case []M:
		return t
	case []any:
		out := make([]M, 0, len(t))
		for _, e := range t {
			if m, ok := e.(M); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

// toAnyList normalizes []any / []string / []M into a []any.
func toAnyList(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out
	case []M:
		out := make([]any, len(t))
		for i, m := range t {
			out[i] = m
		}
		return out
	}
	return nil
}

// toStr renders a scalar the way the oracle's string coercions do: strings
// pass through, booleans are the JSON words, numbers drop a trailing ".0".
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	}
	return fmt.Sprint(v)
}

func valuesOf(f M) []string {
	var out []string
	for _, v := range toAnyList(f["values"]) {
		out = append(out, toStr(v))
	}
	return out
}

func intOf(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(t))
		return n
	}
	return 0
}

// truthy mirrors Python's `if value:` where the oracle branches on it — the
// values that occur in declarations (strings, lists, objects, nil).
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case M:
		return len(t) > 0
	case []any:
		return len(t) > 0
	case []M:
		return len(t) > 0
	case []string:
		return len(t) > 0
	case float64:
		return t != 0
	case int:
		return t != 0
	}
	return true
}

/* --------------------------------------------------------------- pure rules */

var monthDays = [12]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
var dateRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$`)
var dayRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)

func validYMD(y, m, d int) bool {
	if m < 1 || m > 12 || d < 1 {
		return false
	}
	mx := monthDays[m-1]
	if m == 2 && y%4 == 0 && (y%100 != 0 || y%400 == 0) {
		mx = 29
	}
	return d <= mx
}

func looksLikeDate(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	m := dateRe.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	return validYMD(y, mo, d)
}

func isDayKeyValue(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	m := dayRe.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	return validYMD(y, mo, d)
}

func isBlank(v any) bool { return v == nil || v == "" }

func violation(code, field, expected string, got any) M {
	return M{"code": code, "field": field, "expected": expected, "got": got}
}

func isNumberString(s string) bool {
	_, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return err == nil
}

func isNumeric(v any) bool {
	switch v.(type) {
	case float64, int, int64:
		return true
	}
	return false
}

// validate checks a RAW body against normalized fields; returns every violation.
// Body keys are visited in sorted order: a Go map has no insertion order to
// honour, and a deterministic order is what keeps the FIRST violation (the one
// the envelope leads with) stable across runs.
func validate(fields []M, body M, allow map[string]bool) []M {
	byName := map[string]M{}
	var writable []string
	for _, f := range fields {
		byName[getStr(f, "name")] = f
		if !getBool(f, "readOnly") {
			writable = append(writable, getStr(f, "name"))
		}
	}
	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := []M{}
	for _, key := range keys {
		value := body[key]
		if allow[key] {
			continue
		}
		f, known := byName[key]
		if !known {
			out = append(out, violation(codeUnknownField, key, "one of: "+strings.Join(writable, ", "), value))
			continue
		}
		if getBool(f, "readOnly") {
			out = append(out, violation(codeReadOnlyField, key, "not writable (server-managed)", value))
			continue
		}
		if isBlank(value) {
			continue
		}
		ftype := getStr(f, "type")
		_, isString := value.(string)
		_, isBool := value.(bool)
		switch {
		case ftype == "datetime" && !looksLikeDate(value):
			out = append(out, violation(codeInvalidDate, key, "an ISO 8601 date", value))
		case getBool(f, "dayKey") && !isDayKeyValue(value):
			out = append(out, violation(codeInvalidDaykey, key, `a day key "YYYY-MM-DD"`, value))
		case ftype == "string" && !isString:
			out = append(out, violation(codeInvalidString, key, "text", value))
		case ftype == "number" && !isNumeric(value) &&
			!(isString && strings.TrimSpace(value.(string)) != "" && isNumberString(value.(string))):
			out = append(out, violation(codeInvalidNumber, key, "a number", value))
		case ftype == "boolean" && !isBool && value != "true" && value != "false":
			out = append(out, violation(codeInvalidBoolean, key, "true or false", value))
		case ftype == "enum" && len(valuesOf(f)) > 0 && !contains(valuesOf(f), toStr(value)):
			out = append(out, violation(codeInvalidEnum, key, "one of: "+strings.Join(valuesOf(f), " | "), value))
		case ftype == "list<enum>" && len(valuesOf(f)) > 0:
			items := toAnyList(value)
			if items == nil {
				items = []any{value}
			}
			allowed := valuesOf(f)
			bad := false
			for _, item := range items {
				if !contains(allowed, toStr(item)) {
					bad = true
				}
			}
			if bad {
				out = append(out, violation(codeInvalidEnum, key, "each of: "+strings.Join(valuesOf(f), " | "), value))
			}
		}
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// divergences is the read-back backstop: which non-blank requested values
// failed to land? Keys are visited sorted, for the same reason validate's are.
func divergences(fields []M, body M, read func(string) any) []M {
	byName := map[string]M{}
	for _, f := range fields {
		byName[getStr(f, "name")] = f
	}
	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := []M{}
	for _, key := range keys {
		requested := body[key]
		f, known := byName[key]
		if !known || getBool(f, "readOnly") {
			continue
		}
		if isBlank(requested) {
			continue
		}
		stored := read(key)
		if isBlank(stored) {
			out = append(out, M{"field": key, "type": getStr(f, "type"), "stored": toStr(stored)})
		}
	}
	return out
}

func labelFieldOf(fields []M) any {
	names := map[string]bool{}
	for _, f := range fields {
		names[getStr(f, "name")] = true
	}
	for _, pref := range []string{"title", "name", "label"} {
		if names[pref] {
			return pref
		}
	}
	for _, f := range fields {
		if getStr(f, "type") == "string" && getBool(f, "required") && !getBool(f, "readOnly") {
			return getStr(f, "name")
		}
	}
	return nil
}

// fieldPrint renders every published attribute of a field deterministically.
//
// Must match `fieldPrint` in @a2app/rules exactly: a client that caches
// describe against this value is told never to write against a stale schema,
// so narrowing an enum or tightening a max has to move the hash.
func fieldPrint(f M) string {
	parts := []string{getStr(f, "name") + ":" + getStr(f, "type")}
	if getBool(f, "required") {
		parts = append(parts, "req")
	}
	if getBool(f, "readOnly") {
		parts = append(parts, "ro")
	}
	if getBool(f, "writeOnly") {
		parts = append(parts, "wo")
	}
	if getBool(f, "dayKey") {
		parts = append(parts, "day")
	}
	if max, ok := f["max"]; ok && max != nil {
		parts = append(parts, "max="+toStr(max))
	}
	if getStr(f, "entity") != "" {
		parts = append(parts, "entity="+getStr(f, "entity"))
	}
	if values := valuesOf(f); len(values) > 0 {
		sorted := append([]string(nil), values...)
		sort.Strings(sorted)
		parts = append(parts, "values="+strings.Join(sorted, "|"))
	}
	return strings.Join(parts, ":")
}

// stableJSON is JSON with keys sorted at every depth and no spaces, so
// declaration order cannot move a hash. encoding/json sorts map keys at every
// depth; HTML escaping is turned off so `<` survives as itself, as it does in
// the Python and Node canonical forms.
func stableJSON(value any) string {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return ""
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

func operationPrint(o M) string {
	flags := ""
	if getBool(o, "destructive") {
		flags += "d"
	}
	if getBool(o, "readOnly") {
		flags += "r"
	}
	if getBool(o, "idempotent") {
		flags += "i"
	}
	head := getStr(o, "name")
	if flags != "" {
		head += ":" + flags
	}
	parts := []string{head}
	if getStr(o, "module") != "" {
		parts = append(parts, "mod="+getStr(o, "module"))
	}
	if getStr(o, "entity") != "" {
		parts = append(parts, "on="+getStr(o, "entity"))
	}
	if params, ok := o["params"].(M); ok && len(params) > 0 {
		parts = append(parts, "params="+stableJSON(params))
	}
	if when, ok := o["appliesWhen"].(M); ok && len(when) > 0 {
		parts = append(parts, "when="+stableJSON(when))
	}
	return strings.Join(parts, ":")
}

// schemaFingerprint is a stable fingerprint of everything describe publishes.
//
// Parity oracle: @a2app/rules `schemaFingerprint`. `entities` maps a name to
// {"fields": [...], "module": str, "auth"?: bool}. `module` is required for the
// same reason it is required there: an entity that could move between modules
// without moving the hash would leave caches placing it in the old one.
func schemaFingerprint(entities map[string]M, operations []M) string {
	parts := []string{}
	for name, value := range entities {
		prints := []string{}
		for _, f := range fieldsOf(value) {
			prints = append(prints, fieldPrint(f))
		}
		sort.Strings(prints)
		attrs := []string{name + "(" + strings.Join(prints, ",") + ")"}
		if getBool(value, "auth") {
			attrs = append(attrs, "auth")
		}
		attrs = append(attrs, "mod="+getStr(value, "module"))
		parts = append(parts, strings.Join(attrs, ":"))
	}
	sort.Strings(parts)
	ops := []string{}
	for _, o := range operations {
		ops = append(ops, operationPrint(o))
	}
	sort.Strings(ops)
	joined := strings.Join(parts, ";") + "|" + strings.Join(ops, ",")
	// djb2-xor over Unicode code points (Python iterates characters, not bytes),
	// masked to 32 bits — uint32 arithmetic wraps to exactly that mask.
	var h uint32 = 5381
	for _, r := range joined {
		h = (h * 33) ^ uint32(r)
	}
	return "sv_" + strconv.FormatUint(uint64(h), 16)
}

/* -- availability predicates (A2APP-SPEC 3.4) ------------------------------ */
// Parity oracle: adapters/rules/src/predicate.ts. Same predicate + same record
// must yield the same availability and the same blocked reason on every stack.

const describeBudgetChars = 2000

// asDeclared reads a value as its field's DECLARED type.
//
// A backend is only obliged to return what it stored, so `done: "true"` and
// `done: true` are the same boolean. Deciding from the runtime type instead
// would make availability depend on the storage engine.
func asDeclared(value any, declaredType string) any {
	if isBlank(value) {
		return nil
	}
	if declaredType == "boolean" {
		switch value {
		case "true":
			return true
		case "false":
			return false
		}
		return value
	}
	if declaredType == "number" {
		switch t := value.(type) {
		case bool, float64, int, int64:
			return value
		case string:
			if n, err := strconv.ParseFloat(t, 64); err == nil {
				return n
			}
			return value
		}
		return value
	}
	return value
}

func asFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	}
	return 0, false
}

func sameValue(a, b any) bool {
	ka := reflect.ValueOf(a).Kind()
	kb := reflect.ValueOf(b).Kind()
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if ka == reflect.Slice || ka == reflect.Map || kb == reflect.Slice || kb == reflect.Map {
		return stableJSON(a) == stableJSON(b)
	}
	_, aBool := a.(bool)
	_, bBool := b.(bool)
	if aBool != bBool {
		return false
	}
	if fa, ok := asFloat(a); ok {
		if fb, ok := asFloat(b); ok {
			return fa == fb
		}
	}
	return a == b
}

func readFieldAs(record M, name string, index map[string]M) any {
	return asDeclared(record[name], getStr(index[name], "type"))
}

func fieldIndex(fields []M) map[string]M {
	index := map[string]M{}
	for _, f := range fields {
		index[getStr(f, "name")] = f
	}
	return index
}

func evaluatePredicate(predicate M, record M, fields []M) bool {
	return evalPredicate(predicate, record, fieldIndex(fields))
}

func evalPredicate(p M, record M, index map[string]M) bool {
	if hasKey(p, "all") {
		for _, sub := range toMList(p["all"]) {
			if !evalPredicate(sub, record, index) {
				return false
			}
		}
		return true
	}
	if hasKey(p, "any") {
		for _, sub := range toMList(p["any"]) {
			if evalPredicate(sub, record, index) {
				return true
			}
		}
		return false
	}
	if hasKey(p, "not") {
		if sub, ok := p["not"].(M); ok {
			return !evalPredicate(sub, record, index)
		}
		return false
	}

	actual := readFieldAs(record, getStr(p, "field"), index)
	declared := getStr(index[getStr(p, "field")], "type")
	if hasKey(p, "isBlank") {
		return (actual == nil) == getBool(p, "isBlank")
	}
	if hasKey(p, "eq") {
		return sameValue(actual, asDeclared(p["eq"], declared))
	}
	if hasKey(p, "ne") {
		return !sameValue(actual, asDeclared(p["ne"], declared))
	}
	if hasKey(p, "in") {
		for _, c := range toAnyList(p["in"]) {
			if sameValue(actual, asDeclared(c, declared)) {
				return true
			}
		}
		return false
	}
	if hasKey(p, "notIn") {
		for _, c := range toAnyList(p["notIn"]) {
			if sameValue(actual, asDeclared(c, declared)) {
				return false
			}
		}
		return true
	}
	// Unrecognised form: refuse rather than default to available. An unknown
	// condition must never silently unblock an action.
	return false
}

func renderValue(v any) string {
	if v == nil {
		return "blank"
	}
	if s, ok := v.(string); ok {
		return `"` + s + `"`
	}
	return stableJSON(v)
}

// predicateFields is every field name a predicate reads, for declaration-time
// validation.
func predicateFields(predicate M) []string {
	out := []string{}
	var collect func(p M)
	collect = func(p M) {
		switch {
		case hasKey(p, "all"):
			for _, sub := range toMList(p["all"]) {
				collect(sub)
			}
		case hasKey(p, "any"):
			for _, sub := range toMList(p["any"]) {
				collect(sub)
			}
		case hasKey(p, "not"):
			if sub, ok := p["not"].(M); ok {
				collect(sub)
			}
		default:
			name := getStr(p, "field")
			if name != "" && !contains(out, name) {
				out = append(out, name)
			}
		}
	}
	collect(predicate)
	return out
}

func renderList(values []any) string {
	parts := make([]string, 0, len(values))
	for _, v := range values {
		parts = append(parts, renderValue(v))
	}
	if len(parts) <= 1 {
		return strings.Join(parts, "")
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " or " + parts[len(parts)-1]
}

// explainPredicate says why this predicate does not hold, derived — never
// composed by a model.
func explainPredicate(predicate M, record M, fields []M) string {
	index := fieldIndex(fields)
	if evalPredicate(predicate, record, index) {
		return "the condition holds"
	}
	return explain(predicate, record, index)
}

func explain(p M, record M, index map[string]M) string {
	if hasKey(p, "all") {
		for _, sub := range toMList(p["all"]) {
			if !evalPredicate(sub, record, index) {
				return explain(sub, record, index)
			}
		}
		return "the condition holds"
	}
	if hasKey(p, "any") {
		subs := toMList(p["any"])
		if len(subs) == 0 {
			return "no condition is satisfiable"
		}
		return explain(subs[0], record, index)
	}
	if hasKey(p, "not") {
		inner, _ := p["not"].(M)
		if hasKey(inner, "isBlank") {
			if getBool(inner, "isBlank") {
				return getStr(inner, "field") + " is blank"
			}
			return getStr(inner, "field") + " is set"
		}
		if hasKey(inner, "eq") {
			return getStr(inner, "field") + " is " + renderValue(readFieldAs(record, getStr(inner, "field"), index))
		}
		return "the condition is not met"
	}

	field := getStr(p, "field")
	actual := readFieldAs(record, field, index)
	if hasKey(p, "isBlank") {
		if getBool(p, "isBlank") {
			return field + " is set to " + renderValue(actual) + ", not blank"
		}
		return field + " is blank"
	}
	if hasKey(p, "eq") {
		return field + " is " + renderValue(actual) + ", not " + renderValue(p["eq"])
	}
	if hasKey(p, "ne") {
		return field + " is " + renderValue(actual)
	}
	if hasKey(p, "in") {
		return field + " is " + renderValue(actual) + ", not " + renderList(toAnyList(p["in"]))
	}
	if hasKey(p, "notIn") {
		return field + " is " + renderValue(actual)
	}
	return "the condition is not met"
}

func describeViolation(v M, serverNow string) string {
	msg := "Rejected by a2app (" + getStr(v, "code") + `): field "` + getStr(v, "field") + `" expects ` +
		getStr(v, "expected") + "; got " + stableJSON(v["got"])
	code := getStr(v, "code")
	if (code == codeInvalidDate || code == codeInvalidDaykey) && serverNow != "" {
		msg += `. Example: "` + serverNow[:10] + `"`
	}
	if serverNow != "" {
		msg += ". Server time is " + serverNow
	}
	return msg + "."
}

func describeIncomplete(lost []M) string {
	names := make([]string, 0, len(lost))
	for _, l := range lost {
		names = append(names, getStr(l, "field"))
	}
	return "Rejected by a2app (not_stored): the database did not store " + strings.Join(names, ", ") +
		". Do NOT report this as done."
}

/* ------------------------------------------------------------ rate limiter */

var defaultRateLimits = map[string]int{"data": 1200, "ops": 300}

type rateWindow struct {
	start int64
	count int
}

// rateLimiter is per-caller, per-class fixed windows. The mutex is Go's cost of
// a concurrent server — the Python oracle serves from one thread.
type rateLimiter struct {
	mu      sync.Mutex
	limits  map[string]int
	nowMS   func() int64
	windows map[string]rateWindow
}

func newRateLimiter(limits map[string]int, nowMS func() int64) *rateLimiter {
	return &rateLimiter{limits: limits, nowMS: nowMS, windows: map[string]rateWindow{}}
}

type rateDecision struct {
	allowed           bool
	limit             int
	retryAfterSeconds int
}

func (l *rateLimiter) check(caller, cls string) rateDecision {
	limit := l.limits[cls]
	if limit <= 0 {
		return rateDecision{allowed: true, limit: limit}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.nowMS()
	key := caller + "\x00" + cls
	w, ok := l.windows[key]
	if !ok || now-w.start >= 60000 {
		w = rateWindow{start: now}
	}
	w.count++
	l.windows[key] = w
	if w.count > limit {
		retry := int((60000 - (now - w.start)) / 1000)
		if retry < 1 {
			retry = 1
		}
		return rateDecision{allowed: false, limit: limit, retryAfterSeconds: retry}
	}
	return rateDecision{allowed: true, limit: limit}
}

/* ------------------------------------------------------------------- store */

// The single-clause filter grammar this backend implements — `field = "value"`,
// `field != "value"`, or `field ~ "value"` (contains), optionally wrapped in one
// pair of parentheses. Enough for label->id resolution; a richer backend exposes
// its own query language. Anything outside it is REFUSED, never ignored: a
// store that accepts `filter` and returns unfiltered rows answers 200 with the
// wrong records, which turns every label lookup into a false multi-match.
// Parity: the react-node blueprint's matchFilter in server.mjs.
var filterRe = regexp.MustCompile(
	`^\s*\(?\s*([A-Za-z_]\w*)\s*(=|!=|~)\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'()]+))\s*\)?\s*$`)

var unescapeRe = regexp.MustCompile(`\\(.)`)

// UnsupportedFilter is returned when a `filter` expression falls outside the
// grammar above.
type UnsupportedFilter struct{ Expression string }

func (e *UnsupportedFilter) Error() string {
	return "filter expression is not supported by this backend: " + e.Expression
}

func filterStr(value any) string {
	if value == nil {
		return ""
	}
	if b, ok := value.(bool); ok {
		if b {
			return "true"
		}
		return "false"
	}
	return toStr(value)
}

func matchFilter(expr string) (func(M) bool, error) {
	m := filterRe.FindStringSubmatchIndex(expr)
	if m == nil {
		return nil, &UnsupportedFilter{Expression: expr}
	}
	group := func(i int) (string, bool) {
		if m[2*i] < 0 {
			return "", false
		}
		return expr[m[2*i]:m[2*i+1]], true
	}
	field, _ := group(1)
	op, _ := group(2)
	// Only the double-quoted form carries escapes; unescape exactly what the
	// escaping side wrote (backslash-x -> x).
	var value string
	if quoted, ok := group(3); ok {
		value = unescapeRe.ReplaceAllString(quoted, "$1")
	} else if single, ok := group(4); ok {
		value = single
	} else if bare, ok := group(5); ok {
		value = bare
	}
	return func(record M) bool {
		current := filterStr(record[field])
		switch op {
		case "=":
			return current == value
		case "!=":
			return current != value
		}
		return strings.Contains(current, value)
	}, nil
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func coerce(field M, value any) any {
	if value == nil || value == "" {
		return value
	}
	if s, ok := value.(string); ok {
		switch getStr(field, "type") {
		case "number":
			if strings.Contains(s, ".") {
				if f, err := strconv.ParseFloat(s, 64); err == nil {
					return f
				}
			}
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				return n
			}
			// The guard already accepted the string as numeric, so the only way
			// here is an exponent form ("1e5") — land it as a float rather than
			// crash, which is where a raised ValueError would have gone.
			if f, err := strconv.ParseFloat(s, 64); err == nil {
				return f
			}
			return value
		case "boolean":
			return s == "true"
		}
	}
	return value
}

// Store is the record store plus adapter-owned state (tasks, events,
// idempotency keys, approvals, grants). NewStore builds the disposable
// in-memory variant for tests and tooling; NewSqliteStore is the blueprint's
// live store — same interface, records + idempotency keys durable in SQLite.
//
// Records are JSON rows in one table keyed (entity, id): the schema stays
// declarative and additive (a new field simply appears in the JSON) while the
// DATABASE is a real on-disk file inside the toolkit's declared lifecycle
// dataDir — which is what backup/restore/promote protect. WAL keeps a reader
// and a writer from blocking each other.
//
// Idempotency keys persist because a restart is exactly when a retried POST
// arrives — an in-memory table would return a duplicate record instead of the
// 409 the protocol promises. The task/event plane, approvals, grants and audit
// stay in memory: they are runtime queues and session state, not records.
//
// Writes are durable when the call returns — there is no separate persist()
// step. A record read from the SQLite store is a COPY: mutate it, then
// putRecord() it back, or the change never happened.
type Store struct {
	Seed map[string][]M
	// WantsSeed is true only when this store is genuinely fresh. NewSqliteStore
	// sets it false when the database file already existed: re-seeding an
	// existing database on every boot would resurrect a seed record the user
	// deleted.
	WantsSeed bool

	// One mutex guards everything: net/http serves concurrently, and one
	// connection guarded by one lock keeps SQLite correct without a pool.
	mu sync.Mutex
	db *sql.DB // nil for the in-memory variant

	rows      map[string]map[string]M
	rowOrder  map[string][]string // insertion order, so listing is deterministic
	memIdem   map[string]string
	tasks     map[string]M
	taskOrder []string
	events    []M
	approvals map[string]bool
	grants    map[string]M
	taskSeq   int
	eventSeq  int
}

func newStoreState(seed map[string][]M) *Store {
	if seed == nil {
		seed = map[string][]M{}
	}
	return &Store{
		Seed:      seed,
		WantsSeed: true,
		rows:      map[string]map[string]M{},
		rowOrder:  map[string][]string{},
		memIdem:   map[string]string{},
		tasks:     map[string]M{},
		approvals: map[string]bool{},
		grants:    map[string]M{},
	}
}

// NewStore is the in-memory variant — always empty, so it always takes the seed.
func NewStore(seed map[string][]M) *Store { return newStoreState(seed) }

// NewSqliteStore opens (or creates) the live database file.
func NewSqliteStore(path string, seed map[string][]M) (*Store, error) {
	s := newStoreState(seed)
	full, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return nil, err
	}
	_, statErr := os.Stat(full)
	fresh := os.IsNotExist(statErr)
	db, err := sql.Open("sqlite", full)
	if err != nil {
		return nil, err
	}
	// One connection, guarded by the store mutex — SQLite is happiest that way,
	// and the interface stays a plain synchronous call.
	db.SetMaxOpenConns(1)
	// WAL keeps a reader and a writer from blocking each other. The pragma
	// answers with a row (the new mode), so it goes through QueryRow — some
	// database/sql drivers refuse a row-returning statement in Exec.
	var journalMode string
	if err := db.QueryRow("PRAGMA journal_mode=WAL").Scan(&journalMode); err != nil {
		db.Close()
		return nil, err
	}
	for _, stmt := range []string{
		"CREATE TABLE IF NOT EXISTS records (entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (entity, id))",
		"CREATE TABLE IF NOT EXISTS idem (entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, PRIMARY KEY (entity, key))",
	} {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, err
		}
	}
	s.db = db
	s.WantsSeed = fresh
	return s, nil
}

// Close releases the database file (the last connection closing checkpoints
// the WAL into the main file). A no-op on the in-memory variant.
func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

/* records ------------------------------------------------------------- */

// allRecords is every record of one entity — the single hook the durable
// backend swaps for reads; listRecords keeps the shared filter/sort/page.
func (s *Store) allRecords(entity string) []M {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		out := make([]M, 0, len(s.rowOrder[entity]))
		for _, id := range s.rowOrder[entity] {
			out = append(out, s.rows[entity][id])
		}
		return out
	}
	rows, err := s.db.Query("SELECT data FROM records WHERE entity = ?", entity)
	if err != nil {
		return []M{}
	}
	defer rows.Close()
	out := []M{}
	for rows.Next() {
		var data string
		if rows.Scan(&data) != nil {
			continue
		}
		var rec M
		if json.Unmarshal([]byte(data), &rec) == nil {
			out = append(out, rec)
		}
	}
	return out
}

func (s *Store) listRecords(entity string, query M) (M, error) {
	items := s.allRecords(entity)
	if flt := getStr(query, "filter"); flt != "" {
		pred, err := matchFilter(flt)
		if err != nil {
			return nil, err
		}
		kept := []M{}
		for _, r := range items {
			if pred(r) {
				kept = append(kept, r)
			}
		}
		items = kept
	}
	if sortKey := getStr(query, "sort"); sortKey != "" {
		desc := strings.HasPrefix(sortKey, "-")
		key := strings.TrimPrefix(sortKey, "-")
		// Mirrors the oracle's (value is None, str(value)) sort tuple: records
		// holding a value come first ascending, blanks last; desc reverses the
		// whole ordering, blanks included.
		sort.SliceStable(items, func(i, j int) bool {
			a, b := items[i], items[j]
			if desc {
				a, b = b, a
			}
			aNil, bNil := a[key] == nil, b[key] == nil
			if aNil != bNil {
				return !aNil
			}
			return toStr(a[key]) < toStr(b[key])
		})
	}
	total := len(items)
	perPage := total
	if truthy(query["perPage"]) {
		perPage = intOf(query["perPage"])
	}
	page := 1
	if truthy(query["page"]) {
		page = intOf(query["page"])
	}
	paged := items
	if perPage != 0 {
		start := (page - 1) * perPage
		if start < 0 {
			start = 0
		}
		if start > total {
			start = total
		}
		end := start + perPage
		if end > total {
			end = total
		}
		paged = items[start:end]
	}
	if paged == nil {
		paged = []M{}
	}
	return M{"items": paged, "page": page, "perPage": perPage, "totalItems": total}, nil
}

func (s *Store) getRecord(entity, recID string) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return s.rows[entity][recID]
	}
	var data string
	err := s.db.QueryRow("SELECT data FROM records WHERE entity = ? AND id = ?", entity, recID).Scan(&data)
	if err != nil {
		return nil
	}
	var rec M
	if json.Unmarshal([]byte(data), &rec) != nil {
		return nil
	}
	return rec
}

func (s *Store) putRecord(entity string, rec M) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := getStr(rec, "id")
	if s.db == nil {
		if s.rows[entity] == nil {
			s.rows[entity] = map[string]M{}
		}
		if _, existed := s.rows[entity][id]; !existed {
			s.rowOrder[entity] = append(s.rowOrder[entity], id)
		}
		s.rows[entity][id] = rec
		return
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return
	}
	s.db.Exec(
		"INSERT INTO records (entity, id, data) VALUES (?, ?, ?) ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data",
		entity, id, string(data))
}

func (s *Store) deleteRecord(entity, recID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		if _, ok := s.rows[entity][recID]; !ok {
			return false
		}
		delete(s.rows[entity], recID)
		order := s.rowOrder[entity]
		for i, id := range order {
			if id == recID {
				s.rowOrder[entity] = append(order[:i], order[i+1:]...)
				break
			}
		}
		return true
	}
	res, err := s.db.Exec("DELETE FROM records WHERE entity = ? AND id = ?", entity, recID)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

/* grants ---------------------------------------------------------------- */

func (s *Store) putGrant(grant M) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.grants[getStr(grant, "token")] = grant
}

func (s *Store) grantByToken(token string) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.grants[token]
}

/* idempotency / approvals ------------------------------------------------ */

func (s *Store) idemGet(entity, key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return s.memIdem[entity+"\x00"+key]
	}
	var recID string
	if s.db.QueryRow("SELECT rec_id FROM idem WHERE entity = ? AND key = ?", entity, key).Scan(&recID) != nil {
		return ""
	}
	return recID
}

func (s *Store) idemPut(entity, key, recID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		s.memIdem[entity+"\x00"+key] = recID
		return
	}
	s.db.Exec(
		"INSERT INTO idem (entity, key, rec_id) VALUES (?, ?, ?) ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id",
		entity, key, recID)
}

func (s *Store) approvalIssue(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.approvals[key] = true
}

func (s *Store) approvalConsume(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.approvals[key] {
		delete(s.approvals, key)
		return true
	}
	return false
}

/* tasks / events ---------------------------------------------------------- */

func (s *Store) appendEvent(etype string, payload M) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eventSeq++
	ev := M{
		"id": fmt.Sprintf("ev_%d", s.eventSeq), "app": nil, "type": etype,
		"payload": payload, "createdAt": nowISO(), "seq": s.eventSeq,
	}
	s.events = append(s.events, ev)
	return ev
}

func (s *Store) eventsSince(cursor string) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	after := 0
	if cursor != "" {
		if n, err := strconv.Atoi(cursor); err == nil && n >= 0 {
			after = n
		}
	}
	fresh := []M{}
	for _, e := range s.events {
		if intOf(e["seq"]) > after {
			fresh = append(fresh, e)
		}
	}
	next := cursor
	if next == "" {
		next = "0"
	}
	if len(fresh) > 0 {
		next = strconv.Itoa(intOf(fresh[len(fresh)-1]["seq"]))
	}
	return M{"events": fresh, "nextCursor": next}
}

func (s *Store) enqueueTask(eventID, capability string, payload M) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.taskSeq++
	task := M{
		"id": fmt.Sprintf("task_%d", s.taskSeq), "app": nil, "event": eventID, "status": "submitted",
		"request": M{"capability": capability, "payload": payload}, "claim": nil,
		"progress": M{}, "result": nil, "reason": nil, "ask": nil,
		"createdAt": nowISO(), "updatedAt": nowISO(), "deliveries": 0,
	}
	s.tasks[getStr(task, "id")] = task
	s.taskOrder = append(s.taskOrder, getStr(task, "id"))
	return task
}

func (s *Store) listTasks(status string) []M {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []M{}
	for _, id := range s.taskOrder {
		t := s.tasks[id]
		if status == "" || getStr(t, "status") == status {
			out = append(out, t)
		}
	}
	return out
}

func (s *Store) getTask(taskID string) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tasks[taskID]
}

func (s *Store) saveTask(task M) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task["updatedAt"] = nowISO()
	s.tasks[getStr(task, "id")] = task
}

/* ----------------------------------------------------------------- adapter */

func approvalKeyFor(name string, args M) string {
	canonical := stableJSON(M{"op": name, "args": args})
	sum := sha256.Sum256([]byte(canonical))
	return "ak_" + hex.EncodeToString(sum[:])[:32]
}

func randomHex(nBytes int) string {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		panic(err) // the OS entropy source failing is not a recoverable request error
	}
	return hex.EncodeToString(buf)
}

// OperationRunner is the signature schema.go implements: (args, ctx, store) ->
// JSON-able result. Returning an error (or panicking) becomes operation_failed.
type OperationRunner func(args M, ctx M, store *Store) (any, error)

// AdapterConfig is everything the wiring (main.go) hands the adapter.
type AdapterConfig struct {
	AppID          string
	AppName        any // string, or nil for an unnamed app
	Entities       map[string]M
	Operations     []M
	Store          *Store
	Token          string
	Modules        []M
	AllowedOrigins []string
	Runners        map[string]OperationRunner
	AuthMode       string
	CredentialHint string
	Env            string
	// AppVersion is the View fingerprint published in identity — the marker
	// that moves for changes schemaVersion is blind to. Optional: an API-only
	// deployment publishes none.
	AppVersion func() string
}

type Adapter struct {
	appID          string
	appName        any
	entityDefs     map[string]M
	operations     []M
	modules        []M
	opByName       map[string]M
	store          *Store
	authMode       string
	allowedOrigins map[string]bool
	runners        map[string]OperationRunner
	credentialHint string
	env            string
	appVersion     func() string
	limiter        *rateLimiter

	// dataVersion state — moves on every record write, so an open tab can
	// re-read without reloading (see a2app-update.js). The boot component makes
	// a restart count as a change.
	bootMark   string
	dataWrites atomic.Int64
}

// NewAdapter builds the adapter or reports every declaration problem. A model
// whose entities or operations name a module that was never declared cannot be
// walked, so serving it would answer 200 while omitting real capability —
// construction fails fast instead.
func NewAdapter(cfg AdapterConfig) (*Adapter, error) {
	a := &Adapter{
		appID:          cfg.AppID,
		appName:        cfg.AppName,
		entityDefs:     cfg.Entities,
		operations:     cfg.Operations,
		modules:        cfg.Modules,
		opByName:       map[string]M{},
		store:          cfg.Store,
		authMode:       cfg.AuthMode,
		allowedOrigins: map[string]bool{},
		runners:        cfg.Runners,
		credentialHint: cfg.CredentialHint,
		env:            cfg.Env,
		appVersion:     cfg.AppVersion,
		limiter:        newRateLimiter(defaultRateLimits, func() int64 { return time.Now().UnixMilli() }),
		bootMark:       strconv.FormatInt(time.Now().UnixMilli(), 36),
	}
	if a.authMode == "" {
		a.authMode = "none"
	}
	if a.credentialHint == "" {
		a.credentialHint = "Read the app's .agent-token file (mode 0600) in the project directory."
	}
	if a.runners == nil {
		a.runners = map[string]OperationRunner{}
	}
	for _, o := range cfg.Operations {
		a.opByName[getStr(o, "name")] = o
	}
	if problems := a.modelProblems(); len(problems) > 0 {
		return nil, errors.New(
			"A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - " +
				strings.Join(problems, "\n  - "))
	}
	for _, origin := range cfg.AllowedOrigins {
		a.allowedOrigins[origin] = true
	}
	cfg.Store.putGrant(M{
		"token": cfg.Token, "credentialId": "cred_local", "agentName": "local",
		"principal": "owner", "scopes": []string{"*"},
	})
	// Seed records (materialize server-managed read-only fields) — but only
	// into a store that is genuinely fresh. A durable store that already holds
	// a database refuses the seed: re-seeding on every boot would resurrect
	// seed records the user deleted.
	if cfg.Store.WantsSeed {
		names := make([]string, 0, len(cfg.Store.Seed))
		for name := range cfg.Store.Seed {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			for _, raw := range cfg.Store.Seed[name] {
				cfg.Store.putRecord(name, a.materialize(name, raw))
			}
		}
	}
	return a, nil
}

// modelProblems is everything wrong with the app part's module/operation
// declarations. Parity oracle: `modelProblems` in
// adapters/adapter-core/src/describe.ts. Entity names are visited sorted so a
// broken model prints the same report every time.
func (a *Adapter) modelProblems() []string {
	problems := []string{}
	declared := map[string]bool{}
	for _, m := range a.modules {
		declared[getStr(m, "name")] = true
	}
	if len(a.modules) == 0 {
		problems = append(problems,
			"no modules declared: every entity and operation belongs to one, and the root screen lists them")
	}
	seen := map[string]bool{}
	for _, m := range a.modules {
		name := getStr(m, "name")
		if seen[name] {
			problems = append(problems, `duplicate module "`+name+`"`)
		}
		seen[name] = true
	}

	for _, name := range a.entityNames() {
		d := a.entityDefs[name]
		module := getStr(d, "module")
		if module == "" {
			problems = append(problems, `entity "`+name+`" declares no module`)
		} else if !declared[module] {
			problems = append(problems, `entity "`+name+`" names undeclared module "`+module+`"`)
		}
	}

	for _, o := range a.operations {
		opName := getStr(o, "name")
		module := getStr(o, "module")
		if module == "" {
			problems = append(problems, `operation "`+opName+`" declares no module`)
		} else if !declared[module] {
			problems = append(problems, `operation "`+opName+`" names undeclared module "`+module+`"`)
		}
		if _, ok := o["params"].(M); !ok {
			problems = append(problems,
				`operation "`+opName+`" declares no typed params (declare {} if it takes none)`)
		}
		entity := getStr(o, "entity")
		if entity != "" {
			d, known := a.entityDefs[entity]
			if !known {
				problems = append(problems, `operation "`+opName+`" acts on unknown entity "`+entity+`"`)
			} else {
				if getStr(d, "module") != module {
					problems = append(problems,
						`operation "`+opName+`" is in module "`+module+`" but acts on entity "`+
							entity+`" in module "`+getStr(d, "module")+`"`)
				}
				if when, ok := o["appliesWhen"].(M); ok && len(when) > 0 {
					names := map[string]bool{}
					for _, f := range fieldsOf(d) {
						names[getStr(f, "name")] = true
					}
					for _, referenced := range predicateFields(when) {
						if !names[referenced] {
							problems = append(problems,
								`operation "`+opName+`" appliesWhen reads "`+referenced+
									`", not a field of "`+entity+`"`)
						}
					}
				}
			}
		} else if when, ok := o["appliesWhen"].(M); ok && len(when) > 0 {
			problems = append(problems,
				`operation "`+opName+`" declares appliesWhen but no entity: there is no record to evaluate it against`)
		}
	}
	return problems
}

/* -- schema helpers ------------------------------------------------------- */

// entityNames is the deterministic walk order over entityDefs — a Go map has
// no declaration order to preserve, and describe output must not shuffle
// between requests.
func (a *Adapter) entityNames() []string {
	names := make([]string, 0, len(a.entityDefs))
	for name := range a.entityDefs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (a *Adapter) fields(entity string) []M {
	d, ok := a.entityDefs[entity]
	if !ok {
		return nil
	}
	return fieldsOf(d)
}

func (a *Adapter) materialize(entity string, body M) M {
	fields := a.fields(entity)
	recID := getStr(body, "id")
	if recID == "" {
		recID = "rec_" + randomHex(8)
	}
	rec := M{"id": recID}
	for _, f := range fields {
		name := getStr(f, "name")
		if v, ok := body[name]; ok && v != nil && v != "" {
			rec[name] = coerce(f, v)
		} else if getBool(f, "readOnly") && name == "created" {
			rec[name] = nowISO()
		}
	}
	return rec
}

func (a *Adapter) schemaVersion() string {
	prints := map[string]M{}
	for name, d := range a.entityDefs {
		prints[name] = M{"fields": fieldsOf(d), "auth": getBool(d, "auth"), "module": getStr(d, "module")}
	}
	return schemaFingerprint(prints, a.operations)
}

func (a *Adapter) dataVersion() string {
	return a.bootMark + "." + strconv.FormatInt(a.dataWrites.Load(), 10)
}

func (a *Adapter) markDataChanged() { a.dataWrites.Add(1) }

/* -- envelopes ------------------------------------------------------------- */

func errEnv(status int, code, message string, extra M) (int, M) {
	body := M{"a2app": true, "ok": false, "code": code, "message": message}
	for k, v := range extra {
		body[k] = v
	}
	return status, body
}

/* -- identity / describe ---------------------------------------------------- */

func (a *Adapter) identity() M {
	doc := M{
		"a2app": true, "protocol": PROTOCOL_VERSION, "adapterVersion": ADAPTER_VERSION,
		"app": M{"id": a.appID, "name": a.appName}, "schemaVersion": a.schemaVersion(),
		// Moves on every record write. A View watcher compares this separately
		// from appVersion/schemaVersion so it can re-read data without reloading.
		"dataVersion": a.dataVersion(),
		"serverNow":   nowISO(), "serverTzOffsetMinutes": 0,
	}
	if a.env != "" {
		doc["env"] = a.env
	}
	// Published only when the app actually has one: a field that is sometimes
	// an empty string would make a client's "did it change?" comparison lie the
	// first time the app could not compute it.
	if a.appVersion != nil {
		if v := a.appVersion(); v != "" {
			doc["appVersion"] = v
		}
	}
	return doc
}

/* -- navigational describe (A2APP-SPEC 3) ----------------------------------- */
// One request answers for one place in the app, never for the whole app.
// Parity oracle: adapters/adapter-core/src/describe.ts.

type accessView struct {
	read  func(entity string) bool
	write func(entity string) bool
	run   func(op string) bool
}

func fieldDoc(f M) M {
	field := M{"type": getStr(f, "type")}
	if getBool(f, "required") {
		field["required"] = true
	}
	if getBool(f, "readOnly") {
		field["readOnly"] = true
	}
	if max, ok := f["max"]; ok && max != nil {
		field["max"] = max
	}
	if values := toAnyList(f["values"]); len(values) > 0 {
		field["values"] = f["values"]
	}
	if getStr(f, "entity") != "" {
		field["entity"] = getStr(f, "entity")
	}
	if getBool(f, "dayKey") {
		field["format"] = "YYYY-MM-DD"
	}
	return field
}

// readableFields is everything except write-only.
//
// Load-bearing beyond describe: a client treats a field absent here as
// write-only and exempts it from the read-back check, so dropping anything
// else would quietly disable that backstop.
func readableFields(d M) []M {
	out := []M{}
	for _, f := range fieldsOf(d) {
		if !getBool(f, "writeOnly") {
			out = append(out, f)
		}
	}
	return out
}

// fitList trims a list until the level fits, always reporting what was dropped.
func fitList(build func(items []M, truncated int) M, items []M) M {
	whole := build(append([]M{}, items...), 0)
	if len(stableJSON(whole)) <= describeBudgetChars {
		return whole
	}
	lo, hi := 0, len(items)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if len(stableJSON(build(items[:mid], len(items)-mid))) <= describeBudgetChars {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return build(items[:lo], len(items)-lo)
}

func (a *Adapter) entitiesOf(module string) []string {
	out := []string{}
	for _, name := range a.entityNames() {
		if getStr(a.entityDefs[name], "module") == module {
			out = append(out, name)
		}
	}
	return out
}

func (a *Adapter) describeRoot(access accessView) M {
	modules := []M{}
	for _, m := range a.modules {
		name := getStr(m, "name")
		owned := a.entitiesOf(name)
		ops := []M{}
		for _, o := range a.operations {
			if getStr(o, "module") == name {
				ops = append(ops, o)
			}
		}
		readable, writable := 0, 0
		for _, n := range owned {
			if access.read(n) {
				readable++
			}
			if access.write(n) {
				writable++
			}
		}
		runnable := 0
		for _, o := range ops {
			if access.run(getStr(o, "name")) {
				runnable++
			}
		}
		var reach string
		switch {
		case len(owned) == 0 && runnable == 0:
			reach = "none"
		case len(owned) == 0:
			reach = "full"
		case readable == 0 && runnable == 0:
			reach = "none"
		case writable == len(owned) && runnable == len(ops):
			reach = "full"
		default:
			reach = "read-only"
		}
		row := M{"name": name, "entities": len(owned), "operations": len(ops), "access": reach}
		if getStr(m, "summary") != "" {
			row["summary"] = getStr(m, "summary")
		}
		modules = append(modules, row)
	}
	return M{
		"level":       "root",
		"app":         M{"id": a.appID, "name": a.appName},
		"modules":     modules,
		"conventions": conventions(),
		"next":        []string{"describe/{module}", "describe?find={term}"},
	}
}

func (a *Adapter) describeModule(module M, access accessView, showAll bool) M {
	moduleName := getStr(module, "name")
	owned := []M{}
	for _, name := range a.entitiesOf(moduleName) {
		if !access.read(name) {
			continue
		}
		row := M{"name": name}
		if getStr(a.entityDefs[name], "summary") != "" {
			row["summary"] = getStr(a.entityDefs[name], "summary")
		}
		owned = append(owned, row)
	}
	ops := []M{}
	for _, o := range a.operations {
		if getStr(o, "module") != moduleName || getStr(o, "entity") != "" {
			continue
		}
		if !access.run(getStr(o, "name")) {
			continue
		}
		row := M{"name": getStr(o, "name"), "destructive": getBool(o, "destructive")}
		if getStr(o, "description") != "" {
			row["summary"] = getStr(o, "description")
		}
		ops = append(ops, row)
	}

	baseNext := []string{"describe/" + moduleName + "/{entity}"}
	if len(ops) > 0 {
		baseNext = append(baseNext, moduleName+" <operation> [--params]")
	}

	build := func(entityRows []M, truncated int) M {
		next := append([]string{}, baseNext...)
		if truncated > 0 {
			next = append(next, "describe/"+moduleName+"?all=true")
		}
		level := M{
			"level":      "module",
			"path":       moduleName,
			"entities":   entityRows,
			"operations": ops,
			"next":       next,
		}
		if getStr(module, "summary") != "" {
			level["summary"] = getStr(module, "summary")
		}
		if truncated > 0 {
			level["truncated"] = truncated
		}
		return level
	}

	if showAll {
		return build(owned, 0)
	}
	return fitList(build, owned)
}

func (a *Adapter) describeEntity(module, name string, d M, access accessView) M {
	fields := M{}
	for _, f := range readableFields(d) {
		fields[getStr(f, "name")] = fieldDoc(f)
	}
	ops := []M{}
	for _, o := range a.operations {
		if getStr(o, "entity") != name || !access.run(getStr(o, "name")) {
			continue
		}
		decl := M{"name": getStr(o, "name"), "destructive": getBool(o, "destructive"), "params": o["params"]}
		if getStr(o, "description") != "" {
			decl["description"] = getStr(o, "description")
		}
		if getBool(o, "readOnly") {
			decl["readOnly"] = true
		}
		if getBool(o, "idempotent") {
			decl["idempotent"] = true
		}
		decl["entity"] = name
		ops = append(ops, decl)
	}
	level := M{
		"level":      "entity",
		"path":       module + "/" + name,
		"label":      labelFieldOf(fieldsOf(d)),
		"records":    "/api/collections/" + name + "/records",
		"fields":     fields,
		"operations": ops,
		"next":       []string{"describe/" + module + "/" + name + "/{id}", "data " + name + " list"},
	}
	if getBool(d, "auth") {
		level["auth"] = true
	}
	return level
}

func (a *Adapter) describeRecord(module, name string, d M, record M, access accessView) M {
	fields := readableFields(d)
	labelField := labelFieldOf(fieldsOf(d))
	var label any
	if lf, ok := labelField.(string); ok {
		label = record[lf]
	}
	if label != nil {
		if _, ok := label.(string); !ok {
			label = toStr(label)
		}
	}

	ops := []M{}
	for _, o := range a.operations {
		if getStr(o, "entity") != name || !access.run(getStr(o, "name")) {
			continue
		}
		row := M{"name": getStr(o, "name"), "available": true}
		if getBool(o, "destructive") {
			row["destructive"] = true
		}
		if when, ok := o["appliesWhen"].(M); ok && len(when) > 0 && !evaluatePredicate(when, record, fields) {
			row["available"] = false
			row["blocked"] = explainPredicate(when, record, fields)
		}
		ops = append(ops, row)
	}

	// Sub-resources are the record's own list<ref> fields: a forward relation
	// is derivable from the type vocabulary alone, with no query grammar.
	relations := []M{}
	for _, f := range fields {
		if getStr(f, "type") != "list<ref>" || getStr(f, "entity") == "" {
			continue
		}
		row := M{"name": getStr(f, "name"), "entity": getStr(f, "entity")}
		if value := toAnyList(record[getStr(f, "name")]); record[getStr(f, "name")] != nil && value != nil {
			row["count"] = len(value)
		}
		relations = append(relations, row)
	}

	path := module + "/" + name + "/" + getStr(record, "id")
	next := []string{}
	for _, r := range relations {
		next = append(next, "describe/"+path+"/"+getStr(r, "name"))
	}
	for _, o := range ops {
		if getBool(o, "available") {
			next = append(next, path+" "+getStr(o, "name"))
		}
	}
	next = append(next, "data "+name+" get "+getStr(record, "id"))
	level := M{
		"level":      "record",
		"path":       path,
		"id":         record["id"],
		"label":      label,
		"operations": ops,
		"next":       next,
	}
	if len(relations) > 0 {
		level["relations"] = relations
	}
	return level
}

func (a *Adapter) describeFind(term string, access accessView) M {
	needle := strings.ToLower(term)
	matches := []M{}
	for _, m := range a.modules {
		if strings.Contains(strings.ToLower(getStr(m, "name")), needle) {
			matches = append(matches, M{"path": getStr(m, "name"), "level": "module"})
		}
	}
	for _, name := range a.entityNames() {
		d := a.entityDefs[name]
		if access.read(name) && strings.Contains(strings.ToLower(name), needle) {
			matches = append(matches, M{"path": getStr(d, "module") + "/" + name, "level": "entity"})
		}
	}
	for _, o := range a.operations {
		if access.run(getStr(o, "name")) && strings.Contains(strings.ToLower(getStr(o, "name")), needle) {
			path := getStr(o, "module")
			if getStr(o, "entity") != "" {
				path = getStr(o, "module") + "/" + getStr(o, "entity")
			}
			matches = append(matches, M{"path": path, "operation": getStr(o, "name")})
		}
	}

	build := func(items []M, truncated int) M {
		level := M{"level": "find", "term": term, "matches": items, "next": []string{"describe/{path}"}}
		if truncated > 0 {
			level["truncated"] = truncated
		}
		return level
	}
	return fitList(build, matches)
}

func conventions() M {
	return M{
		"writes": "Prefer a declared operation over a raw write where one exists.",
		"labels": "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
		"dates":  `Relative words ("tomorrow") are rejected by the app; resolve them to ISO 8601 client-side.`,
		"honesty": "If the app cannot express what was asked, say so instead of approximating into a wrong field.",
	}
}

/* -- IAM -------------------------------------------------------------------- */

func (a *Adapter) expandScopes(grant M) map[string]bool {
	scopes := map[string]bool{}
	declared, _ := grant["scopes"].([]string)
	if declared == nil {
		for _, s := range toAnyList(grant["scopes"]) {
			declared = append(declared, toStr(s))
		}
	}
	if !contains(declared, "*") {
		for _, s := range declared {
			scopes[s] = true
		}
		return scopes
	}
	for name := range a.entityDefs {
		scopes["data:"+name+":read"] = true
		scopes["data:"+name+":write"] = true
	}
	for _, o := range a.operations {
		scopes["op:"+getStr(o, "name")] = true
	}
	return scopes
}

func (a *Adapter) credentialOf(headers map[string]string) M {
	token := headers["x-a2app-token"]
	if token == "" {
		token = headers["x-lui-token"]
	}
	if token == "" {
		return nil
	}
	return a.store.grantByToken(token)
}

// authorize runs the fixed precedence: origin, then credential, then scope.
// A nil errBody means the caller may proceed with ctx.
func (a *Adapter) authorize(headers map[string]string, scope string, isWrite bool) (ctx M, status int, errBody M) {
	origin, hasOrigin := headers["origin"]
	if hasOrigin && !a.allowedOrigins[origin] {
		s, b := errEnv(403, "forbidden_origin", "Refused: request Origin is not this app's own.", nil)
		return nil, s, b
	}
	if hasOrigin && a.allowedOrigins[origin] {
		return M{"credentialId": "ui", "agentName": nil, "principal": "owner"}, 0, nil
	}
	grant := a.credentialOf(headers)
	required := isWrite || a.authMode == "multi-user"
	if grant == nil {
		if required {
			s, b := errEnv(401, codeAgentTokenRequired, "This write requires an agent credential.", M{"how": a.credentialHint})
			return nil, s, b
		}
		return M{"credentialId": "anonymous", "agentName": nil, "principal": "owner"}, 0, nil
	}
	if scope != "" {
		if !a.expandScopes(grant)[scope] {
			s, b := errEnv(403, codeInsufficientScope, "This credential does not hold "+scope+".", M{"required": scope})
			return nil, s, b
		}
	}
	return M{"credentialId": grant["credentialId"], "agentName": grant["agentName"], "principal": grant["principal"]}, 0, nil
}

func (a *Adapter) rateGate(headers map[string]string, cls string) (int, M) {
	caller := headers["x-a2app-token"]
	if caller == "" {
		if origin, ok := headers["origin"]; ok {
			caller = "origin:" + origin
		} else {
			caller = "anon"
		}
	}
	decision := a.limiter.check(caller, cls)
	if decision.allowed {
		return 0, nil
	}
	return errEnv(429, codeRateLimited,
		fmt.Sprintf("Rate limit exceeded (%d per window). Slow down and retry.", decision.limit),
		M{"retryAfterSeconds": decision.retryAfterSeconds})
}

// isSameOrigin is true when the request carries one of the app's OWN origins —
// the trusted browser-UI path authorize also honours.
func (a *Adapter) isSameOrigin(headers map[string]string) bool {
	origin, ok := headers["origin"]
	return ok && a.allowedOrigins[origin]
}

/* -- dispatch ---------------------------------------------------------------- */

// accessFor is what this caller may do, for rendering access on a describe
// level. Mirrors authorize's precedence including its two bypasses — the app's
// own UI and an anonymous read on a single-user app both reach a context
// without meeting the scope check, so both genuinely have full access.
func (a *Adapter) accessFor(headers map[string]string) accessView {
	if a.isSameOrigin(headers) {
		return accessView{
			read:  func(string) bool { return true },
			write: func(string) bool { return true },
			run:   func(string) bool { return true },
		}
	}
	grant := a.credentialOf(headers)
	if grant == nil {
		allow := a.authMode != "multi-user"
		return accessView{
			read:  func(string) bool { return allow },
			write: func(string) bool { return allow },
			run:   func(string) bool { return allow },
		}
	}
	held := a.expandScopes(grant)
	return accessView{
		read:  func(e string) bool { return held["data:"+e+":read"] },
		write: func(e string) bool { return held["data:"+e+":write"] },
		run:   func(o string) bool { return held["op:"+o] },
	}
}

// handleDescribe serves one level of describe.
//
// The record and relation levels read real records, which makes them data
// reads: they take the same scope and rate class as the records API. Without
// that, describe would be an unmetered path around the scope model.
func (a *Adapter) handleDescribe(headers map[string]string, segments []string, q map[string]string) (int, M) {
	access := a.accessFor(headers)

	find, hasFind := q["find"]
	if hasFind && len(segments) == 0 {
		if find == "" {
			return errEnv(400, "usage", "find needs a term: describe?find={term}", nil)
		}
		return 200, a.describeFind(find, access)
	}

	if len(segments) == 0 {
		return 200, a.describeRoot(access)
	}

	moduleName := segments[0]
	var module M
	for _, m := range a.modules {
		if getStr(m, "name") == moduleName {
			module = m
			break
		}
	}
	if module == nil {
		names := []string{}
		for _, m := range a.modules {
			names = append(names, getStr(m, "name"))
		}
		return errEnv(404, "unknown_module", `No module "`+moduleName+`".`, M{"modules": names})
	}
	if len(segments) == 1 {
		return 200, a.describeModule(module, access, q["all"] == "true")
	}

	entity := segments[1]
	d, known := a.entityDefs[entity]
	if !known {
		return errEnv(404, "unknown_entity", `No such entity "`+entity+`".`, nil)
	}
	if getStr(d, "module") != moduleName {
		return errEnv(404, "unknown_entity",
			`Entity "`+entity+`" is in module "`+getStr(d, "module")+`", not "`+moduleName+`".`, nil)
	}
	if len(segments) == 2 {
		if !access.read(entity) {
			return errEnv(403, codeInsufficientScope,
				"This credential does not hold data:"+entity+":read.",
				M{"required": "data:" + entity + ":read"})
		}
		return 200, a.describeEntity(moduleName, entity, d, access)
	}

	if status, body := a.rateGate(headers, "data"); body != nil {
		return status, body
	}
	if _, status, body := a.authorize(headers, "data:"+entity+":read", false); body != nil {
		return status, body
	}

	recordID := segments[2]
	record := a.store.getRecord(entity, recordID)
	if record == nil {
		return errEnv(404, "record_not_found", "No "+entity+` record "`+recordID+`".`, nil)
	}
	if len(segments) == 3 {
		return 200, a.describeRecord(moduleName, entity, d, record, access)
	}

	relation := segments[3]
	var field M
	for _, f := range fieldsOf(d) {
		if getStr(f, "name") == relation && getStr(f, "type") == "list<ref>" &&
			getStr(f, "entity") != "" && !getBool(f, "writeOnly") {
			field = f
			break
		}
	}
	if field == nil {
		return errEnv(404, "unknown_relation", `"`+relation+`" is not a sub-resource of `+entity+".", nil)
	}
	target := getStr(field, "entity")
	if !access.read(target) {
		return errEnv(403, codeInsufficientScope,
			"This credential does not hold data:"+target+":read.",
			M{"required": "data:" + target + ":read"})
	}
	var targetLabel any
	if targetDef, ok := a.entityDefs[target]; ok {
		targetLabel = labelFieldOf(fieldsOf(targetDef))
	}
	items := []M{}
	for _, rid := range toAnyList(record[relation]) {
		id := toStr(rid)
		referenced := a.store.getRecord(target, id)
		var label any
		if lf, ok := targetLabel.(string); ok && referenced != nil {
			label = referenced[lf]
		}
		if label != nil {
			if _, ok := label.(string); !ok {
				label = toStr(label)
			}
		}
		items = append(items, M{"id": id, "label": label})
	}

	path := moduleName + "/" + entity + "/" + recordID + "/" + relation
	build := func(rows []M, truncated int) M {
		level := M{
			"level": "relation", "path": path, "entity": target, "items": rows,
			"next": []string{"data " + target + " get {id}", "describe/" + moduleName + "/" + entity + "/" + recordID},
		}
		if truncated > 0 {
			level["truncated"] = truncated
		}
		return level
	}
	return 200, fitList(build, items)
}

var recordsRe = regexp.MustCompile(`^/api/collections/([^/]+)/records(?:/([^/]+))?$`)
var opsRe = regexp.MustCompile(`^/api/ops/([^/]+)$`)
var trailingSlashRe = regexp.MustCompile(`/+$`)

// dispatch routes one protocol request: method, path, lower-cased headers,
// parsed JSON body, query. It returns the status and the JSON payload.
func (a *Adapter) dispatch(method, path string, headers map[string]string, body M, query map[string]string) (int, M) {
	lowered := map[string]string{}
	for k, v := range headers {
		lowered[strings.ToLower(k)] = v
	}
	headers = lowered
	method = strings.ToUpper(method)
	q := map[string]string{}
	for k, v := range query {
		q[k] = v
	}
	if i := strings.Index(path, "?"); i >= 0 {
		if values, err := url.ParseQuery(path[i+1:]); err == nil {
			for k, v := range values {
				if len(v) > 0 {
					q[k] = v[len(v)-1]
				}
			}
		}
		path = path[:i]
	}
	path = trailingSlashRe.ReplaceAllString(path, "")
	if path == "" {
		path = "/"
	}

	if path == "/.well-known/a2app.json" || path == "/api/_a2app" {
		return 200, a.identity()
	}
	// Describe is navigational: the bare path is the root level, and each
	// extra segment moves one level inward (A2APP-SPEC 3).
	if path == "/api/_a2app/describe" {
		return a.handleDescribe(headers, nil, q)
	}
	if strings.HasPrefix(path, "/api/_a2app/describe/") {
		raw := strings.Split(path[len("/api/_a2app/describe/"):], "/")
		segments := make([]string, 0, len(raw))
		for _, s := range raw {
			if u, err := url.PathUnescape(s); err == nil {
				segments = append(segments, u)
			} else {
				segments = append(segments, s)
			}
		}
		if len(segments) > 4 {
			return errEnv(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.", nil)
		}
		for _, s := range segments {
			if s == "" {
				return errEnv(404, "usage", "describe path has an empty segment.", nil)
			}
		}
		return a.handleDescribe(headers, segments, q)
	}
	if path == "/api/_a2app/whoami" {
		grant := a.credentialOf(headers)
		if grant == nil {
			return errEnv(401, codeAgentTokenRequired, "whoami requires a credential.", nil)
		}
		scopes := []string{}
		for s := range a.expandScopes(grant) {
			scopes = append(scopes, s)
		}
		sort.Strings(scopes)
		return 200, M{
			"a2app": true, "credentialId": grant["credentialId"], "agentName": grant["agentName"],
			"principal": grant["principal"], "scopes": scopes,
		}
	}
	if path == "/api/_a2app/context" {
		if _, status, errBody := a.authorize(headers, "", false); errBody != nil {
			return status, errBody
		}
		return 200, M{"a2app": true, "view": nil, "selected": []any{}}
	}
	if path == "/api/_a2app/events" {
		return a.handleEvents(method, headers, q)
	}
	if path == "/api/_a2app/tasks" || strings.HasPrefix(path, "/api/_a2app/tasks/") {
		rest := []string{}
		if path != "/api/_a2app/tasks" {
			rest = strings.Split(path[len("/api/_a2app/tasks/"):], "/")
		}
		return a.handleTasks(method, headers, rest, body, q)
	}

	if m := recordsRe.FindStringSubmatch(path); m != nil {
		return a.handleRecords(method, headers, m[1], m[2], body, q)
	}

	if m := opsRe.FindStringSubmatch(path); m != nil {
		if method != "POST" {
			return errEnv(405, "usage", "Operations are POST-only.", nil)
		}
		if body == nil {
			body = M{}
		}
		return a.handleOperation(headers, m[1], body)
	}

	return errEnv(404, "not_found", "No such route.", nil)
}

/* -- records ------------------------------------------------------------------ */

// referencesTo answers who still points at this record.
//
// Every `ref` and `list<ref>` names the entity it targets, so the app has
// ALREADY declared where its references live — this reads that rather than
// asking for a second declaration.
//
// Pages through referencing entities instead of filtering in the store: a
// filter grammar differs per backend, and a policy that silently did nothing
// against one of them would be worse than no policy. Only entities that
// actually declare a `restrict` ref to this one are read, so an entity nothing
// points at costs nothing.
func (a *Adapter) referencesTo(entity, recID string) []M {
	blockers := []M{}
	for _, other := range a.entityNames() {
		d := a.entityDefs[other]
		pointing := []M{}
		for _, f := range fieldsOf(d) {
			ftype := getStr(f, "type")
			onDelete := getStr(f, "onDelete")
			if onDelete == "" {
				onDelete = defaultOnDelete
			}
			if (ftype == "ref" || ftype == "list<ref>") && getStr(f, "entity") == entity && onDelete == "restrict" {
				pointing = append(pointing, f)
			}
		}
		if len(pointing) == 0 {
			continue
		}

		found := map[string][]string{}
		page := 1
		for {
			result, err := a.store.listRecords(other, M{"page": page, "perPage": referenceScanPage})
			if err != nil {
				break
			}
			items := toMList(result["items"])
			for _, row := range items {
				for _, f := range pointing {
					value := row[getStr(f, "name")]
					hit := false
					if list := toAnyList(value); value != nil && list != nil {
						for _, el := range list {
							if s, ok := el.(string); ok && s == recID {
								hit = true
								break
							}
						}
					} else if s, ok := value.(string); ok && s == recID {
						hit = true
					}
					if !hit {
						continue
					}
					ids := found[getStr(f, "name")]
					if len(ids) < referenceScanLimit {
						found[getStr(f, "name")] = append(ids, toStr(row["id"]))
					}
				}
			}
			if len(items) < referenceScanPage {
				break
			}
			page++
			if page > referenceScanMaxPages {
				break
			}
		}

		// Report in field-declaration order, so the same block reads the same way
		// on every run.
		for _, f := range pointing {
			name := getStr(f, "name")
			if ids, ok := found[name]; ok {
				blockers = append(blockers, M{"entity": other, "field": name, "ids": ids})
			}
		}
	}
	return blockers
}

func queryToM(query map[string]string) M {
	out := M{}
	for k, v := range query {
		out[k] = v
	}
	return out
}

func (a *Adapter) handleRecords(method string, headers map[string]string, entity, recID string, body M, query map[string]string) (int, M) {
	if status, limited := a.rateGate(headers, "data"); limited != nil {
		return status, limited
	}
	d, known := a.entityDefs[entity]
	if !known {
		return errEnv(404, "unknown_entity", `No such entity "`+entity+`".`, nil)
	}
	fields := fieldsOf(d)
	serverNow := nowISO()

	if method == "GET" {
		if _, status, errBody := a.authorize(headers, "data:"+entity+":read", false); errBody != nil {
			return status, errBody
		}
		if recID != "" {
			rec := a.store.getRecord(entity, recID)
			if rec == nil {
				return errEnv(404, "record_not_found", "No "+entity+` record "`+recID+`".`, nil)
			}
			return 200, rec
		}
		result, err := a.store.listRecords(entity, queryToM(query))
		if err != nil {
			// Refuse, never ignore: unfiltered rows under a filter would be a
			// 200 with the wrong records (see the grammar's comment).
			return errEnv(400, "invalid_filter", err.Error(), nil)
		}
		return 200, result
	}

	_, status, errBody := a.authorize(headers, "data:"+entity+":write", true)
	if errBody != nil {
		return status, errBody
	}
	if body == nil {
		body = M{}
	}

	if method == "DELETE" {
		if recID == "" {
			return errEnv(400, "usage", "DELETE requires a record id.", nil)
		}

		// The app's referential rules bind THIS door too.
		//
		// An app that guards deletion inside an operation has guarded one way
		// in: its own UI. This generic record route is the other, and it used
		// to go straight to the store — so the rule held right up until an
		// agent took the path the rule did not cover, and the orphan it left
		// was reported as a successful delete. The check belongs here, in
		// adapter code an app author cannot edit, because this is the only
		// place both doors pass through.
		blockers := a.referencesTo(entity, recID)
		if len(blockers) > 0 {
			total := 0
			where := []string{}
			for _, b := range blockers {
				ids, _ := b["ids"].([]string)
				total += len(ids)
				where = append(where, getStr(b, "entity")+"."+getStr(b, "field"))
			}
			said := "a record still references"
			if total != 1 {
				said = fmt.Sprintf("%d records still reference", total)
			}
			return errEnv(409, codeRecordReferenced,
				"Cannot delete "+entity+` "`+recID+`": `+said+" it ("+strings.Join(where, ", ")+").",
				M{
					"referencedBy": blockers,
					"resolution": "Remove or repoint the referencing records first, or run an operation the app " +
						"provides for this. An app that intends references to outlive the record " +
						"declares `onDelete: \"ignore\"` on the ref.",
				})
		}

		if !a.store.deleteRecord(entity, recID) {
			return errEnv(404, "record_not_found", "No "+entity+` record "`+recID+`".`, nil)
		}
		a.markDataChanged()
		return 200, M{"a2app": true, "ok": true, "deleted": recID}
	}

	if method != "POST" && method != "PATCH" {
		return errEnv(405, "usage", method+" not allowed on records.", nil)
	}

	idem := headers["idempotency-key"]
	if idem != "" && method == "POST" {
		if prior := a.store.idemGet(entity, idem); prior != "" {
			return errEnv(409, codeDuplicateRequest, "This idempotency key already produced a record.", M{"id": prior})
		}
	}

	allow := map[string]bool{}
	for _, k := range toAnyList(d["writeAllow"]) {
		allow[toStr(k)] = true
	}
	violations := validate(fields, body, allow)
	if len(violations) > 0 {
		first := violations[0]
		return 400, M{
			"a2app": true, "ok": false, "code": first["code"], "field": first["field"],
			"expected": first["expected"], "got": first["got"],
			"message":    describeViolation(first, serverNow),
			"violations": violations,
		}
	}

	var stored M
	if method == "POST" {
		stored = a.materialize(entity, body)
		a.store.putRecord(entity, stored)
	} else {
		if recID == "" {
			return errEnv(400, "usage", "PATCH requires a record id.", nil)
		}
		existing := a.store.getRecord(entity, recID)
		if existing == nil {
			return errEnv(404, "record_not_found", "No "+entity+` record "`+recID+`".`, nil)
		}
		for _, f := range fields {
			name := getStr(f, "name")
			if getBool(f, "readOnly") || !hasKey(body, name) {
				continue
			}
			v := body[name]
			if v == nil || v == "" {
				delete(existing, name)
			} else {
				existing[name] = coerce(f, v)
			}
		}
		a.store.putRecord(entity, existing)
		stored = existing
	}

	lost := divergences(fields, body, func(n string) any { return stored[n] })
	if len(lost) > 0 {
		lostViolations := []M{}
		for _, l := range lost {
			lostViolations = append(lostViolations, M{"code": codeNotStored, "field": l["field"]})
		}
		return 422, M{
			"a2app": true, "ok": false, "code": codeNotStored,
			"message":    describeIncomplete(lost),
			"violations": lostViolations,
			"id":         stored["id"],
		}
	}

	if idem != "" && method == "POST" {
		a.store.idemPut(entity, idem, getStr(stored, "id"))
	}
	a.markDataChanged()
	return 200, stored
}

/* -- operations ----------------------------------------------------------------- */

func (a *Adapter) handleOperation(headers map[string]string, name string, args M) (int, M) {
	if status, limited := a.rateGate(headers, "ops"); limited != nil {
		return status, limited
	}
	decl, known := a.opByName[name]
	if !known {
		return errEnv(404, "unknown_operation", `No declared operation "`+name+`".`, nil)
	}
	ctx, status, errBody := a.authorize(headers, "op:"+name, !getBool(decl, "readOnly"))
	if errBody != nil {
		return status, errBody
	}

	if getBool(decl, "destructive") {
		key := approvalKeyFor(name, args)
		provided := headers["x-a2app-approval"]
		if provided == "" {
			provided = headers["x-lui-approval"]
		}
		if provided == "" {
			a.store.approvalIssue(key)
			return errEnv(428, codeApprovalRequired,
				`Operation "`+name+`" is destructive and requires approval.`, M{"approvalKey": key})
		}
		if provided != key || !a.store.approvalConsume(key) {
			return errEnv(428, codeApprovalRequired,
				"Approval key does not match this exact call (or has expired).", M{"approvalKey": key})
		}
	}

	runner, ok := a.runners[name]
	if !ok || runner == nil {
		return errEnv(501, "not_implemented", `This app declares "`+name+`" but implements no operation runner.`, nil)
	}
	result, err := a.runOperation(runner, args, ctx)
	if err != nil {
		return errEnv(500, "operation_failed", `Operation "`+name+`" threw: `+err.Error(), nil)
	}
	if !getBool(decl, "readOnly") {
		a.markDataChanged()
	}
	return 200, M{"a2app": true, "ok": true, "operation": name, "result": result}
}

// runOperation shields the surface from a runner that panics: app code failing
// must answer operation_failed, never take the process down mid-request.
func (a *Adapter) runOperation(runner OperationRunner, args M, ctx M) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return runner(args, ctx, a.store)
}

/* -- tasks / events ---------------------------------------------------------------- */

func (a *Adapter) handleEvents(method string, headers map[string]string, query map[string]string) (int, M) {
	if status, limited := a.rateGate(headers, "data"); limited != nil {
		return status, limited
	}
	if _, status, errBody := a.authorize(headers, "", false); errBody != nil {
		return status, errBody
	}
	res := a.store.eventsSince(query["since"])
	events := []M{}
	for _, e := range toMList(res["events"]) {
		events = append(events, M{
			"id": e["id"], "app": e["app"], "type": e["type"],
			"payload": e["payload"], "createdAt": e["createdAt"],
		})
	}
	return 200, M{"a2app": true, "events": events, "nextCursor": res["nextCursor"], "pollAfterMs": 3000}
}

func (a *Adapter) handleTasks(method string, headers map[string]string, rest []string, body M, query map[string]string) (int, M) {
	if status, limited := a.rateGate(headers, "data"); limited != nil {
		return status, limited
	}
	ctx, status, errBody := a.authorize(headers, "", method != "GET")
	if errBody != nil {
		return status, errBody
	}

	if len(rest) == 0 && method == "GET" {
		tasks := []M{}
		for _, t := range a.store.listTasks(query["status"]) {
			tasks = append(tasks, taskWire(t))
		}
		return 200, M{"a2app": true, "tasks": tasks, "pollAfterMs": 2000}
	}
	taskID := ""
	if len(rest) > 0 {
		taskID = rest[0]
	}
	if taskID == "" {
		return errEnv(400, "usage", "Task id required.", nil)
	}
	action := ""
	hasAction := len(rest) > 1
	if hasAction {
		action = rest[1]
	}
	task := a.store.getTask(taskID)
	if task == nil {
		return errEnv(404, codeTaskNotFound, `No task "`+taskID+`".`, nil)
	}
	if !hasAction && method == "GET" {
		return 200, taskWire(task)
	}
	if method != "POST" {
		return errEnv(405, "usage", method+" not allowed here.", nil)
	}
	if body == nil {
		body = M{}
	}

	switch action {
	case "claim":
		if getStr(task, "status") != "submitted" {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" is "+getStr(task, "status")+", not claimable.", nil)
		}
		task["status"] = "working"
		task["claim"] = M{"credentialId": ctx["credentialId"], "principal": ctx["principal"], "claimedAt": nowISO()}
		a.store.saveTask(task)
		return 200, taskWire(task)
	case "progress":
		if getStr(task, "status") == "canceled" {
			return errEnv(409, codeTaskCanceled, "Task "+taskID+" was canceled.", nil)
		}
		if getStr(task, "status") != "working" && getStr(task, "status") != "input-required" {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" is "+getStr(task, "status")+".", nil)
		}
		progress, _ := task["progress"].(M)
		if progress == nil {
			progress = M{}
			task["progress"] = progress
		}
		if step, ok := body["step"].(string); ok {
			progress["step"] = step
		}
		if percent, ok := asFloat(body["percent"]); ok {
			progress["percent"] = percent
		}
		if body["ask"] != nil {
			task["ask"] = body["ask"]
			task["status"] = "input-required"
		} else if getStr(task, "status") == "input-required" {
			task["status"] = "working"
		}
		a.store.saveTask(task)
		return 200, taskWire(task)
	case "complete":
		if getStr(task, "status") == "canceled" {
			return errEnv(409, codeTaskCanceled, "Task "+taskID+" was canceled.", nil)
		}
		switch getStr(body, "status") {
		case "completed":
			task["status"] = "completed"
			if truthy(body["result"]) {
				task["result"] = body["result"]
			} else {
				task["result"] = M{}
			}
		case "failed":
			task["status"] = "failed"
			if reason, ok := body["reason"].(string); ok {
				task["reason"] = reason
			} else {
				task["reason"] = "unspecified"
			}
		default:
			return errEnv(400, "usage", `complete requires status "completed" or "failed".`, nil)
		}
		a.store.saveTask(task)
		return 200, taskWire(task)
	case "cancel":
		task["status"] = "canceled"
		a.store.saveTask(task)
		return 200, taskWire(task)
	}
	return errEnv(404, "usage", `Unknown task action "`+action+`".`, nil)
}

func taskWire(t M) M {
	return M{
		"id": t["id"], "app": t["app"], "event": t["event"], "status": t["status"],
		"request": t["request"], "claim": t["claim"], "progress": t["progress"],
		"result": t["result"], "reason": t["reason"], "createdAt": t["createdAt"],
		"updatedAt": t["updatedAt"], "pollAfterMs": 2000,
	}
}

/* -- app -> agent -------------------------------------------------------------------- */

func (a *Adapter) trigger(etype string, payload M, capability string) M {
	ev := a.store.appendEvent(etype, payload)
	var taskID any
	if capability != "" {
		taskID = a.store.enqueueTask(getStr(ev, "id"), capability, payload)["id"]
	}
	return M{"eventId": ev["id"], "taskId": taskID}
}

/* ------------------------------------------------------------------ self-test */
// Rules-parity oracle, run by the toolkit gate (`go run . --selftest`). Its job
// is to prove this port, the Python port and `@a2app/rules` agree, so a Go app
// and a Node app reject identical payloads identically and block identical
// operations for identical stated reasons.
//
// Until the Python original existed, that gate step ran, imported the module,
// and exited 0 without asserting anything — a vacuously passing check, which is
// worse than no check because it reads as coverage.

func selftest() int {
	failures := []string{}

	check := func(label string, actual, expected any) {
		if !reflect.DeepEqual(actual, expected) {
			failures = append(failures, fmt.Sprintf("%s\n    expected: %#v\n    actual:   %#v", label, expected, actual))
		}
	}

	fields := []M{
		{"name": "title", "type": "string", "required": true, "max": 200},
		{"name": "status", "type": "enum", "values": []string{"todo", "doing", "done"}},
		{"name": "due", "type": "string", "max": 10, "dayKey": true},
		{"name": "created", "type": "datetime", "readOnly": true},
	}

	// 1. Guard: every violation, by code, sorted.
	bad := M{"nope": 1, "created": "x", "status": "nonsense", "due": "31-12-2026"}
	codes := []string{}
	for _, v := range validate(fields, bad, nil) {
		codes = append(codes, getStr(v, "code"))
	}
	sort.Strings(codes)
	check("guard reports every violation", codes,
		[]string{"invalid_daykey", "invalid_enum", "read_only_field", "unknown_field"})
	check("a good body yields no violations",
		len(validate(fields, M{"title": "ok", "status": "todo"}, nil)), 0)
	check("label field resolution", labelFieldOf(fields), any("title"))

	// 2. Predicates: availability AND the stated reason. Both are contractual —
	//    a blocked operation must say the same thing on every stack.
	record := M{"id": "t1", "title": "Ship it", "status": "doing"}
	check("ne holds", evaluatePredicate(M{"field": "status", "ne": "done"}, record, fields), true)
	check("eq fails", evaluatePredicate(M{"field": "status", "eq": "done"}, record, fields), false)
	check("eq explains with both values",
		explainPredicate(M{"field": "status", "eq": "done"}, record, fields),
		`status is "doing", not "done"`)
	check("in explains with the full set",
		explainPredicate(M{"field": "status", "in": []any{"todo", "done"}}, record, fields),
		`status is "doing", not "todo" or "done"`)
	check("all reports the first failing branch",
		explainPredicate(
			M{"all": []any{M{"field": "status", "ne": "done"}, M{"field": "title", "eq": "Other"}}},
			record, fields),
		`title is "Ship it", not "Other"`)
	check("isBlank on an absent field",
		evaluatePredicate(M{"field": "due", "isBlank": true}, record, fields), true)
	// A backend may store a boolean as text; both are the same boolean.
	boolFields := []M{{"name": "done", "type": "boolean"}}
	check("boolean compares by declared type, not storage shape",
		evaluatePredicate(M{"field": "done", "eq": true}, M{"id": "x", "done": "true"}, boolFields), true)
	// An unrecognised form must refuse, never default to available.
	check("unknown predicate form refuses",
		evaluatePredicate(M{"field": "status"}, record, fields), false)

	// 3. Fingerprint: stable, and moved by anything describe publishes.
	base := map[string]M{"tasks": {"fields": fields, "module": "planning"}}
	check("fingerprint is deterministic", schemaFingerprint(base, nil), schemaFingerprint(base, nil))
	moved := map[string]M{"tasks": {"fields": fields, "module": "other"}}
	if schemaFingerprint(base, nil) == schemaFingerprint(moved, nil) {
		failures = append(failures, "fingerprint ignores an entity's module")
	}
	if schemaFingerprint(base, []M{{"name": "op", "params": M{}}}) ==
		schemaFingerprint(base, []M{{"name": "op", "params": M{"x": M{"type": "string"}}}}) {
		failures = append(failures, "fingerprint ignores operation params")
	}

	// 4. Referential deletes: the rule an app declares with a `ref` binds the
	//    generic record route, not just whatever operation the app wrote. This
	//    checks the scan itself — the thing a delete consults before it commits.
	invoiceFields := []M{
		{"name": "client", "type": "ref", "entity": "clients"},
		{"name": "projects", "type": "list<ref>", "entity": "projects"},
	}
	defs := map[string]M{
		"clients":  {"fields": []M{{"name": "name", "type": "string"}}, "module": "sales"},
		"projects": {"fields": []M{{"name": "title", "type": "string"}}, "module": "sales"},
		"invoices": {"fields": invoiceFields, "module": "sales"},
	}
	scanStore := NewStore(nil)
	scanStore.putRecord("clients", M{"id": "c_acme"})
	scanStore.putRecord("clients", M{"id": "c_unused"})
	scanStore.putRecord("projects", M{"id": "p_one"})
	scanStore.putRecord("invoices", M{"id": "inv_1", "client": "c_acme", "projects": []any{"p_one"}})
	ad := &Adapter{entityDefs: defs, store: scanStore}

	check("a referenced record reports who blocks it",
		ad.referencesTo("clients", "c_acme"),
		[]M{{"entity": "invoices", "field": "client", "ids": []string{"inv_1"}}})
	check("an unreferenced record blocks nothing", ad.referencesTo("clients", "c_unused"), []M{})
	check("a reference held in a list counts too",
		ad.referencesTo("projects", "p_one"),
		[]M{{"entity": "invoices", "field": "projects", "ids": []string{"inv_1"}}})

	// The opt-out is per field, and it is the only way to allow orphaning.
	ignoring := map[string]M{}
	for k, v := range defs {
		ignoring[k] = v
	}
	ignoring["invoices"] = M{"fields": []M{
		{"name": "client", "type": "ref", "entity": "clients", "onDelete": "ignore"},
		invoiceFields[1],
	}, "module": "sales"}
	adIgnoring := &Adapter{entityDefs: ignoring, store: scanStore}
	check(`onDelete "ignore" removes the block`, adIgnoring.referencesTo("clients", "c_acme"), []M{})
	check("and leaves the other ref guarded",
		adIgnoring.referencesTo("projects", "p_one"),
		[]M{{"entity": "invoices", "field": "projects", "ids": []string{"inv_1"}}})

	// 5. Filter grammar: filtered reads filter, and anything outside the
	//    grammar is refused, never ignored.
	fltStore := NewStore(nil)
	fltStore.putRecord("tasks", M{"id": "a", "title": "Ship it", "status": "todo"})
	fltStore.putRecord("tasks", M{"id": "b", "title": "Other work", "status": "done"})
	listIDs := func(filter string) []string {
		result, err := fltStore.listRecords("tasks", M{"filter": filter})
		if err != nil {
			return []string{"<error: " + err.Error() + ">"}
		}
		ids := []string{}
		for _, r := range toMList(result["items"]) {
			ids = append(ids, getStr(r, "id"))
		}
		return ids
	}
	check("filter: equality", listIDs(`status = "todo"`), []string{"a"})
	check("filter: negation", listIDs(`status != "todo"`), []string{"b"})
	check("filter: contains", listIDs(`title ~ "Ship"`), []string{"a"})
	if _, err := fltStore.listRecords("tasks", M{"filter": `status = "todo" && title ~ "x"`}); err == nil {
		failures = append(failures, "an unsupported filter expression was silently accepted")
	} else {
		var unsupported *UnsupportedFilter
		if !errors.As(err, &unsupported) {
			failures = append(failures, "an unsupported filter raised the wrong error: "+err.Error())
		}
	}

	// 6. SQLite store: durable records + idempotency keys, and seed-once
	//    semantics across a restart (reopening the same file).
	tmp, err := os.MkdirTemp("", "a2app-selftest-")
	if err != nil {
		failures = append(failures, "could not create a temp dir: "+err.Error())
	} else {
		defer os.RemoveAll(tmp)
		dbPath := filepath.Join(tmp, "data", "db.sqlite")
		first, err := NewSqliteStore(dbPath, nil)
		if err != nil {
			failures = append(failures, "could not open a fresh sqlite store: "+err.Error())
		} else {
			check("a fresh database file wants the seed", first.WantsSeed, true)
			first.putRecord("tasks", M{"id": "t1", "title": "persisted", "status": "todo"})
			first.idemPut("tasks", "key-1", "t1")
			check("sqlite get returns what was put", getStr(first.getRecord("tasks", "t1"), "title"), "persisted")
			ids := []string{}
			if result, err := first.listRecords("tasks", M{"filter": `status = "todo"`}); err == nil {
				for _, r := range toMList(result["items"]) {
					ids = append(ids, getStr(r, "id"))
				}
			}
			check("sqlite list flows through the shared filter/sort/page", ids, []string{"t1"})
			first.Close()

			second, err := NewSqliteStore(dbPath, nil)
			if err != nil {
				failures = append(failures, "could not reopen the sqlite store: "+err.Error())
			} else {
				check("an existing database refuses the seed", second.WantsSeed, false)
				check("records survive a restart", getStr(second.getRecord("tasks", "t1"), "title"), "persisted")
				check("idempotency keys survive a restart", second.idemGet("tasks", "key-1"), "t1")
				check("delete removes the row", second.deleteRecord("tasks", "t1"), true)
				check("a second delete reports not-found", second.deleteRecord("tasks", "t1"), false)
				second.Close()
			}
		}
	}

	if len(failures) > 0 {
		fmt.Println("a2app_adapter selftest FAILED:\n  - " + strings.Join(failures, "\n  - "))
		return 1
	}
	fmt.Println("a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store)")
	return 0
}
