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
// Protocol 0.2 (spec/v0_2/auth.md) adds who a request acts for: principals,
// delegated agent credentials stored only as hashes, the user ceiling, and on
// `authMode: multi-user` accounts, sessions, invites, record ownership and
// device-code sign-in. Parity oracle: adapters/adapter-core/src (auth.ts,
// accounts.ts, credentials.ts, device.ts, server.ts).
//
// The pure validation rules below MUST match `@a2app/rules` — and the Python
// port in blueprint-python-fastapi, which is this file's line-for-line oracle —
// so a Go app and a Node app reject identical payloads identically, verified by
// the conformance suite. HTTP wiring lives in `main.go`; this file never touches
// net/http. An agent evolves the app by editing `schema.go`, never this file.
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
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
	PROTOCOL_VERSION = "0.2"
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

// A claimed task with no progress for this long is presumed abandoned and goes
// back to the queue, so a dead agent's work is redelivered rather than lost.
// Anything that delivers work from this queue (`agent-app <dir> bridge`)
// heartbeats well inside it; the value matches adapter-core.
const taskTimeout = 60 * time.Second

// Redelivery is bounded: a task handed out this many times without finishing
// fails with `redelivery_exhausted` instead of cycling forever.
const taskMaxDeliveries = 5

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

/* --------------------------------------------------------- auth primitives */
// The security primitives behind accounts, sessions, invites, device codes and
// credentials (spec/v0_2/auth.md). Parity oracle: adapter-core auth.ts. Kept
// apart from the served surface so each rule — what a secret looks like, how
// it is stored, how a password is checked — is written once.
//
// Every secret the app hands out (tokens, session ids, invite codes, device
// codes) is 256 random bits, returned once, and stored only as its SHA-256.
// Passwords are PBKDF2-SHA256 at 600 000 iterations (OWASP), compared in
// constant time.

func randomBytes(n int) []byte {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err) // the OS entropy source failing is not a recoverable request error
	}
	return buf
}

// newSecret is 256 random bits, base64url (43 chars).
func newSecret() string { return base64.RawURLEncoding.EncodeToString(randomBytes(32)) }

// newToken is an agent credential token: `a2a_` + 256 random bits.
func newToken() string { return "a2a_" + newSecret() }

// hashSecret is how a secret is stored and looked up: hex SHA-256 of the
// whole string.
func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// newID is an id that is not a secret: `prefix_` + 64 random bits, hex.
func newID(prefix string) string { return prefix + "_" + randomHex(8) }

const (
	pbkdf2Iterations = 600_000
	pbkdf2KeyBytes   = 32
	pbkdf2SaltBytes  = 16
	passwordMin      = 10
	passwordMax      = 256
)

// pbkdf2SHA256 is PBKDF2 (RFC 8018 §5.2) over HMAC-SHA256. Go 1.22's standard
// library has none, and it is a few lines — not worth a module dependency.
func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	out := make([]byte, 0, keyLen+prf.Size())
	index := make([]byte, 4)
	for block := uint32(1); len(out) < keyLen; block++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(index, block)
		prf.Write(index)
		u := prf.Sum(nil)
		t := append([]byte(nil), u...)
		for n := 1; n < iterations; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for i := range t {
				t[i] ^= u[i]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

// hashPassword is `pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>` — the
// format adapter-core writes, so a stored hash means the same on every stack.
func hashPassword(password string, iterations int) string {
	salt := randomBytes(pbkdf2SaltBytes)
	key := pbkdf2SHA256([]byte(password), salt, iterations, pbkdf2KeyBytes)
	return "pbkdf2_sha256$" + strconv.Itoa(iterations) + "$" +
		base64.StdEncoding.EncodeToString(salt) + "$" + base64.StdEncoding.EncodeToString(key)
}

// verifyPassword is a constant-time check of password against a stored hash.
// A malformed hash never matches.
func verifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations < 1 {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil || len(expected) == 0 {
		return false
	}
	actual := pbkdf2SHA256([]byte(password), salt, iterations, len(expected))
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

// Consonants only (RFC 8628 §6.1): no vowels, so no words; no look-alikes.
const userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ"

// newUserCode is `XXXX-XXXX` from userCodeAlphabet.
func newUserCode() string {
	letters := make([]byte, 8)
	for i := range letters {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(userCodeAlphabet))))
		if err != nil {
			panic(err)
		}
		letters[i] = userCodeAlphabet[n.Int64()]
	}
	return string(letters[:4]) + "-" + string(letters[4:])
}

// normalizeUserCode is a user code as typed: case and the dash do not matter.
// "" when it is not one.
func normalizeUserCode(input string) string {
	letters := []rune{}
	for _, c := range strings.ToUpper(input) {
		if strings.ContainsRune(userCodeAlphabet, c) {
			letters = append(letters, c)
		}
	}
	if len(letters) != 8 {
		return ""
	}
	return string(letters[:4]) + "-" + string(letters[4:])
}

// parseCookies is a `Cookie` header's name/value pairs (the first occurrence
// of a name wins; a value this app could not have written is skipped).
func parseCookies(header string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(header, ";") {
		eq := strings.Index(part, "=")
		if eq <= 0 {
			continue
		}
		name := strings.TrimSpace(part[:eq])
		if _, seen := out[name]; seen {
			continue
		}
		if value, err := url.PathUnescape(strings.TrimSpace(part[eq+1:])); err == nil {
			out[name] = value
		}
	}
	return out
}

// sessionCookie is a `Set-Cookie` value for the session cookie. A maxAge of 0
// clears it.
func sessionCookie(name, value string, maxAgeSeconds int, secure bool) string {
	attrs := []string{name + "=" + url.PathEscape(value), "Path=/", "HttpOnly", "SameSite=Lax",
		"Max-Age=" + strconv.Itoa(maxAgeSeconds)}
	if secure {
		attrs = append(attrs, "Secure")
	}
	return strings.Join(attrs, "; ")
}

// failureLimiter counts failures per key in a fixed window (sign-in failures
// per login). In memory: a restart forgets them, which costs an attacker
// nothing they could not get by waiting out the window.
type failureLimiter struct {
	mu      sync.Mutex
	max     int
	window  time.Duration
	now     func() time.Time
	windows map[string]failureWindow
}

type failureWindow struct {
	count int
	start time.Time
}

func newFailureLimiter(max int, window time.Duration, now func() time.Time) *failureLimiter {
	return &failureLimiter{max: max, window: window, now: now, windows: map[string]failureWindow{}}
}

// retryAfter is the seconds until key may try again, or 0 when it may now.
func (l *failureLimiter) retryAfter(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.windows[key]
	if !ok {
		return 0
	}
	elapsed := l.now().Sub(w.start)
	if elapsed >= l.window {
		delete(l.windows, key)
		return 0
	}
	if w.count < l.max {
		return 0
	}
	return int(math.Ceil((l.window - elapsed).Seconds()))
}

func (l *failureLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	w, ok := l.windows[key]
	if !ok || t.Sub(w.start) >= l.window {
		l.windows[key] = failureWindow{count: 1, start: t}
		return
	}
	w.count++
	l.windows[key] = w
}

func (l *failureLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.windows, key)
}

// normalizeLogin is a login as stored and compared: trimmed, lower-cased.
func normalizeLogin(login string) string { return strings.ToLower(strings.TrimSpace(login)) }

// jsLength is a string's length as the protocol's limits count it (UTF-16
// code units, as JavaScript's .length does), so a limit means the same
// characters on every stack.
func jsLength(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

const isoLayout = "2006-01-02T15:04:05.000Z"

// isoOf renders a time the way every timestamp on this surface is written.
func isoOf(t time.Time) string { return t.UTC().Format(isoLayout) }

// parseISO reads a timestamp this adapter wrote; false when it is not one.
func parseISO(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

// orNull is an optional string field as served: an empty one is null.
func orNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

/* -- rows the auth layer stores -- */

// Grant is a stored credential (spec §2.1): one bearer token, held only as its
// SHA-256, bound to one principal with a scope set. Every request it makes is
// further limited to what that principal may do at that moment. The optional
// fields hold "" for null — none of them can be empty when set.
type Grant struct {
	CredentialID string `json:"credentialId"`
	// hex SHA-256 of the token
	TokenHash string `json:"tokenHash"`
	Principal string `json:"principal"`
	AgentName string `json:"agentName"`
	// as granted; `*` means every scope the app declares
	Scopes    []string `json:"scopes"`
	CreatedAt string   `json:"createdAt"`
	// "" only for the admin credential, which never expires
	ExpiresAt  string `json:"expiresAt"`
	LastUsedAt string `json:"lastUsedAt"`
	// set when revoked; the row is kept so the token is told so
	RevokedAt string `json:"revokedAt"`
	// a task credential: dead once that task is completed, failed or canceled
	Task  string `json:"task"`
	Admin bool   `json:"admin"`
}

// PrincipalInfo is who a principal is: `owner`, or an account on a
// multi-user app.
type PrincipalInfo struct {
	ID     string
	Name   string
	Role   string // "owner" or "member"
	Active bool
}

// Account is an account on a multi-user app (spec `account`, plus its
// password hash, which never leaves the accounts routes).
type Account struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Login        string `json:"login"`
	Role         string `json:"role"`
	Active       bool   `json:"active"`
	CreatedAt    string `json:"createdAt"`
	PasswordHash string `json:"passwordHash"`
}

type sessionRow struct {
	Principal string `json:"principal"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
}

type inviteRow struct {
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
}

// deviceRow is one device-code sign-in in progress (spec §7).
type deviceRow struct {
	UserCode  string `json:"userCode"`
	AgentName string `json:"agentName"`
	// what the agent asked for
	Scopes []string `json:"scopes"`
	// the issued credential's lifetime
	ExpiresInSeconds int    `json:"expiresInSeconds"`
	CreatedAt        string `json:"createdAt"`
	// when the codes stop working
	ExpiresAt string `json:"expiresAt"`
	Interval  int    `json:"interval"`
	// unix ms of the last poll; nil before the first
	LastPolledAt   *int64   `json:"lastPolledAt"`
	Status         string   `json:"status"` // pending · approved · denied
	ApprovedBy     string   `json:"approvedBy"`
	ApprovedScopes []string `json:"approvedScopes"`
}

// The keyed tables the auth layer owns: accounts, sessions, invites and device
// codes. Rows are keyed by id or by the hash of the secret that finds them; no
// secret is ever a key or a value.
const (
	tableUsers    = "users"
	tableSessions = "sessions"
	tableInvites  = "invites"
	tableDevices  = "devices"
)

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
// 409 the protocol promises. Credentials and the auth tables (accounts,
// sessions, invites, device codes) persist too, in tables of their own: they
// are adapter state, never records, and a person must not lose their account
// or their agents' access to a restart. The task/event plane and approvals
// stay in memory: they are runtime queues, not records.
//
// Writes are durable when the call returns — there is no separate persist()
// step. A record read from the SQLite store is a COPY: mutate it, then
// putRecord() it back, or the change never happened.
//
// A Store is a handle on one shared storeState. The handle an operation runner
// is given also knows who called the runner, so a task its trigger queues
// records that person and the agent that takes it acts as them (spec/v0_2/
// auth.md §6) — the adapter binds it, so no runner can forget to. Copying a
// handle copies a pointer, never the state's mutex.
type Store struct {
	*storeState
	// who called the runner holding this handle; "" for the app's own store,
	// whose tasks run as the owner
	caller string
}

type storeState struct {
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
	// The in-memory variant's credentials (by credentialId, plus an index by
	// token hash) and auth tables.
	memGrants  *memTable
	tokenIndex map[string]string
	memAuth    map[string]*memTable
	taskSeq    int
	eventSeq   int
	// The event types this app may emit, set by NewAdapter from the app's
	// declarations. Empty means none were declared.
	eventTypes map[string]bool
	// occurrence key -> task id, so one occurrence makes one task
	dedup map[string]string
}

func newStoreState(seed map[string][]M) *Store {
	if seed == nil {
		seed = map[string][]M{}
	}
	return &Store{storeState: &storeState{
		Seed:       seed,
		WantsSeed:  true,
		rows:       map[string]map[string]M{},
		rowOrder:   map[string][]string{},
		memIdem:    map[string]string{},
		tasks:      map[string]M{},
		approvals:  map[string]bool{},
		memGrants:  newMemTable(),
		tokenIndex: map[string]string{},
		memAuth:    map[string]*memTable{},
		eventTypes: map[string]bool{},
		dedup:      map[string]string{},
	}}
}

// forCaller is this store as handed to an operation runner called by
// `principal`: the same records and queue, with the caller bound to trigger.
func (s *Store) forCaller(principal string) *Store {
	return &Store{storeState: s.storeState, caller: principal}
}

// memTable is one keyed table of the in-memory variant. Rows are held as JSON,
// so a read is a copy exactly as it is from SQLite, in insertion order.
type memTable struct {
	rows  map[string][]byte
	order []string
}

func newMemTable() *memTable { return &memTable{rows: map[string][]byte{}} }

func (t *memTable) put(key string, data []byte) {
	if _, existed := t.rows[key]; !existed {
		t.order = append(t.order, key)
	}
	t.rows[key] = data
}

func (t *memTable) remove(key string) {
	if _, ok := t.rows[key]; !ok {
		return
	}
	delete(t.rows, key)
	for i, k := range t.order {
		if k == key {
			t.order = append(t.order[:i], t.order[i+1:]...)
			break
		}
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
		// Credentials, found by the hash of their token — never the token.
		"CREATE TABLE IF NOT EXISTS grants (credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, data TEXT NOT NULL)",
		"CREATE INDEX IF NOT EXISTS grants_by_token ON grants (token_hash)",
		// The auth tables (users, sessions, invites, devices): adapter state,
		// apart from the records table so the records API can never serve them.
		"CREATE TABLE IF NOT EXISTS auth (tbl TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, key))",
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

// listRecords filters, sorts and pages one entity. `where` (field -> value) is
// the adapter's own constraint — a member sees only the records it owns — so
// it is applied first, before anything is counted or paged.
func (s *Store) listRecords(entity string, query M) (M, error) {
	items := s.allRecords(entity)
	if where, ok := query["where"].(map[string]string); ok && len(where) > 0 {
		kept := []M{}
		for _, r := range items {
			matches := true
			for field, value := range where {
				if v, ok := r[field].(string); !ok || v != value {
					matches = false
					break
				}
			}
			if matches {
				kept = append(kept, r)
			}
		}
		items = kept
	}
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
// Credentials, keyed by credentialId and found by the hash of their token.

func decodeGrant(data []byte) *Grant {
	var g Grant
	if json.Unmarshal(data, &g) != nil || g.TokenHash == "" {
		return nil
	}
	return &g
}

// grantLocked is one grant by id; the caller holds s.mu.
func (s *Store) grantLocked(credentialID string) *Grant {
	if s.db == nil {
		data, ok := s.memGrants.rows[credentialID]
		if !ok {
			return nil
		}
		return decodeGrant(data)
	}
	var data string
	if s.db.QueryRow("SELECT data FROM grants WHERE credential_id = ?", credentialID).Scan(&data) != nil {
		return nil
	}
	return decodeGrant([]byte(data))
}

// putGrantLocked writes one grant; the caller holds s.mu.
func (s *Store) putGrantLocked(g Grant) {
	data, err := json.Marshal(g)
	if err != nil {
		return
	}
	if s.db == nil {
		if previous := s.grantLocked(g.CredentialID); previous != nil && previous.TokenHash != g.TokenHash {
			delete(s.tokenIndex, previous.TokenHash)
		}
		s.memGrants.put(g.CredentialID, data)
		s.tokenIndex[g.TokenHash] = g.CredentialID
		return
	}
	s.db.Exec(
		"INSERT INTO grants (credential_id, token_hash, data) VALUES (?, ?, ?) "+
			"ON CONFLICT (credential_id) DO UPDATE SET token_hash = excluded.token_hash, data = excluded.data",
		g.CredentialID, g.TokenHash, string(data))
}

func (s *Store) putGrant(g Grant) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.putGrantLocked(g)
}

func (s *Store) grantByID(credentialID string) *Grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.grantLocked(credentialID)
}

func (s *Store) grantByTokenHash(tokenHash string) *Grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		id, ok := s.tokenIndex[tokenHash]
		if !ok {
			return nil
		}
		return s.grantLocked(id)
	}
	var data string
	if s.db.QueryRow("SELECT data FROM grants WHERE token_hash = ?", tokenHash).Scan(&data) != nil {
		return nil
	}
	return decodeGrant([]byte(data))
}

// updateGrant changes one grant in a single step, so two requests touching the
// same credential (a use stamping lastUsedAt, a revocation) cannot overwrite
// each other's change. False when there is no such grant.
func (s *Store) updateGrant(credentialID string, change func(*Grant)) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.grantLocked(credentialID)
	if g == nil {
		return false
	}
	change(g)
	s.putGrantLocked(*g)
	return true
}

func (s *Store) deleteGrant(credentialID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		if g := s.grantLocked(credentialID); g != nil {
			delete(s.tokenIndex, g.TokenHash)
		}
		s.memGrants.remove(credentialID)
		return
	}
	s.db.Exec("DELETE FROM grants WHERE credential_id = ?", credentialID)
}

// listGrants is every grant, in the order they were first stored.
func (s *Store) listGrants() []Grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Grant{}
	if s.db == nil {
		for _, id := range s.memGrants.order {
			if g := decodeGrant(s.memGrants.rows[id]); g != nil {
				out = append(out, *g)
			}
		}
		return out
	}
	rows, err := s.db.Query("SELECT data FROM grants ORDER BY rowid")
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var data string
		if rows.Scan(&data) != nil {
			continue
		}
		if g := decodeGrant([]byte(data)); g != nil {
			out = append(out, *g)
		}
	}
	return out
}

/* auth tables ------------------------------------------------------------ */
// users · sessions · invites · devices, each row JSON under its key.

func (s *Store) memAuthTable(table string) *memTable {
	t, ok := s.memAuth[table]
	if !ok {
		t = newMemTable()
		s.memAuth[table] = t
	}
	return t
}

// authRow decodes one row into out; false when there is none.
func (s *Store) authRow(table, key string, out any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	var data []byte
	if s.db == nil {
		raw, ok := s.memAuthTable(table).rows[key]
		if !ok {
			return false
		}
		data = raw
	} else {
		var text string
		if s.db.QueryRow("SELECT data FROM auth WHERE tbl = ? AND key = ?", table, key).Scan(&text) != nil {
			return false
		}
		data = []byte(text)
	}
	return json.Unmarshal(data, out) == nil
}

func (s *Store) putAuthRow(table, key string, row any) {
	data, err := json.Marshal(row)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		s.memAuthTable(table).put(key, data)
		return
	}
	s.db.Exec(
		"INSERT INTO auth (tbl, key, data) VALUES (?, ?, ?) ON CONFLICT (tbl, key) DO UPDATE SET data = excluded.data",
		table, key, string(data))
}

func (s *Store) deleteAuthRow(table, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		s.memAuthTable(table).remove(key)
		return
	}
	s.db.Exec("DELETE FROM auth WHERE tbl = ? AND key = ?", table, key)
}

// keyedRow is one auth-table row with the key it is stored under.
type keyedRow[T any] struct {
	key string
	row T
}

// authRows is every row of one auth table, decoded, in insertion order.
func authRows[T any](s *Store, table string) []keyedRow[T] {
	type raw struct {
		key  string
		data []byte
	}
	found := []raw{}
	s.mu.Lock()
	if s.db == nil {
		t := s.memAuthTable(table)
		for _, key := range t.order {
			found = append(found, raw{key, t.rows[key]})
		}
	} else if rows, err := s.db.Query("SELECT key, data FROM auth WHERE tbl = ? ORDER BY rowid", table); err == nil {
		for rows.Next() {
			var key, data string
			if rows.Scan(&key, &data) == nil {
				found = append(found, raw{key, []byte(data)})
			}
		}
		rows.Close()
	}
	s.mu.Unlock()
	out := []keyedRow[T]{}
	for _, r := range found {
		var row T
		if json.Unmarshal(r.data, &row) == nil {
			out = append(out, keyedRow[T]{r.key, row})
		}
	}
	return out
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

// enqueueTask queues one task. `principal` is who asked for the work
// (spec/v0_2/auth.md §6.1); "" for work the app queues on its own, recorded as
// null and run as the owner.
func (s *Store) enqueueTask(eventID, capability string, payload M, principal, dedupKey string) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.tasks[s.dedup[dedupKey]]; ok && dedupKey != "" {
		return existing
	}
	s.taskSeq++
	task := M{
		"id": fmt.Sprintf("task_%d", s.taskSeq), "app": nil, "event": eventID, "status": "submitted",
		"request": M{"capability": capability, "payload": payload, "principal": orNull(principal)}, "claim": nil,
		"progress": M{}, "result": nil, "reason": nil, "ask": nil,
		"createdAt": nowISO(), "updatedAt": nowISO(), "deliveries": 1,
	}
	s.tasks[getStr(task, "id")] = task
	s.taskOrder = append(s.taskOrder, getStr(task, "id"))
	if dedupKey != "" {
		s.dedup[dedupKey] = getStr(task, "id")
	}
	return task
}

// trigger emits a declared event and, when capability is non-empty, queues a
// task for an agent. This is the app->agent seam an operation runner reaches
// through the store it is handed. The result is {"eventId", "taskId"}; taskId
// is nil when no capability was named, because an event alone asks no agent
// for work. An undeclared event type is an error, and nothing is emitted.
//
// A task records who asked for the work: the caller of the runner this store
// was handed to, so the agent that takes it acts as that person (spec/v0_2/
// auth.md §6). On the app's own store there is none — null, run as the owner.
func (s *Store) trigger(etype string, payload M, capability string) (M, error) {
	principal := s.caller
	s.mu.Lock()
	declared := len(s.eventTypes) == 0 || s.eventTypes[etype]
	s.mu.Unlock()
	if !declared {
		return nil, fmt.Errorf("event type %q is not declared", etype)
	}
	ev := s.appendEvent(etype, payload)
	var taskID any
	if capability != "" {
		// Dedup is keyed on the OCCURRENCE, not on the event record: the same
		// trigger firing twice must make one task. The event id is fresh per
		// emit, so keying on it would deduplicate nothing. The occurrence is what
		// the app asked for (type, capability, payload), serialized with sorted
		// keys so key order cannot tell two identical triggers apart. Who asked
		// is part of it: the same request from two people is two tasks, each run
		// as the person who asked.
		occurrence := M{"type": etype, "capability": capability, "payload": payload}
		if principal != "" {
			occurrence["principal"] = principal
		}
		sum := sha256.Sum256([]byte(stableJSON(occurrence)))
		taskID = s.enqueueTask(getStr(ev, "id"), capability, payload, principal, "sha256:"+hex.EncodeToString(sum[:]))["id"]
	}
	return M{"eventId": ev["id"], "taskId": taskID}, nil
}

// sweep returns abandoned claims to the queue: a working task with no update
// for taskTimeout goes back to submitted so another agent can take it, and
// fails with redelivery_exhausted once it has been handed out taskMaxDeliveries
// times. Never a silent drop.
func (s *Store) sweep() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	for _, task := range s.tasks {
		if getStr(task, "status") != "working" {
			continue
		}
		updated, err := time.Parse("2006-01-02T15:04:05.000Z", getStr(task, "updatedAt"))
		if err == nil && now.Sub(updated) < taskTimeout {
			continue
		}
		if intOf(task["deliveries"]) >= taskMaxDeliveries {
			task["status"] = "failed"
			task["reason"] = "redelivery_exhausted"
		} else {
			task["status"] = "submitted"
			task["claim"] = nil
			task["deliveries"] = intOf(task["deliveries"]) + 1
		}
		task["updatedAt"] = nowISO()
	}
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

func randomHex(nBytes int) string { return hex.EncodeToString(randomBytes(nBytes)) }

// OperationRunner is the signature schema.go implements: (args, ctx, store) ->
// JSON-able result. Returning an error (or panicking) becomes operation_failed.
// ctx is who is calling: {"credentialId", "agentName", "principal", "role"}.
// An `owner` may touch every record; a `member` only the records it owns, and
// a runner holds itself to the same rule for records it touches.
type OperationRunner func(args M, ctx M, store *Store) (any, error)

// The app's optional auth declarations (spec/v0_2/auth.md §3, §6.2), passed
// to the adapter by main.go. They are declared here, empty, so a schema.go
// that needs neither compiles unchanged; one that does sets them in its own
// init(). See AdapterConfig.Capabilities and AdapterConfig.PermissionsOf.
var (
	CAPABILITIES   = map[string]M{}
	PERMISSIONS_OF func(principal M) []string
)

// AdapterConfig is everything the wiring (main.go) hands the adapter.
type AdapterConfig struct {
	AppID      string
	AppName    any // string, or nil for an unnamed app
	Entities   map[string]M
	Operations []M
	Store      *Store
	// Token is the app's own .agent-token: its admin credential (spec/v0_2/
	// auth.md §2.3) — principal `owner`, every scope, no expiry, never listed.
	// It is seeded hashed at every boot, so a rotated file replaces the old one.
	Token   string
	Modules []M
	// PermissionsOf is what a principal may do (spec §3), as scopes; `*` is
	// every scope. It receives {"id", "name", "role", "active"} and is asked on
	// every request: a credential's reach is its own scopes intersected with
	// this. Nil: `*` for every active principal (record ownership still
	// applies). An inactive principal has none.
	PermissionsOf func(principal M) []string
	// Capabilities is what the agent taking each capability's tasks needs, as
	// {"<capability>": {"scopes": [...]}} (spec §6.2). A task's credential holds
	// these, limited by what the person who queued it may do; a capability not
	// listed gets `*`.
	Capabilities   map[string]M
	AllowedOrigins []string
	// PublicURL is the origin people and agents reach the app at
	// (A2APP_PUBLIC_URL, resolved by NetworkPolicy), or "" for loopback only.
	// It is one more of the app's own origins, and its host is answered.
	PublicURL      string
	Runners        map[string]OperationRunner
	// Events are the event types this app may emit ({"type": ...} each). A
	// runner's store.trigger refuses a type that is not declared here.
	Events         []M
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
	allowedHosts   map[string]bool
	ownOrigins     []string
	publicURL      string
	runners        map[string]OperationRunner
	permissionsOf  func(principal M) []string
	capabilities   map[string]M
	credentialHint string
	env            string
	appVersion     func() string
	limiter        *rateLimiter
	now            func() time.Time

	// Accounts and sessions (authMode: multi-user). The cookie is per app:
	// browsers do not separate cookies by port, so two apps on one machine
	// would otherwise sign each other out.
	multiUser         bool
	sessionCookieName string
	secureCookies     bool
	signInFailures    *failureLimiter
	// Checked against when a login does not exist, so a missing account takes
	// as long to refuse as a wrong password and the timing does not say which.
	dummyHash     string
	dummyHashOnce sync.Once
	// authMu makes each multi-step change to the auth tables one step: accepting
	// an invite, changing a person, and every device-code transition. net/http
	// serves concurrently, so without it a second acceptance of one invite, or
	// two polls of one approved code, could both succeed.
	authMu sync.Mutex

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
		allowedHosts:   map[string]bool{},
		publicURL:      cfg.PublicURL,
		runners:        cfg.Runners,
		permissionsOf:  cfg.PermissionsOf,
		capabilities:   cfg.Capabilities,
		credentialHint: cfg.CredentialHint,
		env:            cfg.Env,
		appVersion:     cfg.AppVersion,
		limiter:        newRateLimiter(defaultRateLimits, func() int64 { return time.Now().UnixMilli() }),
		now:            time.Now,
		bootMark:       strconv.FormatInt(time.Now().UnixMilli(), 36),
	}
	if a.authMode != "multi-user" {
		a.authMode = "none"
	}
	a.multiUser = a.authMode == "multi-user"
	a.sessionCookieName = "a2app_session_" + a.appID
	a.secureCookies = strings.HasPrefix(cfg.PublicURL, "https://")
	a.signInFailures = newFailureLimiter(signInFailureMax, signInWindow, func() time.Time { return a.now() })
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
	// The public URL is one more origin of the app's own: people open the View
	// there, and agents reach the app there.
	origins := append([]string{}, cfg.AllowedOrigins...)
	if cfg.PublicURL != "" {
		origins = append(origins, cfg.PublicURL)
	}
	a.ownOrigins = origins
	for _, origin := range origins {
		a.allowedOrigins[origin] = true
		// The hosts this app answers to are derived from its own origins, so an
		// app reached at its public URL answers there and nowhere new.
		if u, err := url.Parse(origin); err == nil && u.Host != "" {
			a.allowedHosts[strings.ToLower(u.Host)] = true
			a.allowedHosts[hostnameOf(u.Host)] = true
		}
	}
	// The declared event types are what keep the app->agent queue from being an
	// open channel: store.trigger refuses a type that is not declared, so the set
	// of things this app can ever ask an agent to react to is fixed by its author
	// rather than by whatever a runner passes at the moment of firing.
	for _, e := range cfg.Events {
		cfg.Store.eventTypes[getStr(e, "type")] = true
	}
	// The app's own .agent-token is its admin credential, hashed on the way in
	// and never written back. Re-seeding at every boot follows a rotated file.
	if cfg.Token != "" {
		seed := Grant{
			CredentialID: "cred_local", TokenHash: hashSecret(cfg.Token), Principal: ownerPrincipal.ID,
			AgentName: "local", Scopes: []string{"*"}, CreatedAt: isoOf(a.now()), Admin: true,
		}
		if existing := cfg.Store.grantByID(seed.CredentialID); existing != nil {
			seed.CreatedAt, seed.LastUsedAt = existing.CreatedAt, existing.LastUsedAt
		}
		cfg.Store.putGrant(seed)
	}
	// Revoked and expired credentials are kept a while so their tokens are told
	// why they stopped; after that they are gone.
	now := a.now()
	for _, g := range cfg.Store.listGrants() {
		ended := g.RevokedAt
		if expires, ok := parseISO(g.ExpiresAt); ended == "" && ok && !expires.After(now) {
			ended = g.ExpiresAt
		}
		if at, ok := parseISO(ended); ok && now.Sub(at) > grantRetention {
			cfg.Store.deleteGrant(g.CredentialID)
		}
	}
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
		if owned, ok := d["ownedBy"]; ok {
			// The adapter writes the owner and the guard keeps clients from doing
			// so, which only holds for a declared, read-only string field.
			ownedBy := toStr(owned)
			var owner M
			for _, f := range fieldsOf(d) {
				if getStr(f, "name") == ownedBy {
					owner = f
				}
			}
			if owner == nil {
				problems = append(problems, `entity "`+name+`" is ownedBy "`+ownedBy+`", which is not one of its fields`)
			} else if getStr(owner, "type") != "string" || !getBool(owner, "readOnly") {
				problems = append(problems, `entity "`+name+`" is ownedBy "`+ownedBy+`", which must be a readOnly string field`)
			}
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

	// A capability's scopes are what its task credentials hold, so one the app
	// does not declare would be a grant of nothing — or a typo that silently
	// leaves the agent unable to do its work.
	declaredScopes := a.allScopes()
	capabilityNames := make([]string, 0, len(a.capabilities))
	for capability := range a.capabilities {
		capabilityNames = append(capabilityNames, capability)
	}
	sort.Strings(capabilityNames)
	for _, capability := range capabilityNames {
		unknown := []string{}
		for _, s := range scopeList(a.capabilities[capability]["scopes"]) {
			if s != "*" && !declaredScopes[s] {
				unknown = append(unknown, s)
			}
		}
		if len(unknown) > 0 {
			problems = append(problems, `capability "`+capability+`" needs scopes this app does not declare: `+strings.Join(unknown, ", "))
		}
	}
	return problems
}

// scopeList reads a declared list of scope names ([]string or decoded []any).
func scopeList(v any) []string {
	out := []string{}
	for _, s := range toAnyList(v) {
		out = append(out, toStr(s))
	}
	return out
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
		"authMode":   a.authMode,
		"accountUrl": accountURL,
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
	if ownedBy := getStr(d, "ownedBy"); ownedBy != "" {
		level["ownedBy"] = ownedBy
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
// Who a request acts for, decided once and in spec/v0_2/auth.md §9 order.
// Parity oracle: adapter-core server.ts (credentialOf, resolve, authorize,
// managerOf).

const (
	accountURL = "/_a2app/account"
	// How long a revoked or expired credential is remembered (spec §2.1).
	grantRetention = 30 * 24 * time.Hour
	// lastUsedAt is written at most this often, so use does not mean a disk
	// write per request.
	lastUsedResolution = time.Minute
)

// renewHint is said to an agent whose credential stopped working (revoked,
// expired, or its person deactivated): a new one is the person's to give.
// Like the credential hint, it states a fact and never an instruction.
const renewHint = "Ask the person this agent acts for to approve it again (a2app <app> login), or the app's owner for a new credential."

// ownerPrincipal is the app's administrator: the admin credential, and the
// only principal of an `authMode: none` app.
var ownerPrincipal = PrincipalInfo{ID: "owner", Name: "Owner", Role: "owner", Active: true}

var terminalTask = map[string]bool{"completed": true, "failed": true, "canceled": true}

// allScopes is every scope the app declares: what `*` means.
func (a *Adapter) allScopes() map[string]bool {
	scopes := map[string]bool{}
	for name := range a.entityDefs {
		scopes["data:"+name+":read"] = true
		scopes["data:"+name+":write"] = true
	}
	for _, o := range a.operations {
		scopes["op:"+getStr(o, "name")] = true
	}
	return scopes
}

func (a *Adapter) expandScopes(scopes []string) map[string]bool {
	if contains(scopes, "*") {
		return a.allScopes()
	}
	out := map[string]bool{}
	for _, s := range scopes {
		out[s] = true
	}
	return out
}

// permissions is what a principal may do now (spec §3), or nil when it may do
// nothing.
func (a *Adapter) permissions(info *PrincipalInfo) map[string]bool {
	if info == nil || !info.Active {
		return nil
	}
	if a.permissionsOf == nil {
		return a.allScopes()
	}
	return a.expandScopes(a.permissionsOf(M{"id": info.ID, "name": info.Name, "role": info.Role, "active": info.Active}))
}

func intersect(x, y map[string]bool) map[string]bool {
	out := map[string]bool{}
	for s := range x {
		if y[s] {
			out[s] = true
		}
	}
	return out
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// principalInfo is who a principal is, or nil when it is unknown.
func (a *Adapter) principalInfo(id string) *PrincipalInfo {
	if id == ownerPrincipal.ID {
		owner := ownerPrincipal
		return &owner
	}
	if !a.multiUser {
		return nil
	}
	var account Account
	if !a.store.authRow(tableUsers, id, &account) {
		return nil
	}
	return &PrincipalInfo{ID: account.ID, Name: account.Name, Role: account.Role, Active: account.Active}
}

// presented is a usable credential, with the person it acts for and its
// effective reach: its own scopes intersected with what that person may do.
type presented struct {
	grant Grant
	info  PrincipalInfo
	held  map[string]bool
}

// credentialOf is the credential this request presents, checked in the order
// spec §9 gives: unknown, revoked (or its task is over), expired, then whether
// the person it acts for may still act. Nil, with no refusal, when none was
// presented.
func (a *Adapter) credentialOf(headers map[string]string) (*presented, int, M) {
	token := headers["x-a2app-token"]
	if token == "" {
		token = headers["x-lui-token"]
	}
	if token == "" {
		return nil, 0, nil
	}
	grant := a.store.grantByTokenHash(hashSecret(token))
	now := a.now()
	if grant == nil {
		status, body := errEnv(401, "credential_invalid", "This credential is not one this app issued.", M{"how": renewHint})
		return nil, status, body
	}
	taskOver := false
	if grant.Task != "" {
		task := a.store.getTask(grant.Task)
		taskOver = task == nil || terminalTask[getStr(task, "status")]
	}
	if grant.RevokedAt != "" || taskOver {
		status, body := errEnv(401, "credential_revoked", "This credential was revoked.", M{"how": renewHint})
		return nil, status, body
	}
	if expires, ok := parseISO(grant.ExpiresAt); ok && !expires.After(now) {
		status, body := errEnv(401, "token_expired", "This credential expired at "+grant.ExpiresAt+".", M{"how": renewHint})
		return nil, status, body
	}
	info := a.principalInfo(grant.Principal)
	allowed := a.permissions(info)
	if info == nil || allowed == nil {
		status, body := errEnv(401, "principal_inactive", "The person this credential acts for is no longer active.", nil)
		return nil, status, body
	}
	if last, ok := parseISO(grant.LastUsedAt); !ok || now.Sub(last) >= lastUsedResolution {
		stamp := isoOf(now)
		a.store.updateGrant(grant.CredentialID, func(g *Grant) { g.LastUsedAt = stamp })
	}
	return &presented{grant: *grant, info: *info, held: intersect(a.expandScopes(grant.Scopes), allowed)}, 0, nil
}

// sessionOf is the signed-in account behind this request's session cookie
// (and the session's key), or nil.
func (a *Adapter) sessionOf(headers map[string]string) (string, *Account) {
	if !a.multiUser {
		return "", nil
	}
	secret := parseCookies(headers["cookie"])[a.sessionCookieName]
	if secret == "" {
		return "", nil
	}
	key := hashSecret(secret)
	var session sessionRow
	if !a.store.authRow(tableSessions, key, &session) {
		return "", nil
	}
	if expires, ok := parseISO(session.ExpiresAt); !ok || !expires.After(a.now()) {
		a.store.deleteAuthRow(tableSessions, key)
		return "", nil
	}
	var account Account
	if !a.store.authRow(tableUsers, session.Principal, &account) || !account.Active {
		return "", nil
	}
	return key, &account
}

// isAllowedHost reports whether a Host header value names this app: a loopback
// name or address, or a host of one of its own origins.
func (a *Adapter) isAllowedHost(raw string) bool {
	host := strings.ToLower(raw)
	if a.allowedHosts[host] {
		return true
	}
	name := hostnameOf(host)
	return isLoopbackName(name) || a.allowedHosts[name]
}

// hostRefusal is the `403 forbidden_host` reply for a request under a Host
// this app does not answer to, else a nil body. Checked before every adapter
// route and before the system pages main.go serves (the account page, the
// update watcher), which are otherwise a free fingerprint of the app for a
// rebound page: binding loopback does not stop a page on evil.com whose DNS
// re-resolves to 127.0.0.1, but its Host header still says evil.com.
func (a *Adapter) hostRefusal(host string) (int, M) {
	if a.isAllowedHost(host) {
		return 0, nil
	}
	return errEnv(403, "forbidden_host", "Refused: this app answers only on its own host, not \""+host+"\".", nil)
}

// hostnameOf is the host name in a Host value: `name`, `name:port` or `[v6]:port`.
func hostnameOf(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return strings.ToLower(h)
	}
	return strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]"))
}

// isLoopbackName reports whether a host name is a loopback name or address.
func isLoopbackName(name string) bool {
	if name == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.TrimSuffix(strings.TrimPrefix(name, "["), "]"))
	return ip != nil && ip.IsLoopback()
}

// NetworkPolicy resolves where the app listens (A2APP_HOST, default loopback)
// and the origin people and agents reach it at (A2APP_PUBLIC_URL). It refuses
// the combinations that would send the agent token across a network in clear:
// a non-loopback bind without an https public URL, or a plain-http public URL
// that does not name this machine (an SSH tunnel ends on loopback).
func NetworkPolicy(hostEnv, publicURLEnv string) (host string, publicURL string, err error) {
	host = strings.TrimSpace(hostEnv)
	if host == "" {
		host = "127.0.0.1"
	}
	scheme := ""
	if raw := strings.TrimSpace(publicURLEnv); raw != "" {
		u, perr := url.Parse(raw)
		if perr != nil || u.Host == "" {
			return "", "", fmt.Errorf("A2APP_PUBLIC_URL is not a URL: %q", raw)
		}
		scheme = strings.ToLower(u.Scheme)
		if scheme != "https" && scheme != "http" {
			return "", "", fmt.Errorf("A2APP_PUBLIC_URL must be an http(s) URL, not %q", raw)
		}
		if scheme == "http" && !isLoopbackName(strings.ToLower(u.Hostname())) {
			return "", "", fmt.Errorf("A2APP_PUBLIC_URL must be https: %q would send the agent token across a network in clear. "+
				"Put the app behind a TLS proxy, or reach it through an SSH tunnel to a loopback address", raw)
		}
		publicURL = scheme + "://" + strings.ToLower(u.Host)
	}
	if !isLoopbackName(strings.ToLower(host)) && scheme != "https" {
		return "", "", fmt.Errorf("A2APP_HOST=%s exposes the app to the network, so A2APP_PUBLIC_URL must name its https address "+
			"(the agent token must not cross a network in clear). To reach it through a tunnel instead, keep A2APP_HOST on 127.0.0.1", host)
	}
	return host, publicURL, nil
}

// isForeignOrigin is a request whose Origin is not one of the app's own. No
// Origin at all is a program, not a browser.
func (a *Adapter) isForeignOrigin(headers map[string]string) bool {
	origin, ok := headers["origin"]
	return ok && !a.allowedOrigins[origin]
}

// isSameOrigin is true when the request carries one of the app's OWN origins.
func (a *Adapter) isSameOrigin(headers map[string]string) bool {
	origin, ok := headers["origin"]
	return ok && a.allowedOrigins[origin]
}

// fromOwnPage is whether a request came from one of the app's own pages. A
// browser marks same-origin fetches, GETs included, with Sec-Fetch-Site; a
// program sends neither header. Used to pick which 401 to send, and to trust
// a READ on a single-user app — never a change.
func (a *Adapter) fromOwnPage(headers map[string]string) bool {
	return a.isSameOrigin(headers) || headers["sec-fetch-site"] == "same-origin"
}

// unauthenticated is the 401 for a caller who presented nothing: the app's
// own page on a multi-user app is sent to sign in; anyone else is told it
// needs a credential.
func (a *Adapter) unauthenticated(headers map[string]string, message string) (int, M) {
	if a.multiUser && a.fromOwnPage(headers) {
		return errEnv(401, "sign_in_required", "Sign in to use this app.", M{"signInUrl": accountURL + "#sign-in"})
	}
	return errEnv(401, codeAgentTokenRequired, message, M{"how": a.credentialHint})
}

// caller is who a request acts for, and the reach it was given.
type caller struct {
	// {"credentialId", "agentName", "principal", "role"} — what runners get
	ctx M
	// the scopes the request holds (a credential's are already intersected
	// with its person's)
	held map[string]bool
	// an uncredentialled read on a single-user app, which the scope check does
	// not apply to
	anonymous bool
	// the credential presented, if any
	grant *Grant
}

func callContext(credentialID string, agentName any, principal, role string) M {
	return M{"credentialId": credentialID, "agentName": agentName, "principal": principal, "role": role}
}

// resolve decides who the caller is, in a fixed order: a foreign origin is
// refused; then the agent credential; then, on a multi-user app, the session
// (a change must come from the app's own page); on `authMode: none`, the
// app's own View is the owner. A non-nil refusal is the reply to send.
func (a *Adapter) resolve(headers map[string]string, isWrite bool) (*caller, int, M) {
	if a.isForeignOrigin(headers) {
		status, body := errEnv(403, "forbidden_origin", "Refused: request Origin is not this app's own.", nil)
		return nil, status, body
	}
	p, status, refusal := a.credentialOf(headers)
	if refusal != nil {
		return nil, status, refusal
	}
	if p != nil {
		grant := p.grant
		return &caller{ctx: callContext(grant.CredentialID, orNull(grant.AgentName), p.info.ID, p.info.Role), held: p.held, grant: &grant}, 0, nil
	}
	if a.multiUser {
		if _, account := a.sessionOf(headers); account != nil {
			// A signed-in change must come from this app's own page (CSRF, spec §4).
			if isWrite && !a.isSameOrigin(headers) {
				status, body := errEnv(403, "forbidden_origin", "A signed-in change must come from this app's own page.", nil)
				return nil, status, body
			}
			held := a.permissions(a.principalInfo(account.ID))
			if held == nil {
				held = map[string]bool{}
			}
			return &caller{ctx: callContext("session", nil, account.ID, account.Role), held: held}, 0, nil
		}
		status, body := a.unauthenticated(headers, "This app needs a credential.")
		return nil, status, body
	}
	// The app's own UI (same origin) is trusted: no credential needed. A
	// browser sends Origin only on a change; on a read it marks the request
	// with Sec-Fetch-Site, which a web page cannot forge. A local program can,
	// but on this mode it already reads everything without a credential, so
	// only a change is held to the stronger Origin rule.
	if a.isSameOrigin(headers) || (!isWrite && a.fromOwnPage(headers)) {
		owner := ownerPrincipal
		return &caller{ctx: callContext("ui", nil, owner.ID, owner.Role), held: a.permissions(&owner)}, 0, nil
	}
	// A program write always needs a credential; an anonymous read on a
	// single-user app proceeds as the owner.
	if isWrite {
		status, body := a.unauthenticated(headers, "This write requires an agent credential.")
		return nil, status, body
	}
	return &caller{ctx: callContext("anonymous", nil, ownerPrincipal.ID, ownerPrincipal.Role), anonymous: true}, 0, nil
}

// authorize runs the fixed chain: origin, then credential, then scope.
// A nil errBody means the caller may proceed with ctx.
func (a *Adapter) authorize(headers map[string]string, scope string, isWrite bool) (ctx M, status int, errBody M) {
	c, status, refusal := a.resolve(headers, isWrite)
	if refusal != nil {
		return nil, status, refusal
	}
	if scope != "" && !c.anonymous && !c.held[scope] {
		s, b := errEnv(403, codeInsufficientScope, "This credential does not hold "+scope+".", M{"required": scope})
		return nil, s, b
	}
	return c.ctx, 0, nil
}

// manager is who may manage this app's accounts and credentials (spec §2.4).
type manager struct {
	principal string
	role      string
}

// managerOf is the caller as a manager: a signed-in person, the app's own
// View on `authMode: none`, or the admin credential. An agent's delegated
// credential is never one. `write` applies the same-origin rule to a
// signed-in change.
func (a *Adapter) managerOf(headers map[string]string, write bool) (*manager, int, M) {
	c, status, refusal := a.resolve(headers, write)
	if refusal != nil {
		return nil, status, refusal
	}
	if c.grant != nil {
		if !c.grant.Admin {
			status, body := errEnv(403, "not_a_manager", "An agent's credential cannot manage accounts or credentials.", nil)
			return nil, status, body
		}
		return &manager{principal: ownerPrincipal.ID, role: ownerPrincipal.Role}, 0, nil
	}
	if c.anonymous {
		status, body := a.unauthenticated(headers, "Managing this app needs a credential.")
		return nil, status, body
	}
	return &manager{principal: getStr(c.ctx, "principal"), role: getStr(c.ctx, "role")}, 0, nil
}

// publicOrigin is where this app is reached, for links handed to a person.
// The Host header has already passed the host check by the time a route runs.
func (a *Adapter) publicOrigin(headers map[string]string) string {
	if a.publicURL != "" {
		return a.publicURL
	}
	if host := headers["host"]; host != "" {
		return "http://" + host
	}
	if len(a.ownOrigins) > 0 {
		return a.ownOrigins[0]
	}
	return ""
}

// ownedOnly is whether ctx sees only the records it owns in this entity
// (spec §5).
func (a *Adapter) ownedOnly(d M, ctx M) bool {
	return a.multiUser && getStr(d, "ownedBy") != "" && getStr(ctx, "role") != "owner"
}

// visible is the record if ctx may see it, else nil: another member's record
// is indistinguishable from a missing one.
func (a *Adapter) visible(d M, ctx M, rec M) M {
	if rec == nil {
		return nil
	}
	if a.ownedOnly(d, ctx) && getStr(rec, getStr(d, "ownedBy")) != getStr(ctx, "principal") {
		return nil
	}
	return rec
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

/* -- dispatch ---------------------------------------------------------------- */

// accessFor is what this caller may do, for rendering access on a describe
// level. It asks resolve, exactly as authorize does: a caller it refuses has
// no access; an anonymous read on a single-user app may read everything and
// run read-only operations, but change nothing (authorize would 401 the
// write, and an agent plans from what describe tells it); anyone else holds
// the scopes their request was given.
func (a *Adapter) accessFor(headers map[string]string) accessView {
	c, _, refusal := a.resolve(headers, false)
	if refusal != nil {
		return accessView{
			read:  func(string) bool { return false },
			write: func(string) bool { return false },
			run:   func(string) bool { return false },
		}
	}
	if c.anonymous {
		return accessView{
			read:  func(string) bool { return true },
			write: func(string) bool { return false },
			run:   func(o string) bool { return getBool(a.opByName[o], "readOnly") },
		}
	}
	held := c.held
	return accessView{
		read:  func(e string) bool { return held["data:"+e+":read"] },
		write: func(e string) bool { return held["data:"+e+":write"] },
		run:   func(o string) bool { return held["op:"+o] },
	}
}

// reachAsScopes is the same reach written as the scope names a grant would
// carry, so whoami and describe cannot disagree about one caller.
func (a *Adapter) reachAsScopes(access accessView) []string {
	scopes := map[string]bool{}
	for name := range a.entityDefs {
		if access.read(name) {
			scopes["data:"+name+":read"] = true
		}
		if access.write(name) {
			scopes["data:"+name+":write"] = true
		}
	}
	for _, o := range a.operations {
		if access.run(getStr(o, "name")) {
			scopes["op:"+getStr(o, "name")] = true
		}
	}
	return sortedKeys(scopes)
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
	ctx, status, refusal := a.authorize(headers, "data:"+entity+":read", false)
	if refusal != nil {
		return status, refusal
	}

	recordID := segments[2]
	record := a.visible(d, ctx, a.store.getRecord(entity, recordID))
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

// A miss is usually a guessed route, so it names the routes that answer.
const unknownRouteMessage = "No such route. Operations are invoked with POST /api/ops/<name>; GET /api/_a2app/describe lists them."

var recordsRe = regexp.MustCompile(`^/api/collections/([^/]+)/records(?:/([^/]+))?$`)
var opsRe = regexp.MustCompile(`^/api/ops/([^/]+)$`)
var trailingSlashRe = regexp.MustCompile(`/+$`)

// dispatch routes one protocol request: method, path, lower-cased headers,
// parsed JSON body, query. It returns the status, the JSON payload, and the
// headers the reply carries beyond its content type (a session's Set-Cookie).
func (a *Adapter) dispatch(method, path string, headers map[string]string, body M, query map[string]string) (int, M, map[string]string) {
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

	// Before any route, including the unauthenticated identity document, which
	// is otherwise a free fingerprint of the app for a rebound page: binding
	// loopback does not stop a page on evil.com whose DNS re-resolves to
	// 127.0.0.1, but its Host header still says evil.com.
	if host, ok := headers["host"]; ok {
		if status, refusal := a.hostRefusal(host); refusal != nil {
			return status, refusal, nil
		}
	}
	// Accounts, sessions and invites — the routes whose replies set the
	// session cookie. They exist only on a multi-user app.
	for _, prefix := range []string{"/api/_a2app/session", "/api/_a2app/invites", "/api/_a2app/users"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			if !a.multiUser {
				status, refusal := errEnv(404, "not_multi_user", "This app has no accounts: its authMode is none.", nil)
				return status, refusal, nil
			}
			return a.handleAccounts(method, path, headers, body)
		}
	}
	status, payload := a.route(method, path, headers, body, q)
	return status, payload, nil
}

// route answers every protocol path but the account routes.
func (a *Adapter) route(method, path string, headers map[string]string, body M, q map[string]string) (int, M) {
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
		// whoami answers whoever this app will actually serve, which is what
		// authorize decides — so it asks the same question. The 401 that
		// remains is the honest one: on a multi-user app with nothing
		// presented, authorize really would refuse.
		c, status, refusal := a.resolve(headers, false)
		if refusal != nil {
			return status, refusal
		}
		var principalName, expiresAt any
		if info := a.principalInfo(getStr(c.ctx, "principal")); info != nil {
			principalName = info.Name
		}
		if c.grant != nil {
			expiresAt = orNull(c.grant.ExpiresAt)
		}
		// The reach the request was given: a credential's scopes intersected
		// with what its person may do now, or a person's own. An anonymous read
		// on a single-user app was never scope-checked, so it reports the reach
		// describe renders for it — one source, so the two cannot disagree.
		scopes := sortedKeys(c.held)
		if c.anonymous {
			scopes = a.reachAsScopes(a.accessFor(headers))
		}
		return 200, M{
			"a2app": true, "credentialId": c.ctx["credentialId"], "agentName": c.ctx["agentName"],
			"principal": c.ctx["principal"], "principalName": principalName, "role": c.ctx["role"],
			"expiresAt": expiresAt, "scopes": scopes,
		}
	}
	if strings.HasPrefix(path, "/api/_a2app/auth/") {
		// Unauthenticated by design (an agent starts here with nothing), so it
		// is metered like an operation before anything is looked up.
		if status, limited := a.rateGate(headers, "ops"); limited != nil {
			return status, limited
		}
		if status, reply, ok := a.handleDevice(method, path, headers, body); ok {
			return status, reply
		}
	}
	if path == "/api/_a2app/credentials" || strings.HasPrefix(path, "/api/_a2app/credentials/") {
		return a.handleCredentials(method, path, headers, body)
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

	return errEnv(404, "not_found", unknownRouteMessage, nil)
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
		ctx, status, errBody := a.authorize(headers, "data:"+entity+":read", false)
		if errBody != nil {
			return status, errBody
		}
		if recID != "" {
			rec := a.visible(d, ctx, a.store.getRecord(entity, recID))
			if rec == nil {
				return errEnv(404, "record_not_found", "No "+entity+` record "`+recID+`".`, nil)
			}
			return 200, rec
		}
		listQuery := queryToM(query)
		if a.ownedOnly(d, ctx) {
			listQuery["where"] = map[string]string{getStr(d, "ownedBy"): getStr(ctx, "principal")}
		}
		result, err := a.store.listRecords(entity, listQuery)
		if err != nil {
			// Refuse, never ignore: unfiltered rows under a filter would be a
			// 200 with the wrong records (see the grammar's comment).
			return errEnv(400, "invalid_filter", err.Error(), nil)
		}
		return 200, result
	}

	ctx, status, errBody := a.authorize(headers, "data:"+entity+":write", true)
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
		if a.ownedOnly(d, ctx) && a.visible(d, ctx, a.store.getRecord(entity, recID)) == nil {
			return errEnv(404, "record_not_found", "No "+entity+` record "`+recID+`".`, nil)
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

	// Backend write. The owner field is the adapter's to set: the guard has
	// already refused a client that tried, because it is read-only.
	var stored M
	if method == "POST" {
		create := body
		if ownedBy := getStr(d, "ownedBy"); ownedBy != "" {
			create = M{}
			for k, v := range body {
				create[k] = v
			}
			create[ownedBy] = ctx["principal"]
		}
		stored = a.materialize(entity, create)
		a.store.putRecord(entity, stored)
	} else {
		if recID == "" {
			return errEnv(400, "usage", "PATCH requires a record id.", nil)
		}
		existing := a.visible(d, ctx, a.store.getRecord(entity, recID))
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
// must answer operation_failed, never take the process down mid-request. The
// runner's store is bound to its caller, so a task it queues is done by an
// agent acting as whoever called it.
func (a *Adapter) runOperation(runner OperationRunner, args M, ctx M) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return runner(args, ctx, a.store.forCaller(getStr(ctx, "principal")))
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

	a.store.sweep()

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
		// A terminal write belongs to a live claim. Once the sweeper has returned
		// a task to the queue, a late completion from the run that abandoned it
		// must not close work someone else may now be doing.
		if getStr(task, "status") != "working" && getStr(task, "status") != "input-required" {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" is "+getStr(task, "status")+", not in progress.", nil)
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
	case "credential":
		// What the bridge runs the task's harness with (spec §6.2): the person
		// who queued it, the capability's scopes, and no life past the task.
		mgr, status, refusal := a.managerOf(headers, true)
		if refusal != nil {
			return status, refusal
		}
		if mgr.role != "owner" {
			return errEnv(403, "not_a_manager", "Only an owner issues a task's credential.", nil)
		}
		if terminalTask[getStr(task, "status")] {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" already reached "+getStr(task, "status")+".", nil)
		}
		request, _ := task["request"].(M)
		principal := getStr(request, "principal")
		if principal == "" {
			principal = ownerPrincipal.ID
		}
		info := a.principalInfo(principal)
		if info == nil || !info.Active {
			return errEnv(401, "principal_inactive", "The person who queued this task is no longer active.", nil)
		}
		agentName, problem := parseAgentName(body["agentName"])
		if problem != "" {
			return errEnv(400, "usage", problem, nil)
		}
		scopes := []string{"*"}
		if declared, ok := a.capabilities[getStr(request, "capability")]["scopes"]; ok && declared != nil {
			scopes = scopeList(declared)
		}
		token, grant := a.mintCredential(principal, agentName, scopes, taskCredentialSeconds, taskID)
		return 201, M{"a2app": true, "token": token, "credential": credentialWire(grant, info.Name)}
	}
	return errEnv(404, "usage", `Unknown task action "`+action+`".`, nil)
}

func taskWire(t M) M {
	// `principal` is who queued the task (null for the app's own work) — the
	// person its agent acts as.
	request := M{"principal": nil}
	if r, ok := t["request"].(M); ok {
		for k, v := range r {
			request[k] = v
		}
	}
	return M{
		"id": t["id"], "app": t["app"], "event": t["event"], "status": t["status"],
		"request": request, "claim": t["claim"], "progress": t["progress"],
		"result": t["result"], "reason": t["reason"], "createdAt": t["createdAt"],
		"updatedAt": t["updatedAt"], "pollAfterMs": 2000,
	}
}

/* -- app -> agent -------------------------------------------------------------------- */

// trigger emits a declared event and, when capability is non-empty, queues a
// task — work the app queues on its own, so nobody asked: the task's principal
// is null and its agent runs as the owner.
func (a *Adapter) trigger(etype string, payload M, capability string) (M, error) {
	return a.store.trigger(etype, payload, capability)
}

/* -- accounts, sessions, invites (multi-user) ---------------------------------------- */
// spec/v0_2/auth.md §4. Parity oracle: adapter-core accounts.ts.
//
//   GET/POST/DELETE /api/_a2app/session        who is signed in · sign in · sign out
//   POST /api/_a2app/invites                    a one-time setup link (owner manager)
//   GET/POST /api/_a2app/invites/{code}         read · accept (creates the account)
//   GET /api/_a2app/users                       every account (owner manager)
//   PATCH /api/_a2app/users/{id}                activate/deactivate, change role
//
// Accounts are adapter state, never records: they are not served by the
// records API, and a password hash never leaves this section.

const (
	sessionTTL       = 14 * 24 * time.Hour
	inviteTTL        = 7 * 24 * time.Hour
	signInFailureMax = 10
	signInWindow     = 15 * time.Minute
	loginMax         = 254
	nameMax          = 100
)

// accountWire is the account as served: never its password hash.
func accountWire(account Account) M {
	return M{
		"id": account.ID, "name": account.Name, "login": account.Login, "role": account.Role,
		"active": account.Active, "createdAt": account.CreatedAt,
	}
}

func accountReply(account Account) M {
	reply := accountWire(account)
	reply["a2app"] = true
	return reply
}

// plain is a reply that sets no header.
func plain(status int, body M) (int, M, map[string]string) { return status, body, nil }

func (a *Adapter) sessionCookieHeader(value string, maxAge time.Duration) map[string]string {
	return map[string]string{"Set-Cookie": sessionCookie(a.sessionCookieName, value, int(maxAge/time.Second), a.secureCookies)}
}

func (a *Adapter) accounts() []Account {
	out := []Account{}
	for _, r := range authRows[Account](a.store, tableUsers) {
		out = append(out, r.row)
	}
	return out
}

func (a *Adapter) accountByLogin(login string) *Account {
	for _, account := range a.accounts() {
		if account.Login == login {
			found := account
			return &found
		}
	}
	return nil
}

func (a *Adapter) activeOwners() int {
	n := 0
	for _, account := range a.accounts() {
		if account.Role == "owner" && account.Active {
			n++
		}
	}
	return n
}

// handleAccounts routes one request under /api/_a2app/{session,invites,users}.
func (a *Adapter) handleAccounts(method, path string, headers map[string]string, body M) (int, M, map[string]string) {
	if body == nil {
		body = M{}
	}
	switch {
	case path == "/api/_a2app/session":
		return a.handleSession(method, headers, body)
	case path == "/api/_a2app/invites":
		return plain(a.createInvite(method, headers, body))
	case strings.HasPrefix(path, "/api/_a2app/invites/"):
		return a.handleInvite(method, strings.TrimPrefix(path, "/api/_a2app/invites/"), headers, body)
	case path == "/api/_a2app/users":
		return plain(a.handleUsers(method, "", headers, body))
	case strings.HasPrefix(path, "/api/_a2app/users/"):
		return plain(a.handleUsers(method, strings.TrimPrefix(path, "/api/_a2app/users/"), headers, body))
	}
	return plain(errEnv(404, "not_found", unknownRouteMessage, nil))
}

func (a *Adapter) startSession(account Account, status int) (int, M, map[string]string) {
	secret := newSecret()
	created := a.now()
	a.store.putAuthRow(tableSessions, hashSecret(secret), sessionRow{
		Principal: account.ID, CreatedAt: isoOf(created), ExpiresAt: isoOf(created.Add(sessionTTL)),
	})
	return status, accountReply(account), a.sessionCookieHeader(secret, sessionTTL)
}

func (a *Adapter) handleSession(method string, headers map[string]string, body M) (int, M, map[string]string) {
	switch method {
	case "GET":
		_, account := a.sessionOf(headers)
		if account == nil {
			return plain(errEnv(401, "sign_in_required", "Not signed in.", M{"signInUrl": accountURL + "#sign-in"}))
		}
		return 200, accountReply(*account), nil
	case "DELETE":
		if key, account := a.sessionOf(headers); account != nil {
			a.store.deleteAuthRow(tableSessions, key)
		}
		return 200, M{"a2app": true, "ok": true}, a.sessionCookieHeader("", 0)
	case "POST":
	default:
		return plain(errEnv(405, "usage", method+" not allowed on the session.", nil))
	}

	login, loginOK := body["login"].(string)
	password, passwordOK := body["password"].(string)
	if !loginOK || !passwordOK {
		return plain(errEnv(400, "usage", "Sign in with { login, password }.", nil))
	}
	login = normalizeLogin(login)
	if wait := a.signInFailures.retryAfter(login); wait > 0 {
		return plain(errEnv(429, codeRateLimited, "Too many failed sign-ins for this login. Try again later.",
			M{"retryAfterSeconds": wait}))
	}
	account := a.accountByLogin(login)
	matches := false
	if account != nil {
		matches = verifyPassword(password, account.PasswordHash)
	} else {
		a.dummyHashOnce.Do(func() { a.dummyHash = hashPassword(newSecret(), pbkdf2Iterations) })
		verifyPassword(password, a.dummyHash)
	}
	if account == nil || !matches || !account.Active {
		a.signInFailures.fail(login)
		return plain(errEnv(401, "sign_in_failed", "That login and password do not match an active account.", nil))
	}
	a.signInFailures.reset(login)
	return a.startSession(*account, 200)
}

// accountProblem is the reason body is not a valid new account, or "".
func accountProblem(body M) string {
	name, ok := body["name"].(string)
	if !ok || strings.TrimSpace(name) == "" || jsLength(strings.TrimSpace(name)) > nameMax {
		return fmt.Sprintf("name must be 1–%d characters.", nameMax)
	}
	login, ok := body["login"].(string)
	if !ok || normalizeLogin(login) == "" || jsLength(normalizeLogin(login)) > loginMax {
		return fmt.Sprintf("login must be 1–%d characters.", loginMax)
	}
	password, ok := body["password"].(string)
	if !ok || jsLength(password) < passwordMin || jsLength(password) > passwordMax {
		return fmt.Sprintf("password must be %d–%d characters.", passwordMin, passwordMax)
	}
	return ""
}

// liveInvite is the invite behind code and its key, dropping it if it expired.
func (a *Adapter) liveInvite(code string) (string, *inviteRow) {
	key := hashSecret(code)
	var invite inviteRow
	if !a.store.authRow(tableInvites, key, &invite) {
		return "", nil
	}
	if expires, ok := parseISO(invite.ExpiresAt); !ok || !expires.After(a.now()) {
		a.store.deleteAuthRow(tableInvites, key)
		return "", nil
	}
	return key, &invite
}

func (a *Adapter) createInvite(method string, headers map[string]string, body M) (int, M) {
	if method != "POST" {
		return errEnv(405, "usage", method+" not allowed on invites.", nil)
	}
	mgr, status, refusal := a.managerOf(headers, true)
	if refusal != nil {
		return status, refusal
	}
	if mgr.role != "owner" {
		return errEnv(403, "not_a_manager", "Only an owner can invite people.", nil)
	}
	role := "member"
	if v, ok := body["role"]; ok && v != nil {
		s, _ := v.(string)
		if s != "owner" && s != "member" {
			return errEnv(400, "usage", `role is "owner" or "member".`, nil)
		}
		role = s
	}
	secret := newSecret()
	created := a.now()
	invite := inviteRow{Role: role, CreatedAt: isoOf(created), ExpiresAt: isoOf(created.Add(inviteTTL))}
	a.store.putAuthRow(tableInvites, hashSecret(secret), invite)
	return 201, M{
		"a2app": true, "code": secret, "url": a.publicOrigin(headers) + accountURL + "#setup/" + secret,
		"role": invite.Role, "expiresAt": invite.ExpiresAt,
	}
}

func (a *Adapter) handleInvite(method, code string, headers map[string]string, body M) (int, M, map[string]string) {
	const invalid = "This invite link is not valid: it was used, or it expired."
	_, invite := a.liveInvite(code)
	if invite == nil {
		return plain(errEnv(404, "invite_invalid", invalid, nil))
	}
	if method == "GET" {
		return 200, M{"a2app": true, "role": invite.Role, "expiresAt": invite.ExpiresAt}, nil
	}
	if method != "POST" {
		return plain(errEnv(405, "usage", method+" not allowed on an invite.", nil))
	}
	if problem := accountProblem(body); problem != "" {
		return plain(errEnv(400, "usage", problem, nil))
	}
	login := normalizeLogin(body["login"].(string))
	if a.accountByLogin(login) != nil {
		return plain(errEnv(409, "login_taken", "That login is already in use.", nil))
	}
	passwordHash := hashPassword(body["password"].(string), pbkdf2Iterations)
	// The slow hash is done. From here to the write the checks and the write
	// are one step, so a second acceptance of the same invite, or a second
	// account racing for the same login, sees this one's result.
	a.authMu.Lock()
	defer a.authMu.Unlock()
	key, still := a.liveInvite(code)
	if still == nil {
		return plain(errEnv(404, "invite_invalid", invalid, nil))
	}
	if a.accountByLogin(login) != nil {
		return plain(errEnv(409, "login_taken", "That login is already in use.", nil))
	}
	account := Account{
		ID: newID("usr"), Name: strings.TrimSpace(body["name"].(string)), Login: login, Role: still.Role,
		Active: true, CreatedAt: isoOf(a.now()), PasswordHash: passwordHash,
	}
	a.store.deleteAuthRow(tableInvites, key)
	a.store.putAuthRow(tableUsers, account.ID, account)
	return a.startSession(account, 201)
}

func (a *Adapter) handleUsers(method, id string, headers map[string]string, body M) (int, M) {
	mgr, status, refusal := a.managerOf(headers, method != "GET")
	if refusal != nil {
		return status, refusal
	}
	if mgr.role != "owner" {
		return errEnv(403, "not_a_manager", "Only an owner can manage people.", nil)
	}
	if id == "" {
		if method != "GET" {
			return errEnv(405, "usage", method+" not allowed on users.", nil)
		}
		accounts := a.accounts()
		sort.SliceStable(accounts, func(i, j int) bool { return accounts[i].CreatedAt < accounts[j].CreatedAt })
		users := []M{}
		for _, account := range accounts {
			users = append(users, accountWire(account))
		}
		return 200, M{"a2app": true, "users": users}
	}
	if method != "PATCH" {
		return errEnv(405, "usage", method+" not allowed on a user.", nil)
	}
	// One step from the read to the write: two owners demoting each other at
	// once must not both pass the last-owner check.
	a.authMu.Lock()
	defer a.authMu.Unlock()
	var account Account
	if !a.store.authRow(tableUsers, id, &account) {
		return errEnv(404, "not_found", `No account "`+id+`".`, nil)
	}
	next := account
	if v, ok := body["active"]; ok {
		active, isBool := v.(bool)
		if !isBool {
			return errEnv(400, "usage", "active is true or false.", nil)
		}
		next.Active = active
	}
	if v, ok := body["role"]; ok {
		role, _ := v.(string)
		if role != "owner" && role != "member" {
			return errEnv(400, "usage", `role is "owner" or "member".`, nil)
		}
		next.Role = role
	}
	losesOwner := account.Role == "owner" && account.Active && (next.Role != "owner" || !next.Active)
	if losesOwner && a.activeOwners() == 1 {
		return errEnv(409, "last_owner", "This is the last active owner. Make someone else an owner first.", nil)
	}
	a.store.putAuthRow(tableUsers, next.ID, next)
	return 200, accountReply(next)
}

/* -- credentials -------------------------------------------------------------------- */
// spec/v0_2/auth.md §2, §8. Parity oracle: adapter-core credentials.ts.
//
//   GET /api/_a2app/credentials          a manager's own (an owner: everyone's)
//   POST /api/_a2app/credentials         issue one; the token is in this reply only
//   DELETE /api/_a2app/credentials/{id}  revoke (a manager, or the credential itself)
//
// Every credential this app issues is made by mintCredential: a 256-bit token
// returned once, stored as its SHA-256, bound to one principal, always
// expiring. Whatever its scopes say, each request it makes is limited to what
// that principal may do at the time (credentialOf).

const (
	defaultExpiresSeconds = 30 * 24 * 60 * 60
	minExpiresSeconds     = 60
	maxExpiresSeconds     = 365 * 24 * 60 * 60
	// A task credential's lifetime (spec §6.2); its task ending kills it sooner.
	taskCredentialSeconds = 60 * 60
)

// credentialWire is a credential as listed: never its token or the token's hash.
func credentialWire(g Grant, principalName any) M {
	return M{
		"credentialId": g.CredentialID, "principal": g.Principal, "principalName": principalName,
		"agentName": orNull(g.AgentName), "scopes": g.Scopes, "createdAt": g.CreatedAt,
		"expiresAt": orNull(g.ExpiresAt), "lastUsedAt": orNull(g.LastUsedAt), "task": orNull(g.Task),
	}
}

// mintCredential issues a credential: it stores the token's hash and returns
// the token — once — with the grant. `task` is "" except for a task credential.
func (a *Adapter) mintCredential(principal, agentName string, scopes []string, expiresInSeconds int, task string) (string, Grant) {
	token := newToken()
	now := a.now()
	grant := Grant{
		CredentialID: newID("cred"), TokenHash: hashSecret(token), Principal: principal, AgentName: agentName,
		Scopes: scopes, CreatedAt: isoOf(now), ExpiresAt: isoOf(now.Add(time.Duration(expiresInSeconds) * time.Second)),
		Task: task,
	}
	a.store.putGrant(grant)
	return token, grant
}

// parseAgentName is the optional agent name a caller gave a credential,
// checked: "" for none, or the reason it cannot be used.
func parseAgentName(value any) (name string, problem string) {
	if value == nil {
		return "", ""
	}
	s, ok := value.(string)
	if !ok || strings.TrimSpace(s) == "" || jsLength(s) > 100 {
		return "", "agentName is 1–100 characters."
	}
	return strings.TrimSpace(s), ""
}

// parseGrantRequest is the scopes and lifetime a caller asked for, checked, or
// the reason they cannot be granted. `scopes` defaults to `*`; every entry
// must be `*` or a scope the app declares.
func parseGrantRequest(body M, declared map[string]bool) (scopes []string, expiresInSeconds int, problem string) {
	raw, ok := body["scopes"]
	if !ok || raw == nil {
		raw = []any{"*"}
	}
	items := toAnyList(raw)
	if len(items) == 0 {
		return nil, 0, `scopes is a non-empty list of scope names (or ["*"]).`
	}
	asked := []string{}
	for _, item := range items {
		s, isString := item.(string)
		if !isString {
			return nil, 0, `scopes is a non-empty list of scope names (or ["*"]).`
		}
		asked = append(asked, s)
	}
	unknown := []string{}
	for _, s := range asked {
		if s != "*" && !declared[s] {
			unknown = append(unknown, s)
		}
	}
	if len(unknown) > 0 {
		return nil, 0, "Not scopes this app declares: " + strings.Join(unknown, ", ") + "."
	}
	expiresInSeconds = defaultExpiresSeconds
	if v, present := body["expiresIn"]; present && v != nil {
		n, isNumber := asFloat(v)
		if !isNumber || n != math.Trunc(n) || n < minExpiresSeconds || n > maxExpiresSeconds {
			return nil, 0, fmt.Sprintf("expiresIn is a whole number of seconds from %d to %d (365 days).",
				minExpiresSeconds, maxExpiresSeconds)
		}
		expiresInSeconds = int(n)
	}
	seen := map[string]bool{}
	for _, s := range asked {
		if !seen[s] {
			seen[s] = true
			scopes = append(scopes, s)
		}
	}
	return scopes, expiresInSeconds, ""
}

// principalName is a principal's name as listed, or nil when it is unknown.
func (a *Adapter) principalName(id string) any {
	if info := a.principalInfo(id); info != nil {
		return info.Name
	}
	return nil
}

// liveGrant is a credential that can still make a request: not the admin
// credential, not revoked, not expired, its task not over.
func (a *Adapter) liveGrant(g Grant) bool {
	if g.Admin || g.RevokedAt != "" {
		return false
	}
	if expires, ok := parseISO(g.ExpiresAt); ok && !expires.After(a.now()) {
		return false
	}
	if g.Task != "" {
		task := a.store.getTask(g.Task)
		if task == nil || terminalTask[getStr(task, "status")] {
			return false
		}
	}
	return true
}

func (a *Adapter) handleCredentials(method, path string, headers map[string]string, body M) (int, M) {
	if body == nil {
		body = M{}
	}
	if path == "/api/_a2app/credentials" {
		switch method {
		case "GET":
			return a.listCredentials(headers)
		case "POST":
			return a.issueCredential(headers, body)
		}
		return errEnv(405, "usage", method+" not allowed on credentials.", nil)
	}
	if method != "DELETE" {
		return errEnv(405, "usage", "A credential is revoked with DELETE.", nil)
	}
	return a.revokeCredential(headers, strings.TrimPrefix(path, "/api/_a2app/credentials/"))
}

func (a *Adapter) listCredentials(headers map[string]string) (int, M) {
	mgr, status, refusal := a.managerOf(headers, false)
	if refusal != nil {
		return status, refusal
	}
	grants := []Grant{}
	for _, g := range a.store.listGrants() {
		if a.liveGrant(g) && (mgr.role == "owner" || g.Principal == mgr.principal) {
			grants = append(grants, g)
		}
	}
	sort.SliceStable(grants, func(i, j int) bool { return grants[i].CreatedAt > grants[j].CreatedAt })
	credentials := []M{}
	for _, g := range grants {
		credentials = append(credentials, credentialWire(g, a.principalName(g.Principal)))
	}
	return 200, M{"a2app": true, "credentials": credentials}
}

func (a *Adapter) issueCredential(headers map[string]string, body M) (int, M) {
	mgr, status, refusal := a.managerOf(headers, true)
	if refusal != nil {
		return status, refusal
	}
	principal := mgr.principal
	if v, ok := body["principal"]; ok && v != nil {
		s, isString := v.(string)
		if !isString {
			return errEnv(400, "usage", `principal is an account id (or "owner").`, nil)
		}
		principal = s
	}
	if principal != mgr.principal && mgr.role != "owner" {
		return errEnv(403, "not_a_manager", "Only an owner can issue a credential for someone else.", nil)
	}
	info := a.principalInfo(principal)
	if info == nil || !info.Active {
		return errEnv(400, "usage", `"`+principal+`" is not an active account of this app.`, nil)
	}
	agentName, problem := parseAgentName(body["agentName"])
	if problem != "" {
		return errEnv(400, "usage", problem, nil)
	}
	scopes, expiresIn, problem := parseGrantRequest(body, a.allScopes())
	if problem != "" {
		return errEnv(400, "usage", problem, nil)
	}
	token, grant := a.mintCredential(principal, agentName, scopes, expiresIn, "")
	return 201, M{"a2app": true, "token": token, "credential": credentialWire(grant, info.Name)}
}

func (a *Adapter) revokeCredential(headers map[string]string, id string) (int, M) {
	grant := a.store.grantByID(id)
	if grant == nil {
		return errEnv(404, "not_found", `No credential "`+id+`".`, nil)
	}
	if grant.Admin {
		return errEnv(403, "not_a_manager", "The admin credential is the app's .agent-token: rotate that file instead.", nil)
	}
	// A credential may always revoke itself — the one thing an agent may do
	// with credentials — so an agent can hand back access it no longer needs.
	p, _, _ := a.credentialOf(headers)
	if p == nil || p.grant.CredentialID != id {
		mgr, status, refusal := a.managerOf(headers, true)
		if refusal != nil {
			return status, refusal
		}
		if mgr.role != "owner" && grant.Principal != mgr.principal {
			return errEnv(404, "not_found", `No credential "`+id+`".`, nil)
		}
	}
	stamp := isoOf(a.now())
	a.store.updateGrant(id, func(g *Grant) {
		if g.RevokedAt == "" {
			g.RevokedAt = stamp
		}
	})
	return 200, M{"a2app": true, "ok": true, "revoked": id}
}

/* -- device-code sign-in ---------------------------------------------------------------- */
// spec/v0_2/auth.md §7 (RFC 8628 shape). Parity oracle: adapter-core device.ts.
//
//   POST /api/_a2app/auth/device               an agent asks; gets a code to show
//   GET  /api/_a2app/auth/device/{userCode}     the person reviews (a manager)
//   POST /api/_a2app/auth/device/{userCode}     the person approves or denies
//   POST /api/_a2app/auth/token                 the agent polls; gets its credential
//
// The person approves on the app's own account page, signed in as themselves;
// the credential issued acts for them, with the scopes they approved. No
// password or session ever reaches the agent. Codes live 10 minutes, are single
// use, and the device code is stored only as its hash. Every transition runs
// under authMu, so a code is approved, denied or redeemed exactly once.

const (
	deviceCodeTTLSeconds      = 600
	devicePollIntervalSeconds = 5
	deviceSlowDownStepSeconds = 5
)

// handleDevice routes one request under /api/_a2app/auth/; handled is false
// for a path that is not one of its routes.
func (a *Adapter) handleDevice(method, path string, headers map[string]string, body M) (status int, reply M, handled bool) {
	if body == nil {
		body = M{}
	}
	routed := func(status int, reply M) (int, M, bool) { return status, reply, true }
	switch {
	case path == "/api/_a2app/auth/device":
		if method != "POST" {
			return routed(errEnv(405, "usage", "Start a sign-in with POST.", nil))
		}
		return routed(a.startDevice(headers, body))
	case path == "/api/_a2app/auth/token":
		if method != "POST" {
			return routed(errEnv(405, "usage", "Poll with POST.", nil))
		}
		return routed(a.pollDevice(body))
	case strings.HasPrefix(path, "/api/_a2app/auth/device/"):
		code := strings.TrimPrefix(path, "/api/_a2app/auth/device/")
		switch method {
		case "GET":
			return routed(a.reviewDevice(headers, code))
		case "POST":
			return routed(a.decideDevice(headers, code, body))
		}
		return routed(errEnv(405, "usage", method+" not allowed on a sign-in request.", nil))
	}
	return 0, nil, false
}

// liveDevices is every sign-in still in progress, dropping the expired as it goes.
func (a *Adapter) liveDevices() []keyedRow[deviceRow] {
	now := a.now()
	live := []keyedRow[deviceRow]{}
	for _, r := range authRows[deviceRow](a.store, tableDevices) {
		if expires, ok := parseISO(r.row.ExpiresAt); ok && expires.After(now) {
			live = append(live, r)
		} else {
			a.store.deleteAuthRow(tableDevices, r.key)
		}
	}
	return live
}

// pendingDevice is the sign-in waiting under a user code as typed, or nil.
func (a *Adapter) pendingDevice(input string) *keyedRow[deviceRow] {
	code := normalizeUserCode(input)
	if code == "" {
		return nil
	}
	for _, r := range a.liveDevices() {
		if r.row.UserCode == code && r.row.Status == "pending" {
			found := r
			return &found
		}
	}
	return nil
}

func (a *Adapter) startDevice(headers map[string]string, body M) (int, M) {
	scopes, expiresIn, problem := parseGrantRequest(body, a.allScopes())
	if problem != "" {
		return errEnv(400, "usage", problem, nil)
	}
	agentName := ""
	if v, present := body["agentName"]; present {
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" || jsLength(s) > 100 {
			return errEnv(400, "usage", "agentName is 1–100 characters.", nil)
		}
		agentName = strings.TrimSpace(s)
	}
	a.authMu.Lock()
	defer a.authMu.Unlock()
	taken := map[string]bool{}
	for _, r := range a.liveDevices() {
		taken[r.row.UserCode] = true
	}
	userCode := newUserCode()
	for taken[userCode] {
		userCode = newUserCode()
	}
	deviceCode := newSecret()
	now := a.now()
	a.store.putAuthRow(tableDevices, hashSecret(deviceCode), deviceRow{
		UserCode: userCode, AgentName: agentName, Scopes: scopes, ExpiresInSeconds: expiresIn,
		CreatedAt: isoOf(now), ExpiresAt: isoOf(now.Add(deviceCodeTTLSeconds * time.Second)),
		Interval: devicePollIntervalSeconds, Status: "pending",
	})
	approve := a.publicOrigin(headers) + accountURL + "#approve"
	return 200, M{
		"a2app": true, "deviceCode": deviceCode, "userCode": userCode,
		"verificationUri": approve, "verificationUriComplete": approve + "/" + userCode,
		"expiresIn": deviceCodeTTLSeconds, "interval": devicePollIntervalSeconds,
	}
}

func (a *Adapter) pollDevice(body M) (int, M) {
	deviceCode, ok := body["deviceCode"].(string)
	if !ok {
		return errEnv(400, "usage", "Poll with { deviceCode }.", nil)
	}
	key := hashSecret(deviceCode)
	a.authMu.Lock()
	defer a.authMu.Unlock()
	var row deviceRow
	found := a.store.authRow(tableDevices, key, &row)
	now := a.now()
	if expires, ok := parseISO(row.ExpiresAt); !found || !ok || !expires.After(now) {
		if found {
			a.store.deleteAuthRow(tableDevices, key)
		}
		return errEnv(400, "expired_token", "This sign-in request expired or was already used. Start again.", nil)
	}
	if row.Status == "denied" {
		a.store.deleteAuthRow(tableDevices, key)
		return errEnv(400, "access_denied", "The person declined this agent's request.", nil)
	}
	if row.Status == "approved" && row.ApprovedBy != "" && row.ApprovedScopes != nil {
		// Single use: the row goes before the credential is handed out.
		a.store.deleteAuthRow(tableDevices, key)
		info := a.principalInfo(row.ApprovedBy)
		if info == nil || !info.Active {
			return errEnv(400, "access_denied", "The person who approved this is no longer active.", nil)
		}
		token, grant := a.mintCredential(row.ApprovedBy, row.AgentName, row.ApprovedScopes, row.ExpiresInSeconds, "")
		return 200, M{"a2app": true, "token": token, "credential": credentialWire(grant, info.Name)}
	}
	polledAt := now.UnixMilli()
	if row.LastPolledAt != nil && polledAt-*row.LastPolledAt < int64(row.Interval)*1000 {
		row.Interval += deviceSlowDownStepSeconds
		row.LastPolledAt = &polledAt
		a.store.putAuthRow(tableDevices, key, row)
		return errEnv(400, "slow_down", fmt.Sprintf("Polling too fast: wait %d s between polls.", row.Interval),
			M{"interval": row.Interval})
	}
	row.LastPolledAt = &polledAt
	a.store.putAuthRow(tableDevices, key, row)
	return errEnv(400, "authorization_pending", "Waiting for the person to approve.", M{"interval": row.Interval})
}

const deviceCodeInvalid = "No sign-in request with that code is waiting: it was used, or it expired."

func (a *Adapter) reviewDevice(headers map[string]string, userCode string) (int, M) {
	if _, status, refusal := a.managerOf(headers, false); refusal != nil {
		return status, refusal
	}
	found := a.pendingDevice(userCode)
	if found == nil {
		return errEnv(404, "device_code_invalid", deviceCodeInvalid, nil)
	}
	row := found.row
	return 200, M{
		"a2app": true, "userCode": row.UserCode, "agentName": orNull(row.AgentName), "scopes": row.Scopes,
		"expiresIn": row.ExpiresInSeconds, "expiresAt": row.ExpiresAt,
	}
}

func (a *Adapter) decideDevice(headers map[string]string, userCode string, body M) (int, M) {
	mgr, status, refusal := a.managerOf(headers, true)
	if refusal != nil {
		return status, refusal
	}
	a.authMu.Lock()
	defer a.authMu.Unlock()
	found := a.pendingDevice(userCode)
	if found == nil {
		return errEnv(404, "device_code_invalid", deviceCodeInvalid, nil)
	}
	row := found.row
	approve, ok := body["approve"].(bool)
	if !ok {
		return errEnv(400, "usage", "Decide with { approve: true | false }.", nil)
	}
	if !approve {
		row.Status = "denied"
		a.store.putAuthRow(tableDevices, found.key, row)
		return 200, M{"a2app": true, "ok": true, "status": "denied"}
	}
	// The person may only narrow what was asked for.
	scopes := row.Scopes
	if v, present := body["scopes"]; present {
		approved, _, problem := parseGrantRequest(M{"scopes": v}, a.allScopes())
		if problem != "" {
			return errEnv(400, "usage", problem, nil)
		}
		wider := []string{}
		if !contains(row.Scopes, "*") {
			for _, s := range approved {
				if s == "*" || !contains(row.Scopes, s) {
					wider = append(wider, s)
				}
			}
		}
		if len(wider) > 0 {
			return errEnv(400, "usage", "Approval can only narrow what the agent asked for, not add "+strings.Join(wider, ", ")+".", nil)
		}
		scopes = approved
	}
	row.Status = "approved"
	row.ApprovedBy = mgr.principal
	row.ApprovedScopes = scopes
	a.store.putAuthRow(tableDevices, found.key, row)
	return 200, M{"a2app": true, "ok": true, "status": "approved"}
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
			first.putGrant(Grant{CredentialID: "cred_a", TokenHash: hashSecret("token-a"), Principal: "owner", Scopes: []string{"*"}})
			first.putAuthRow(tableUsers, "usr_a", Account{ID: "usr_a", Login: "a", Role: "member", Active: true})
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
				restored := second.grantByTokenHash(hashSecret("token-a"))
				check("credentials survive a restart, found by their token's hash", restored != nil && restored.CredentialID == "cred_a", true)
				var account Account
				check("accounts survive a restart", second.authRow(tableUsers, "usr_a", &account) && account.Login == "a", true)
				second.putGrant(Grant{CredentialID: "cred_a", TokenHash: hashSecret("token-b"), Principal: "owner", Scopes: []string{"*"}})
				check("a rotated token replaces the old one", second.grantByTokenHash(hashSecret("token-a")) == nil, true)
				check("…with the new one in force", second.grantByTokenHash(hashSecret("token-b")) != nil, true)
				check("an updated grant keeps one row", len(second.listGrants()), 1)
				check("delete removes the row", second.deleteRecord("tasks", "t1"), true)
				check("a second delete reports not-found", second.deleteRecord("tasks", "t1"), false)
				second.Close()
			}
		}
	}

	// 7. Host and network policy: the app answers only to loopback and its own
	//    origins (the public URL among them), and refuses to listen where the
	//    agent token would cross a network in clear.
	if hostApp, err := NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Token: "t", Modules: []M{{"name": "core"}},
		Entities:       map[string]M{},
		AllowedOrigins: []string{"http://127.0.0.1:9931"},
		PublicURL:      "https://crm.example.com",
	}); err != nil {
		failures = append(failures, "could not build an adapter for the host checks: "+err.Error())
	} else {
		check("the public host is answered", hostApp.isAllowedHost("crm.example.com"), true)
		check("…with an explicit port", hostApp.isAllowedHost("crm.example.com:443"), true)
		check("loopback is answered", hostApp.isAllowedHost("127.0.0.2:9931"), true)
		check("an IPv6 loopback literal is answered", hostApp.isAllowedHost("[::1]:9931"), true)
		check("a rebound host is refused", hostApp.isAllowedHost("evil.example.com"), false)
		check("a lookalike host is refused", hostApp.isAllowedHost("localhost.evil.example.com"), false)
		status, _, _ := hostApp.dispatch("GET", "/api/_a2app", map[string]string{"host": "evil.example.com"}, nil, nil)
		check("dispatch refuses a foreign host before identity", status, 403)
		_, refusal := hostApp.hostRefusal("evil.example.com")
		check("the system pages refuse it the same way", refusal["code"], "forbidden_host")
		_, refusal = hostApp.hostRefusal("127.0.0.1:9931")
		check("…and answer on the app's own", refusal == nil, true)
		check("the public origin is the app's own", hostApp.allowedOrigins["https://crm.example.com"], true)
	}
	policy := func(host, public string) string {
		h, p, err := NetworkPolicy(host, public)
		if err != nil {
			return "refused"
		}
		return h + " " + p
	}
	check("loopback by default", policy("", ""), "127.0.0.1 ")
	check("an https public URL is reduced to its origin", policy("", "https://CRM.example.com/x"), "127.0.0.1 https://crm.example.com")
	check("a non-loopback bind needs a public URL", policy("0.0.0.0", ""), "refused")
	check("…an https one", policy("0.0.0.0", "http://localhost:8080"), "refused")
	check("a non-loopback bind behind https is allowed", policy("0.0.0.0", "https://crm.example.com"), "0.0.0.0 https://crm.example.com")
	check("a plain-http public name is refused", policy("", "http://crm.example.com"), "refused")
	check("a plain-http tunnel to loopback is allowed", policy("", "http://localhost:9000"), "127.0.0.1 http://localhost:9000")
	check("a public URL that is not a URL is refused", policy("", "crm.example.com"), "refused")

	// 8. Auth primitives (spec/v0_2/auth.md): what a secret looks like, how a
	//    password is stored and checked, user codes, cookies, the sign-in limit.
	//    The vector below was written by adapter-core's hashPassword, so a hash
	//    stored by either stack verifies on the other.
	const nodeVector = "pbkdf2_sha256$600000$7o2srHKClZ25zLELDgxsaw==$MM/kuhkZzCVSbCeUoHjL0058JRF/QmSic77+nfQavl8="
	check("an adapter-core password hash verifies", verifyPassword("correct horse battery staple", nodeVector), true)
	check("…and refuses the wrong password", verifyPassword("correct horse battery stapler", nodeVector), false)
	check("a second adapter-core vector verifies",
		verifyPassword("a long enough password", "pbkdf2_sha256$1000$16IqCFLklIKzgdi6G+LrRg==$NAcqReE2pGwC/SaXVCiZtbar7S7nTq4+ro3KIkMmq8Y="), true)
	hashed := hashPassword("a long enough password", 1000)
	check("a hash round-trips", verifyPassword("a long enough password", hashed), true)
	check("…and refuses another password", verifyPassword("another long password", hashed), false)
	check("a hash has adapter-core's shape", regexp.MustCompile(`^pbkdf2_sha256\$1000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$`).MatchString(hashed), true)
	check("every hash is salted", hashPassword("a long enough password", 1000) != hashed, true)
	check("a malformed hash never matches", verifyPassword("x", "pbkdf2_sha256$0$AA==$AA=="), false)
	check("…nor another scheme's", verifyPassword("x", "bcrypt$10$abc$def"), false)
	check("a token is a2a_ + 256 bits", regexp.MustCompile(`^a2a_[A-Za-z0-9_-]{43}$`).MatchString(newToken()), true)
	check("a secret is stored as its hex sha256", hashSecret("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
	check("a user code is 8 consonants", regexp.MustCompile(`^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`).MatchString(newUserCode()), true)
	check("a user code ignores case and the dash", normalizeUserCode("bcdf ghjk"), "BCDF-GHJK")
	check("…and is refused when it is not one", normalizeUserCode("AEIO-BCDF"), "")
	check("cookies: first occurrence wins, values decoded, junk skipped",
		parseCookies("=z; a=1; b=x%20y; a=2; c; d=%zz"), map[string]string{"a": "1", "b": "x y"})
	check("the session cookie's attributes",
		sessionCookie("a2app_session_x", "v", 60, true), "a2app_session_x=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure")
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	limiter := newFailureLimiter(10, 15*time.Minute, func() time.Time { return clock })
	for i := 0; i < 9; i++ {
		limiter.fail("bob")
	}
	check("nine sign-in failures do not lock a login", limiter.retryAfter("bob"), 0)
	limiter.fail("bob")
	check("the tenth locks it for the window", limiter.retryAfter("bob"), 900)
	clock = clock.Add(15 * time.Minute)
	check("…which ends", limiter.retryAfter("bob"), 0)
	declaredSet := map[string]bool{"data:notes:read": true, "data:notes:write": true}
	grantScopes, grantExpires, grantProblem := parseGrantRequest(M{}, declaredSet)
	check("a grant request defaults to * for 30 days", []any{grantScopes, grantExpires, grantProblem},
		[]any{[]string{"*"}, 30 * 24 * 60 * 60, ""})
	grantScopes, _, _ = parseGrantRequest(M{"scopes": []any{"data:notes:read", "data:notes:read"}}, declaredSet)
	check("…keeps each scope once", grantScopes, []string{"data:notes:read"})
	_, _, grantProblem = parseGrantRequest(M{"scopes": []any{"data:other:read"}}, declaredSet)
	check("…refuses a scope the app does not declare", grantProblem, "Not scopes this app declares: data:other:read.")
	_, _, grantProblem = parseGrantRequest(M{"expiresIn": 59.0}, declaredSet)
	check("…and a lifetime under a minute", grantProblem != "", true)

	// 9. The resolution order and the ceiling, through dispatch on a
	//    multi-user app: each refusal, effective scopes, ownership through a
	//    credential and a session, CSRF, task credentials.
	notes := map[string]M{"notes": {"module": "core", "ownedBy": "owner", "fields": []M{
		{"name": "title", "type": "string"},
		{"name": "owner", "type": "string", "readOnly": true},
	}}}
	authApp, err := NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Token: "admin-token", Modules: []M{{"name": "core"}},
		Entities: notes, AuthMode: "multi-user", AllowedOrigins: []string{"http://127.0.0.1:9931"},
		Operations: []M{{"name": "review-note", "module": "core", "params": M{"note": M{"type": "string"}}}},
		// A runner written the 0.1 way: it never names who asked.
		Runners: map[string]OperationRunner{
			"review-note": func(args M, _ M, store *Store) (any, error) {
				return store.trigger("note.review", M{"note": args["note"]}, "review")
			},
		},
		Events:       []M{{"type": "note.review"}},
		Capabilities: map[string]M{"review": {"scopes": []string{"data:notes:read"}}},
		PermissionsOf: func(p M) []string {
			if getStr(p, "role") == "owner" {
				return []string{"*"}
			}
			return []string{"data:notes:read", "op:review-note"}
		},
	})
	if err != nil {
		failures = append(failures, "could not build a multi-user adapter: "+err.Error())
	} else {
		call := func(method, path string, headers map[string]string, body M) (int, M) {
			status, reply, _ := authApp.dispatch(method, path, headers, body, nil)
			return status, reply
		}
		as := func(token string) map[string]string { return map[string]string{"x-a2app-token": token} }
		codeOf := func(_ int, reply M) any { return reply["code"] }
		statusOf := func(status int, _ M) int { return status }
		alice := Account{ID: "usr_alice", Name: "Alice", Login: "alice", Role: "owner", Active: true, CreatedAt: nowISO()}
		bob := Account{ID: "usr_bob", Name: "Bob", Login: "bob", Role: "member", Active: true, CreatedAt: nowISO()}
		authApp.store.putAuthRow(tableUsers, alice.ID, alice)
		authApp.store.putAuthRow(tableUsers, bob.ID, bob)
		aliceToken, _ := authApp.mintCredential(alice.ID, "", []string{"*"}, 3600, "")
		bobToken, bobGrant := authApp.mintCredential(bob.ID, "suite", []string{"*"}, 3600, "")

		_, identity := call("GET", "/api/_a2app", nil, nil)
		check("identity speaks 0.2 and says how people sign in",
			[]any{identity["protocol"], identity["authMode"], identity["accountUrl"]}, []any{"0.2", "multi-user", "/_a2app/account"})
		_, admin := call("GET", "/api/_a2app/whoami", as("admin-token"), nil)
		check("the admin credential acts as the owner", []any{admin["principal"], admin["role"], admin["scopes"]},
			[]any{"owner", "owner", []string{"data:notes:read", "data:notes:write", "op:review-note"}})
		_, who := call("GET", "/api/_a2app/whoami", as(bobToken), nil)
		check("a `*` credential is held to its person's permissions",
			[]any{who["principal"], who["principalName"], who["role"], who["scopes"]},
			[]any{"usr_bob", "Bob", "member", []string{"data:notes:read", "op:review-note"}})
		check("…so it cannot write", codeOf(call("POST", "/api/collections/notes/records", as(bobToken), M{"title": "x"})), codeInsufficientScope)
		_, created := call("POST", "/api/collections/notes/records", as(aliceToken), M{"title": "Alice's"})
		check("a record is owned by whoever created it", created["owner"], "usr_alice")
		check("the owner field is the adapter's to write",
			codeOf(call("POST", "/api/collections/notes/records", as(aliceToken), M{"title": "x", "owner": "usr_bob"})), codeReadOnlyField)
		_, listed := call("GET", "/api/collections/notes/records", as(bobToken), nil)
		check("a member does not list another's records", len(toMList(listed["items"])), 0)
		check("…nor read one by id", statusOf(call("GET", "/api/collections/notes/records/"+getStr(created, "id"), as(bobToken), nil)), 404)
		check("an unknown token is refused", codeOf(call("GET", "/api/_a2app/whoami", as("a2a_nonsense"), nil)), "credential_invalid")
		check("an agent's credential manages nothing", codeOf(call("GET", "/api/_a2app/credentials", as(bobToken), nil)), "not_a_manager")

		bob.Active = false
		authApp.store.putAuthRow(tableUsers, bob.ID, bob)
		check("deactivating a person stops their agents", codeOf(call("GET", "/api/_a2app/whoami", as(bobToken), nil)), "principal_inactive")
		bob.Active = true
		authApp.store.putAuthRow(tableUsers, bob.ID, bob)
		check("…and reactivating restores them", statusOf(call("GET", "/api/_a2app/whoami", as(bobToken), nil)), 200)

		authApp.store.putAuthRow(tableSessions, hashSecret("bob-session"), sessionRow{
			Principal: bob.ID, CreatedAt: nowISO(), ExpiresAt: isoOf(time.Now().Add(time.Hour)),
		})
		session := map[string]string{"cookie": "a2app_session_selftest=bob-session", "origin": "http://127.0.0.1:9931"}
		_, sessionWho := call("GET", "/api/_a2app/whoami", session, nil)
		check("a session acts as its person, within their permissions",
			[]any{sessionWho["credentialId"], sessionWho["principal"], sessionWho["scopes"]},
			[]any{"session", "usr_bob", []string{"data:notes:read", "op:review-note"}})
		check("a signed-in change needs the app's own Origin",
			codeOf(call("POST", "/api/collections/notes/records", map[string]string{"cookie": session["cookie"]}, M{"title": "x"})), "forbidden_origin")
		check("a stranger is told to bring a credential",
			codeOf(call("GET", "/api/collections/notes/records", nil, nil)), codeAgentTokenRequired)
		check("…and the app's own page to sign in",
			codeOf(call("GET", "/api/collections/notes/records", map[string]string{"sec-fetch-site": "same-origin"}, nil)), "sign_in_required")

		_, ran := call("POST", "/api/ops/review-note", session, M{"note": getStr(created, "id")})
		fired, _ := ran["result"].(M)
		taskID := toStr(fired["taskId"])
		_, task := call("GET", "/api/_a2app/tasks/"+taskID, as("admin-token"), nil)
		request, _ := task["request"].(M)
		check("a task records who called the runner that queued it", request["principal"], "usr_bob")
		appFired, _ := authApp.trigger("note.review", M{"note": "app"}, "review")
		_, appTask := call("GET", "/api/_a2app/tasks/"+toStr(appFired["taskId"]), as("admin-token"), nil)
		appRequest, _ := appTask["request"].(M)
		check("work the app queues itself records nobody", hasKey(appRequest, "principal") && appRequest["principal"] == nil, true)
		check("a member cannot issue a task's credential",
			codeOf(call("POST", "/api/_a2app/tasks/"+taskID+"/credential", session, nil)), "not_a_manager")
		taskStatus, taskCred := call("POST", "/api/_a2app/tasks/"+taskID+"/credential", as("admin-token"), M{"agentName": "bridge"})
		credential, _ := taskCred["credential"].(M)
		check("the admin credential issues it, for that person, the capability's scopes, and that task",
			[]any{taskStatus, credential["principal"], credential["scopes"], credential["task"]},
			[]any{201, "usr_bob", []string{"data:notes:read"}, taskID})
		taskToken := getStr(taskCred, "token")
		check("…and it works while the task is open", statusOf(call("GET", "/api/_a2app/whoami", as(taskToken), nil)), 200)
		openTask := authApp.store.getTask(taskID)
		openTask["status"] = "completed"
		authApp.store.saveTask(openTask)
		check("…and is dead once the task is over", codeOf(call("GET", "/api/_a2app/whoami", as(taskToken), nil)), "credential_revoked")
		check("…and none is issued for a finished task",
			codeOf(call("POST", "/api/_a2app/tasks/"+taskID+"/credential", as("admin-token"), nil)), codeTaskNotClaimable)

		authApp.store.updateGrant(bobGrant.CredentialID, func(g *Grant) { g.ExpiresAt = isoOf(time.Now().Add(-time.Second)) })
		check("an expired credential says so", codeOf(call("GET", "/api/_a2app/whoami", as(bobToken), nil)), "token_expired")
		aliceGrant := authApp.store.grantByTokenHash(hashSecret(aliceToken))
		check("a credential revokes itself", statusOf(call("DELETE", "/api/_a2app/credentials/"+aliceGrant.CredentialID, as(aliceToken), nil)), 200)
		check("…and is told so after", codeOf(call("GET", "/api/_a2app/whoami", as(aliceToken), nil)), "credential_revoked")
		check("the admin credential cannot be revoked through the API",
			codeOf(call("DELETE", "/api/_a2app/credentials/cred_local", as("admin-token"), nil)), "not_a_manager")
	}

	// 10. Declarations the auth layer depends on are checked at construction,
	//     and a single-user app has one principal and no accounts.
	_, err = NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Modules: []M{{"name": "core"}}, Entities: notes,
		Capabilities: map[string]M{"review": {"scopes": []string{"data:other:read"}}},
	})
	check("a capability's undeclared scope is refused at boot", err != nil && strings.Contains(err.Error(), `capability "review"`), true)
	_, err = NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Modules: []M{{"name": "core"}},
		Entities: map[string]M{"notes": {"module": "core", "ownedBy": "owner", "fields": []M{{"name": "owner", "type": "string"}}}},
	})
	check("ownedBy must name a readOnly string field", err != nil && strings.Contains(err.Error(), "must be a readOnly string field"), true)
	if soloApp, err := NewAdapter(AdapterConfig{
		AppID: "solo", Store: NewStore(nil), Token: "admin-token", Modules: []M{{"name": "core"}}, Entities: notes,
	}); err != nil {
		failures = append(failures, "could not build a single-user adapter: "+err.Error())
	} else {
		status, anonymous, _ := soloApp.dispatch("GET", "/api/_a2app/whoami", nil, nil, nil)
		check("a single-user app reads anonymously as the owner, read-only",
			[]any{status, anonymous["principal"], anonymous["scopes"]}, []any{200, "owner", []string{"data:notes:read"}})
		status, _, _ = soloApp.dispatch("POST", "/api/collections/notes/records", nil, M{"title": "x"}, nil)
		check("…and needs a credential to write", status, 401)
		_, stored, _ := soloApp.dispatch("POST", "/api/collections/notes/records", map[string]string{"x-a2app-token": "admin-token"}, M{"title": "x"}, nil)
		check("…where every record is the owner's", stored["owner"], "owner")
		_, refusal, _ := soloApp.dispatch("GET", "/api/_a2app/session", nil, nil, nil)
		check("…and there are no accounts", refusal["code"], "not_multi_user")
	}

	if len(failures) > 0 {
		fmt.Println("a2app_adapter selftest FAILED:\n  - " + strings.Join(failures, "\n  - "))
		return 1
	}
	fmt.Println("a2app_adapter selftest ok (guard, predicates, fingerprint, referential deletes, filter, sqlite store, " +
		"host and network policy, auth primitives, resolution order and ceiling)")
	return 0
}
