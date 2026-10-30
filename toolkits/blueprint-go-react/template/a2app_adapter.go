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
// device-code sign-in. The adapter-owned state — credentials, accounts, the
// task queue, the event log, approvals, idempotency keys and the audit log —
// lives in the same SQLite file as the records, so a restart loses none of it.
//
// Parity oracle: adapters/adapter-core/src (server.ts, store.ts, describe.ts,
// canon.ts, auth.ts, accounts.ts, credentials.ts, device.ts) and the pure rules
// in adapters/rules/src, so a Go app and a Node app answer identical requests
// identically, verified by the conformance suites. Where JavaScript itself
// decides an answer (how a number prints, what Number("0x1A") is, the order of
// a body's keys), the "JavaScript semantics" section below says so once. HTTP
// wiring lives in `main.go`; this file never touches net/http. An agent evolves
// the app by editing `schema.go`, never this file.
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
	"io"
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
	"unicode/utf16"
	"unicode/utf8"

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
	codeMissingRequired    = "missing_required"
	codeInvalidFilter      = "invalid_filter"
	// The record is still referenced, and a `ref` pointing at it says `restrict`.
	codeRecordReferenced = "record_referenced"
	// Progress or completion on a task whose claim another credential holds
	// (spec/v0_2/auth.md §6.3).
	codeTaskNotHeld = "task_not_held"
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

// toStr is a declared value as text: String(value), except that a missing
// value is "" rather than "null".
func toStr(v any) string {
	if v == nil {
		return ""
	}
	return jsString(v)
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

/* ---------------------------------------------------- JavaScript semantics */
// The reference adapter is JavaScript, and a few of its answers are decided by
// the language rather than by the protocol: what Number("0x1A") is, how a
// number prints, the order Object.keys lists a body's fields in, how two keys
// sort, what JSON.stringify does with Infinity. Each rule is written once here,
// so a Go app answers byte for byte as a Node app does.

// isJSSpace is a character String.prototype.trim removes.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

var jsDecimalRe = regexp.MustCompile(`^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$`)
var jsRadixRe = regexp.MustCompile(`^0([xXoObB])([0-9a-zA-Z]+)$`)

// jsNumber is ECMAScript Number(string): a trimmed decimal literal (Infinity
// included) or an unsigned 0x/0o/0b integer; blank is 0, anything else NaN.
// Go's ParseFloat alone would also take "inf", "NaN" and hex floats.
func jsNumber(s string) float64 {
	t := strings.TrimFunc(s, isJSSpace)
	if t == "" {
		return 0
	}
	if m := jsRadixRe.FindStringSubmatch(t); m != nil {
		base := map[string]int{"x": 16, "o": 8, "b": 2}[strings.ToLower(m[1])]
		n, ok := new(big.Int).SetString(m[2], base)
		if !ok {
			return math.NaN()
		}
		f, _ := new(big.Float).SetInt(n).Float64()
		return f
	}
	if !jsDecimalRe.MatchString(t) {
		return math.NaN()
	}
	// Out of range is ±Infinity in JavaScript too; ParseFloat says so with ErrRange.
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

// jsNumberString is ECMAScript Number.prototype.toString: the shortest digits
// that round-trip, in fixed notation from 1e-7 to 1e21 and exponent notation
// outside it — also RFC 8785's number form.
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// "d.ddde±x" gives the shortest round-trip digits and the exponent.
	mantissa, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	e, _ := strconv.Atoi(exp)
	k, n := len(digits), e+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	head := digits[:1]
	if k > 1 {
		head += "." + digits[1:]
	}
	return sign + head + "e" + expSign + strconv.Itoa(abs(n-1))
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// jsString is ECMAScript String(value) for a JSON value: arrays join their
// elements with "," (null as empty), objects are "[object Object]".
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(t)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case M:
		return "[object Object]"
	}
	if items := toAnyList(v); items != nil {
		parts := make([]string, len(items))
		for i, item := range items {
			if item != nil {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	}
	return fmt.Sprint(v)
}

// jsCompare orders two strings as JavaScript does, by UTF-16 code unit — which
// differs from Go's byte order only past U+FFFF.
func jsCompare(a, b string) int {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			if x[i] < y[i] {
				return -1
			}
			return 1
		}
	}
	return len(x) - len(y)
}

// isArrayIndex is a key JavaScript treats as an array index ("0", "17").
func isArrayIndex(key string) bool {
	if key == "0" {
		return true
	}
	if key == "" || key[0] < '1' || key[0] > '9' {
		return false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return err == nil && n < math.MaxUint32 && strconv.FormatUint(n, 10) == key
}

// jsKeyOrder is the order Object.keys lists an object's keys in, given the
// order they were written: array-index keys first, ascending, then the rest as
// written.
func jsKeyOrder(written []string) []string {
	indices, names := []string{}, []string{}
	for _, k := range written {
		if isArrayIndex(k) {
			indices = append(indices, k)
		} else {
			names = append(names, k)
		}
	}
	sort.SliceStable(indices, func(i, j int) bool {
		x, _ := strconv.ParseUint(indices[i], 10, 64)
		y, _ := strconv.ParseUint(indices[j], 10, 64)
		return x < y
	})
	return append(indices, names...)
}

// errURIMalformed is decodeURIComponent's refusal. The reference lets it
// escape the router, so the request answers 500 adapter_error, and so does
// this port.
var errURIMalformed = errors.New("URI malformed")

// decodeURIComponent decodes every %XX escape; a malformed escape, or bytes
// that are not UTF-8, refuse.
func decodeURIComponent(s string) (string, error) {
	if !strings.Contains(s, "%") {
		return s, nil
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			out = append(out, s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", errURIMalformed
		}
		b, err := hex.DecodeString(s[i+1 : i+3])
		if err != nil {
			return "", errURIMalformed
		}
		out = append(out, b[0])
		i += 2
	}
	if !utf8.Valid(out) {
		return "", errURIMalformed
	}
	return string(out), nil
}

// mustDecode is a path segment, decoded; a malformed one panics with
// errURIMalformed, which Handle answers as adapter_error, as the reference's
// thrown URIError is.
func mustDecode(s string) string {
	decoded, err := decodeURIComponent(s)
	if err != nil {
		panic(err)
	}
	return decoded
}

// parseQuery is a query string as URLSearchParams reads it: "&"-separated
// pairs, "+" is a space, escapes decoded leniently (a malformed one stays as
// written). A repeated name keeps its last value, as the reference's
// `query[k] = v` does.
func parseQuery(raw string) map[string]string {
	out := map[string]string{}
	decode := func(s string) string {
		s = strings.ReplaceAll(s, "+", " ")
		buf := make([]byte, 0, len(s))
		for i := 0; i < len(s); i++ {
			if s[i] == '%' && i+2 < len(s) {
				if b, err := hex.DecodeString(s[i+1 : i+3]); err == nil {
					buf = append(buf, b[0])
					i += 2
					continue
				}
			}
			buf = append(buf, s[i])
		}
		return strings.ToValidUTF8(string(buf), "�")
	}
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		name, value, _ := strings.Cut(pair, "=")
		out[decode(name)] = decode(value)
	}
	return out
}

// jsonSafe is a value as JSON.stringify writes it: NaN and ±Infinity become
// null (JSON has neither), at any depth.
func jsonSafe(v any) any {
	switch t := v.(type) {
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case M:
		out := make(M, len(t))
		for k, x := range t {
			out[k] = jsonSafe(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = jsonSafe(x)
		}
		return out
	case []M:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = jsonSafe(x)
		}
		return out
	}
	return v
}

// marshalJSON is JSON with JSON.stringify's handling of non-finite numbers,
// `<` and `&` left as themselves, and keys sorted at every depth.
func marshalJSON(value any) ([]byte, error) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(jsonSafe(value)); err != nil {
		return nil, err
	}
	return []byte(strings.TrimSuffix(buf.String(), "\n")), nil
}

// canonicalize is RFC 8785 (JCS) JSON for the values A2App arguments are made
// of: keys sorted by UTF-16 code unit, numbers in their ECMAScript form,
// minimal string escapes. Parity oracle: adapter-core canon.ts — two adapters
// that follow it compute the same approval key for the same call. A
// non-finite number cannot be canonicalized, and panics, as it throws there.
func canonicalize(v any) string {
	var b strings.Builder
	var encode func(v any)
	encodeString := func(s string) {
		b.WriteByte('"')
		for _, r := range s {
			switch r {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if r < 0x20 {
					fmt.Fprintf(&b, `\u%04x`, r)
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
	}
	encode = func(v any) {
		switch t := v.(type) {
		case nil:
			b.WriteString("null")
		case bool:
			b.WriteString(jsString(t))
		case float64:
			if math.IsNaN(t) || math.IsInf(t, 0) {
				panic(errors.New("cannot canonicalize a non-finite number"))
			}
			b.WriteString(jsNumberString(t))
		case int, int64:
			b.WriteString(jsString(t))
		case string:
			encodeString(t)
		case M:
			keys := make([]string, 0, len(t))
			for k := range t {
				keys = append(keys, k)
			}
			sort.Slice(keys, func(i, j int) bool { return jsCompare(keys[i], keys[j]) < 0 })
			b.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					b.WriteByte(',')
				}
				encodeString(k)
				b.WriteByte(':')
				encode(t[k])
			}
			b.WriteByte('}')
		default:
			items := toAnyList(v)
			if items == nil {
				panic(fmt.Errorf("cannot canonicalize value of type %T", v))
			}
			b.WriteByte('[')
			for i, item := range items {
				if i > 0 {
					b.WriteByte(',')
				}
				encode(item)
			}
			b.WriteByte(']')
		}
	}
	encode(v)
	return b.String()
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// approvalKey is the content address of one exact operation call: sha256 hex
// of the JCS form of {"operation", "args"} (args default {}). Approving one
// call approves no argument variant.
func approvalKey(operation string, args any) string {
	if args == nil {
		args = M{}
	}
	return sha256Hex(canonicalize(M{"operation": operation, "args": args}))
}

/* -- request bodies -- */

// ParseBody reads a request body as the reference's transport does with
// JSON.parse: nil for a blank body, the JSON value for valid JSON (numbers as
// float64, an overflowing one as ±Infinity), and {"__unparsed__": text} for
// anything else, so the guard refuses it as an unknown field instead of the
// request failing. keys is a top-level object's keys in the order they were
// written, which is the order violations are reported in.
func ParseBody(raw []byte) (body any, keys []string) {
	text := string(raw)
	if strings.TrimFunc(text, isJSSpace) == "" {
		return nil, nil
	}
	unparsed := M{"__unparsed__": text}
	dec := json.NewDecoder(strings.NewReader(text))
	// Numbers stay text until fromJSONNumbers reads them, so one too large for
	// a float64 is Infinity, as JSON.parse makes it, rather than a parse error.
	dec.UseNumber()
	var value any
	if dec.Decode(&value) != nil {
		return unparsed, nil
	}
	if _, err := dec.Token(); err != io.EOF {
		return unparsed, nil // trailing content: JSON.parse refuses it
	}
	value = fromJSONNumbers(value)
	if _, isObject := value.(M); isObject {
		keys = writtenKeys(text)
	}
	return value, keys
}

func fromJSONNumbers(v any) any {
	switch t := v.(type) {
	case json.Number:
		f, _ := strconv.ParseFloat(string(t), 64) // out of range is ±Inf, as JSON.parse has it
		return f
	case M:
		for k, x := range t {
			t[k] = fromJSONNumbers(x)
		}
	case []any:
		for i, x := range t {
			t[i] = fromJSONNumbers(x)
		}
	}
	return v
}

// writtenKeys is a JSON object's keys in the order they first appear.
func writtenKeys(text string) []string {
	dec := json.NewDecoder(strings.NewReader(text))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	keys, seen := []string{}, map[string]bool{}
	for dec.More() {
		t, err := dec.Token()
		key, isKey := t.(string)
		if err != nil || !isKey {
			break
		}
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			break
		}
	}
	return keys
}

// bodyView is a request body as the reference's handlers read it — through
// `req.body ?? {}` and Object.keys. An object's keys are its own, in
// JavaScript's order; an array's and a string's are their indices; any other
// value, and no body at all, has none.
type bodyView struct {
	// the parsed value (nil when there was none, or it was null)
	raw    any
	keys   []string
	fields M
}

func viewBody(body any, written []string) bodyView {
	view := bodyView{raw: body, keys: []string{}, fields: M{}}
	switch t := body.(type) {
	case M:
		view.fields = t
		if len(written) != len(t) {
			written = make([]string, 0, len(t))
			for k := range t {
				written = append(written, k)
			}
			sort.Strings(written)
		}
		view.keys = jsKeyOrder(written)
	case string:
		for i, unit := range utf16.Encode([]rune(t)) {
			view.keys = append(view.keys, strconv.Itoa(i))
			view.fields[strconv.Itoa(i)] = string(utf16.Decode([]uint16{unit}))
		}
	default:
		for i, item := range toAnyList(body) {
			view.keys = append(view.keys, strconv.Itoa(i))
			view.fields[strconv.Itoa(i)] = item
		}
	}
	return view
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

func isNumeric(v any) bool {
	switch v.(type) {
	case float64, int, int64:
		return true
	}
	return false
}

// validate checks a RAW body against normalized fields and returns every
// violation, in the order of `keys` (the body's own, as Object.keys lists
// them). `allow` names extra keys accepted without being fields;
// `requireRequired` is set on a create only, where a required field left out
// is missing. Parity oracle: `validate` in @a2app/rules.
func validate(fields []M, keys []string, body M, allow map[string]bool, requireRequired bool) []M {
	byName := map[string]M{}
	var writable []string
	for _, f := range fields {
		byName[getStr(f, "name")] = f
		if !getBool(f, "readOnly") {
			writable = append(writable, getStr(f, "name"))
		}
	}
	// An operation may declare no parameters at all, and "one of: " with nothing
	// after it reads as a truncated message rather than as the answer it is.
	accepted := "nothing — no writable fields are declared"
	if len(writable) > 0 {
		accepted = "one of: " + strings.Join(writable, ", ")
	}

	out := []M{}
	for _, key := range keys {
		if allow[key] {
			continue
		}
		value := body[key]
		f, known := byName[key]
		if !known {
			out = append(out, violation(codeUnknownField, key, accepted, value))
			continue
		}
		if getBool(f, "readOnly") {
			out = append(out, violation(codeReadOnlyField, key, "not writable (server-managed)", value))
			continue
		}
		// Blank clears a field — legitimate only when the field is not required.
		if isBlank(value) {
			if getBool(f, "required") {
				out = append(out, violation(codeMissingRequired, key, "a non-blank value (required field)", value))
			}
			continue
		}
		if v := fieldViolation(f, key, value); v != nil {
			out = append(out, v)
		}
	}
	if requireRequired {
		for _, f := range fields {
			if !getBool(f, "required") || getBool(f, "readOnly") || hasKey(body, getStr(f, "name")) {
				continue
			}
			out = append(out, violation(codeMissingRequired, getStr(f, "name"), "a non-blank value (required field)", nil))
		}
	}
	return out
}

// fieldViolation is what is wrong with one non-blank value for its field, or
// nil. The first rule that fails is the one reported.
func fieldViolation(f M, key string, value any) M {
	ftype := getStr(f, "type")
	text, isString := value.(string)
	_, isBool := value.(bool)
	allowed := valuesOf(f)
	switch {
	case ftype == "datetime" && !looksLikeDate(value):
		return violation(codeInvalidDate, key, "an ISO 8601 date", value)
	case getBool(f, "dayKey") && !isDayKeyValue(value):
		return violation(codeInvalidDaykey, key, `a day key "YYYY-MM-DD"`, value)
	case ftype == "string" && !isString:
		return violation(codeInvalidString, key, "text", value)
	case ftype == "string" && isNumeric(f["max"]) && float64(jsLength(text)) > numberOf(f["max"]):
		// `max` is published in describe, so a client plans against it; length is
		// its documented meaning on a string field, counted as JavaScript does.
		return violation(codeInvalidString, key, "text of at most "+toStr(f["max"])+" characters", value)
	case ftype == "number" && !isNumeric(value) &&
		(!isString || strings.TrimFunc(text, isJSSpace) == "" || math.IsNaN(jsNumber(text))):
		return violation(codeInvalidNumber, key, "a number", value)
	case ftype == "boolean" && !isBool && value != "true" && value != "false":
		return violation(codeInvalidBoolean, key, "true or false", value)
	case ftype == "enum" && len(allowed) > 0 && !contains(allowed, jsString(value)):
		return violation(codeInvalidEnum, key, "one of: "+strings.Join(allowed, " | "), value)
	case ftype == "list<enum>" && len(allowed) > 0:
		// The wire form of a list is an array: wrapping a bare scalar would hide a
		// client bug and make the stored shape depend on how many were sent.
		items, isList := value.([]any)
		if !isList {
			return violation(codeInvalidEnum, key, "an array of: "+strings.Join(allowed, " | "), value)
		}
		for _, item := range items {
			if !contains(allowed, jsString(item)) {
				return violation(codeInvalidEnum, key, "each of: "+strings.Join(allowed, " | "), value)
			}
		}
	}
	return nil
}

// numberOf is a declared number (int in schema.go, float64 from JSON).
func numberOf(v any) float64 {
	f, _ := asFloat(v)
	return f
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
// failed to land? A write-only field is never read back, so it is exempt.
func divergences(fields []M, keys []string, body M, read func(string) any) []M {
	byName := map[string]M{}
	for _, f := range fields {
		byName[getStr(f, "name")] = f
	}

	out := []M{}
	for _, key := range keys {
		requested := body[key]
		f, known := byName[key]
		if !known || getBool(f, "readOnly") || getBool(f, "writeOnly") {
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
	if isNumeric(f["max"]) {
		parts = append(parts, "max="+toStr(f["max"]))
	}
	if getStr(f, "entity") != "" {
		parts = append(parts, "entity="+getStr(f, "entity"))
	}
	if values := valuesOf(f); len(values) > 0 {
		sorted := append([]string(nil), values...)
		sort.Slice(sorted, func(i, j int) bool { return jsCompare(sorted[i], sorted[j]) < 0 })
		parts = append(parts, "values="+strings.Join(sorted, "|"))
	}
	return strings.Join(parts, ":")
}

// stableJSON is JSON with keys sorted at every depth and no spaces, so
// declaration order cannot move a hash, written as JSON.stringify would (see
// marshalJSON). Every reply body is written with it too.
func stableJSON(value any) string {
	data, err := marshalJSON(value)
	if err != nil {
		return ""
	}
	return string(data)
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
	parts := []string{head, "mod=" + getStr(o, "module")}
	if getStr(o, "entity") != "" {
		parts = append(parts, "on="+getStr(o, "entity"))
	}
	if params, ok := o["params"].(M); ok && len(params) > 0 {
		parts = append(parts, "params="+stableJSON(params))
	}
	if when, ok := o["appliesWhen"].(M); ok {
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
	// djb2-xor over UTF-16 code units (JavaScript's charCodeAt), masked to 32
	// bits — uint32 arithmetic wraps to exactly that mask.
	var h uint32 = 5381
	for _, unit := range utf16.Encode([]rune(joined)) {
		h = (h * 33) ^ uint32(unit)
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
		if t, ok := value.(string); ok {
			if n := jsNumber(t); !math.IsNaN(n) && !math.IsInf(n, 0) {
				return n
			}
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
	if kind := reflect.ValueOf(v).Kind(); kind == reflect.Map || kind == reflect.Slice {
		return stableJSON(v)
	}
	return jsString(v)
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
		subject := getStr(inner, "field")
		if hasKey(inner, "all") || hasKey(inner, "any") || hasKey(inner, "not") {
			subject = "the record"
		}
		return "the condition on " + subject + " is not met"
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
		retry := int(math.Ceil(float64(60000-(now-w.start)) / 1000))
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
	// the 127.0.0.1 port the agent waits on, when it is on the person's computer
	LoopbackPort *int `json:"loopbackPort"`
	// SHA-256 of the confirmation code issued at approval
	ConfirmationHash string `json:"confirmationHash"`
	ConfirmAttempts  int    `json:"confirmAttempts"`
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
		current := toStr(record[field])
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

// coerce is a guarded raw value in its stored form: a number or boolean sent
// as text becomes one, read as JavaScript reads it ("0x1A" is 26, "1e3" is
// 1000). "Infinity" passes the guard there too, and is stored as JSON can hold
// it: null.
func coerce(field M, value any) any {
	if value == nil || value == "" {
		return value
	}
	if s, ok := value.(string); ok {
		switch getStr(field, "type") {
		case "number":
			return jsNumber(s)
		case "boolean":
			return s == "true"
		}
	}
	return value
}

// Store is the record store plus every piece of adapter-owned state: the task
// queue, the event log, approvals, idempotency keys, the audit log,
// credentials and the auth tables. All of it lives in one SQLite database —
// NewSqliteStore opens the app's file inside the toolkit's lifecycle dataDir,
// NewStore a private in-memory one for tests and tooling — so both variants
// run the same code. Parity oracle: adapter-core store.ts (FileStateStore).
//
// Records are JSON rows in one table keyed (entity, id): the schema stays
// declarative and additive (a new field simply appears in the JSON) while the
// DATABASE is a real on-disk file — which is what backup/restore/promote
// protect. WAL keeps a reader and a writer from blocking each other.
//
// Everything the adapter keeps survives a restart, because a restart is exactly
// when it is needed: a retried POST arrives with its idempotency key, an agent
// polls with the event cursor it saved, a person approves the key they were
// shown, and a task credential names a task that must still be there (a task
// id that restarted from 1 would hand an old credential a new task). Adapter
// state is never a record: the records API cannot serve it.
//
// Writes are durable when the call returns — there is no separate persist()
// step. A record read from the store is a COPY: mutate it, then putRecord() it
// back, or the change never happened.
//
// A database error is not an answer the store can give: it panics with a
// storeFailure, as the reference's store throws. The request then answers
// 500 adapter_error — or operation_failed inside an operation runner — rather
// than reporting a write that never happened.
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
	// connection guarded by one lock keeps SQLite correct without a pool, and
	// makes each multi-statement change one step.
	mu sync.Mutex
	db *sql.DB
	// The app every task and event names (set by NewAdapter).
	app string
	// The event types this app may emit, set by NewAdapter from the app's
	// declarations. Empty means none were declared.
	eventTypes map[string]bool
	// The clock timestamps and expiries are read from.
	now func() time.Time
}

// How long adapter state is kept (adapter-core store.ts).
const (
	// An idempotency key answers a retry for at least this long.
	idempotencyTTL = 24 * time.Hour
	// An approval key must be used this soon after it was issued.
	approvalTTL = 10 * time.Minute
	// The event log and the audit log are rings of this many rows: the oldest
	// fall off, and event sequence numbers stay monotonic across the prune, so
	// a saved cursor keeps working.
	eventRetention = 5000
	auditRetention = 5000
)

// storeFailure is a database error the store cannot answer around.
type storeFailure struct{ err error }

func (f *storeFailure) Error() string { return "the database failed: " + f.err.Error() }

// must raises a database error as a storeFailure.
func must(err error) {
	if err != nil {
		panic(&storeFailure{err})
	}
}

// queryer is what both the database and a transaction answer, so one helper
// serves inside a transaction and outside one.
type queryer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

var storeSchema = []string{
	"CREATE TABLE IF NOT EXISTS records (entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (entity, id))",
	// Idempotency keys, by scope (an entity, `entity#id` for an update,
	// `op:<name>`) and key: the record (or operation) they produced, and when.
	"CREATE TABLE IF NOT EXISTS idem (entity TEXT NOT NULL, key TEXT NOT NULL, rec_id TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (entity, key))",
	// Credentials, found by the hash of their token — never the token.
	"CREATE TABLE IF NOT EXISTS grants (credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, data TEXT NOT NULL)",
	"CREATE INDEX IF NOT EXISTS grants_by_token ON grants (token_hash)",
	// The auth tables (users, sessions, invites, devices).
	"CREATE TABLE IF NOT EXISTS auth (tbl TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, key))",
	// Approval keys issued and not yet used, with when they stop working (unix ms).
	"CREATE TABLE IF NOT EXISTS approvals (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
	// One occurrence makes one task: occurrence key -> task id.
	"CREATE TABLE IF NOT EXISTS dedup (key TEXT PRIMARY KEY, task_id TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)",
	// Counters that must outlive the rows they number (the event sequence).
	"CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
}

func openStore(dsn string, seed map[string][]M) (*Store, error) {
	if seed == nil {
		seed = map[string][]M{}
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection, guarded by the store mutex — SQLite is happiest that way,
	// the interface stays a plain synchronous call, and an in-memory database
	// lives exactly as long as its one connection.
	db.SetMaxOpenConns(1)
	// WAL keeps a reader and a writer from blocking each other. The pragma
	// answers with a row (the new mode), so it goes through QueryRow — some
	// database/sql drivers refuse a row-returning statement in Exec.
	var journalMode string
	if err := db.QueryRow("PRAGMA journal_mode=WAL").Scan(&journalMode); err != nil {
		db.Close()
		return nil, err
	}
	for _, stmt := range storeSchema {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, err
		}
	}
	// Idempotency keys did not expire before 0.2, so an older database's table
	// has no time column: add it, dating the keys it holds from now.
	var dated int
	if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('idem') WHERE name = 'at'").Scan(&dated); err != nil {
		db.Close()
		return nil, err
	}
	if dated == 0 {
		for _, stmt := range []string{"ALTER TABLE idem ADD COLUMN at INTEGER NOT NULL DEFAULT 0", "UPDATE idem SET at = ?"} {
			if _, err := db.Exec(stmt, time.Now().UnixMilli()); err != nil {
				db.Close()
				return nil, err
			}
		}
	}
	return &Store{storeState: &storeState{
		Seed: seed, WantsSeed: true, db: db, eventTypes: map[string]bool{}, now: time.Now,
	}}, nil
}

// NewStore is a private in-memory store — always empty, so it always takes
// the seed.
func NewStore(seed map[string][]M) *Store {
	s, err := openStore(":memory:", seed)
	must(err)
	return s
}

// NewSqliteStore opens (or creates) the live database file.
func NewSqliteStore(path string, seed map[string][]M) (*Store, error) {
	full, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return nil, err
	}
	_, statErr := os.Stat(full)
	fresh := os.IsNotExist(statErr)
	s, err := openStore(full, seed)
	if err != nil {
		return nil, err
	}
	s.WantsSeed = fresh
	return s, nil
}

// Close releases the database (the last connection closing checkpoints the
// WAL into the main file).
func (s *Store) Close() error { return s.db.Close() }

// forCaller is this store as handed to an operation runner called by
// `principal`: the same records and queue, with the caller bound to trigger.
func (s *Store) forCaller(principal string) *Store {
	return &Store{storeState: s.storeState, caller: principal}
}

// transaction runs change as one step under the store lock.
func (s *Store) transaction(change func(tx *sql.Tx)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	must(err)
	defer tx.Rollback() // a no-op once committed; undoes a change that panicked
	change(tx)
	must(tx.Commit())
}

// putJSON writes value as one row's JSON, by an upsert statement whose last
// argument is the data.
func putJSON(q queryer, stmt string, value any, args ...any) {
	data, err := marshalJSON(value)
	must(err)
	_, err = q.Exec(stmt, append(args, string(data))...)
	must(err)
}

// rowJSON decodes one row's JSON into out; false when there is no such row.
func rowJSON(q queryer, out any, query string, args ...any) bool {
	var data string
	err := q.QueryRow(query, args...).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	must(err)
	return json.Unmarshal([]byte(data), out) == nil
}

// eachJSON decodes every row a query returns, in order, skipping one that is
// not JSON of out's shape.
func eachJSON[T any](q queryer, query string, args ...any) []T {
	rows, err := q.Query(query, args...)
	must(err)
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var data string
		must(rows.Scan(&data))
		var row T
		if json.Unmarshal([]byte(data), &row) == nil {
			out = append(out, row)
		}
	}
	must(rows.Err())
	return out
}

/* records ------------------------------------------------------------- */

// allRecords is every record of one entity, in the table's own order (by id).
func (s *Store) allRecords(entity string) []M {
	s.mu.Lock()
	defer s.mu.Unlock()
	return eachJSON[M](s.db, "SELECT data FROM records WHERE entity = ?", entity)
}

// compareValues is the reference binding's sort comparison: a value equal to
// the other compares equal, a missing one sorts first, and the rest compare
// as text.
func compareValues(a, b any) int {
	switch {
	case a == nil && b == nil, sameScalar(a, b):
		return 0
	case a == nil:
		return -1
	case b == nil:
		return 1
	case jsCompare(jsString(a), jsString(b)) < 0:
		return -1
	}
	return 1
}

// sameScalar is JavaScript's === for the scalars a record holds.
func sameScalar(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	}
	x, aNumber := asFloat(a)
	y, bNumber := asFloat(b)
	return aNumber && bNumber && x == y
}

// jsSlice is the index range Array.prototype.slice(start, end) selects from n
// items — NaN as 0, fractions truncated, negatives counted from the end — so a
// page asked for as perPage=0, perPage=abc or page=0 answers what it answers on
// the reference.
func jsSlice(n int, start, end float64) (int, int) {
	index := func(x float64) int {
		if math.IsNaN(x) {
			return 0
		}
		x = math.Trunc(x)
		if x < 0 {
			return int(math.Max(float64(n)+x, 0))
		}
		return int(math.Min(x, float64(n)))
	}
	from, to := index(start), index(end)
	if to < from {
		to = from
	}
	return from, to
}

// listRecords filters, sorts and pages one entity as the reference binding
// does. `where` (field -> value) is the adapter's own constraint — a member
// sees only the records it owns — so it is applied first, before anything is
// counted or paged. `perPage` defaults to every record and `page` to 1; the
// reply echoes both as given.
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
		key, direction := sortKey, 1
		if strings.HasPrefix(sortKey, "-") {
			key, direction = sortKey[1:], -1
		}
		sort.SliceStable(items, func(i, j int) bool {
			return compareValues(items[i][key], items[j][key])*direction < 0
		})
	}
	total := len(items)
	perPage, ok := asFloat(query["perPage"])
	if !ok {
		perPage = float64(total)
	}
	page, ok := asFloat(query["page"])
	if !ok {
		page = 1
	}
	start := (page - 1) * perPage
	from, to := jsSlice(total, start, start+perPage)
	return M{"items": items[from:to], "page": page, "perPage": perPage, "totalItems": total}, nil
}

func (s *Store) getRecord(entity, recID string) M {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rec M
	if !rowJSON(s.db, &rec, "SELECT data FROM records WHERE entity = ? AND id = ?", entity, recID) {
		return nil
	}
	return rec
}

func (s *Store) putRecord(entity string, rec M) {
	s.mu.Lock()
	defer s.mu.Unlock()
	putJSON(s.db, "INSERT INTO records (entity, id, data) VALUES (?, ?, ?) "+
		"ON CONFLICT (entity, id) DO UPDATE SET data = excluded.data", rec, entity, getStr(rec, "id"))
}

func (s *Store) deleteRecord(entity, recID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec("DELETE FROM records WHERE entity = ? AND id = ?", entity, recID)
	must(err)
	n, err := res.RowsAffected()
	must(err)
	return n > 0
}

/* grants ---------------------------------------------------------------- */
// Credentials, keyed by credentialId and found by the hash of their token. A
// row without a token hash is a plaintext grant from 0.1, which is not loaded:
// the host seeds its own again at boot, hashed.

func usableGrant(g Grant, found bool) *Grant {
	if !found || g.TokenHash == "" {
		return nil
	}
	return &g
}

// grantLocked is one grant by id; the caller holds s.mu.
func (s *Store) grantLocked(credentialID string) *Grant {
	var g Grant
	return usableGrant(g, rowJSON(s.db, &g, "SELECT data FROM grants WHERE credential_id = ?", credentialID))
}

// putGrantLocked writes one grant; the caller holds s.mu.
func (s *Store) putGrantLocked(g Grant) {
	putJSON(s.db, "INSERT INTO grants (credential_id, token_hash, data) VALUES (?, ?, ?) "+
		"ON CONFLICT (credential_id) DO UPDATE SET token_hash = excluded.token_hash, data = excluded.data",
		g, g.CredentialID, g.TokenHash)
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
	var g Grant
	return usableGrant(g, rowJSON(s.db, &g, "SELECT data FROM grants WHERE token_hash = ?", tokenHash))
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
	_, err := s.db.Exec("DELETE FROM grants WHERE credential_id = ?", credentialID)
	must(err)
}

// listGrants is every grant, in the order they were first stored.
func (s *Store) listGrants() []Grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Grant{}
	for _, g := range eachJSON[Grant](s.db, "SELECT data FROM grants ORDER BY rowid") {
		if g.TokenHash != "" {
			out = append(out, g)
		}
	}
	return out
}

/* auth tables ------------------------------------------------------------ */
// users · sessions · invites · devices, each row JSON under its key.

// authRow decodes one row into out; false when there is none.
func (s *Store) authRow(table, key string, out any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return rowJSON(s.db, out, "SELECT data FROM auth WHERE tbl = ? AND key = ?", table, key)
}

func (s *Store) putAuthRow(table, key string, row any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	putJSON(s.db, "INSERT INTO auth (tbl, key, data) VALUES (?, ?, ?) "+
		"ON CONFLICT (tbl, key) DO UPDATE SET data = excluded.data", row, table, key)
}

func (s *Store) deleteAuthRow(table, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec("DELETE FROM auth WHERE tbl = ? AND key = ?", table, key)
	must(err)
}

// keyedRow is one auth-table row with the key it is stored under.
type keyedRow[T any] struct {
	key string
	row T
}

// authRows is every row of one auth table, decoded, in insertion order.
func authRows[T any](s *Store, table string) []keyedRow[T] {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query("SELECT key, data FROM auth WHERE tbl = ? ORDER BY rowid", table)
	must(err)
	defer rows.Close()
	out := []keyedRow[T]{}
	for rows.Next() {
		var key, data string
		must(rows.Scan(&key, &data))
		var row T
		if json.Unmarshal([]byte(data), &row) == nil {
			out = append(out, keyedRow[T]{key, row})
		}
	}
	must(rows.Err())
	return out
}

/* idempotency / approvals ------------------------------------------------ */

// idempotencyGet is what an idempotency key already produced in its scope,
// while it is less than idempotencyTTL old.
func (s *Store) idempotencyGet(scope, key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var produced string
	var at int64
	err := s.db.QueryRow("SELECT rec_id, at FROM idem WHERE entity = ? AND key = ?", scope, key).Scan(&produced, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false
	}
	must(err)
	if s.now().UnixMilli()-at > idempotencyTTL.Milliseconds() {
		_, err := s.db.Exec("DELETE FROM idem WHERE entity = ? AND key = ?", scope, key)
		must(err)
		return "", false
	}
	return produced, true
}

func (s *Store) idempotencyPut(scope, key, produced string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec("INSERT INTO idem (entity, key, rec_id, at) VALUES (?, ?, ?, ?) "+
		"ON CONFLICT (entity, key) DO UPDATE SET rec_id = excluded.rec_id, at = excluded.at",
		scope, key, produced, s.now().UnixMilli())
	must(err)
}

// approvalIssue records an approval key, usable for approvalTTL.
func (s *Store) approvalIssue(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec("INSERT INTO approvals (key, expires_at) VALUES (?, ?) "+
		"ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at",
		key, s.now().Add(approvalTTL).UnixMilli())
	must(err)
}

// approvalConsume uses up an approval key: true when it was issued and has
// not expired. Single use either way.
func (s *Store) approvalConsume(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	var expiresAt int64
	err := s.db.QueryRow("SELECT expires_at FROM approvals WHERE key = ?", key).Scan(&expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	must(err)
	_, err = s.db.Exec("DELETE FROM approvals WHERE key = ?", key)
	must(err)
	return expiresAt >= s.now().UnixMilli()
}

/* events ---------------------------------------------------------------- */

// Event is one entry in the app's event log. Seq orders it and is the cursor
// an agent reads from; it is not on the wire.
type Event struct {
	Seq       int64  `json:"seq"`
	ID        string `json:"id"`
	App       string `json:"app"`
	Type      string `json:"type"`
	Payload   M      `json:"payload"`
	CreatedAt string `json:"createdAt"`
}

func (s *Store) appendEvent(etype string, payload M) Event {
	var ev Event
	s.transaction(func(tx *sql.Tx) {
		var seq int64
		if err := tx.QueryRow("SELECT value FROM counters WHERE name = 'events'").Scan(&seq); !errors.Is(err, sql.ErrNoRows) {
			must(err)
		}
		seq++
		ev = Event{
			Seq: seq, ID: newID("evt"), App: s.app, Type: etype,
			Payload: jsonSafe(payload).(M), CreatedAt: isoOf(s.now()),
		}
		putJSON(tx, "INSERT INTO events (seq, data) VALUES (?, ?)", ev, seq)
		_, err := tx.Exec("INSERT INTO counters (name, value) VALUES ('events', ?) "+
			"ON CONFLICT (name) DO UPDATE SET value = excluded.value", seq)
		must(err)
		_, err = tx.Exec("DELETE FROM events WHERE seq <= ?", seq-eventRetention)
		must(err)
	})
	return ev
}

// eventsSince is every retained event after a cursor, and the cursor to read
// from next. A cursor that is not a number reads from the beginning
// (`Number(cursor) || 0`, as the reference has it).
func (s *Store) eventsSince(cursor string) ([]Event, string) {
	from := 0.0
	if n := jsNumber(cursor); cursor != "" && !math.IsNaN(n) {
		from = n
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	events := eachJSON[Event](s.db, "SELECT data FROM events WHERE seq > ? ORDER BY seq", from)
	if len(events) > 0 {
		return events, strconv.FormatInt(events[len(events)-1].Seq, 10)
	}
	return events, jsNumberString(from)
}

/* tasks ------------------------------------------------------------------ */

// Task is one unit of work on the app's queue (A2APP-SPEC 6), as stored.
type Task struct {
	ID       string       `json:"id"`
	App      string       `json:"app"`
	Event    string       `json:"event"`
	Status   string       `json:"status"`
	Request  TaskRequest  `json:"request"`
	Claim    *TaskClaim   `json:"claim"`
	Progress TaskProgress `json:"progress"`
	Result   any          `json:"result"`
	Reason   *string      `json:"reason"`
	Ask      any          `json:"ask"`
	// times, and how often the task has been handed out — not on the wire
	CreatedAt  string  `json:"createdAt"`
	UpdatedAt  string  `json:"updatedAt"`
	DedupKey   *string `json:"dedupKey"`
	Deliveries int     `json:"deliveries"`
}

type TaskRequest struct {
	Capability string `json:"capability"`
	Payload    M      `json:"payload"`
	// who queued it (spec/v0_2/auth.md §6.1); nil for work the app queued on
	// its own, which runs as the owner
	Principal *string `json:"principal"`
}

type TaskClaim struct {
	CredentialID string `json:"credentialId"`
	Principal    string `json:"principal"`
	ClaimedAt    string `json:"claimedAt"`
}

type TaskProgress struct {
	Step    *string  `json:"step"`
	Percent *float64 `json:"percent"`
}

func readTask(q queryer, id string) *Task {
	var t Task
	if !rowJSON(q, &t, "SELECT data FROM tasks WHERE id = ?", id) {
		return nil
	}
	return &t
}

func writeTask(q queryer, t Task) {
	putJSON(q, "INSERT INTO tasks (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data", t, t.ID)
}

// enqueueTask queues one task, unless dedupKey already made one that is still
// open: then that task is the answer. Once it is completed, failed or
// canceled, asking again is a new request, and the key moves to the new task —
// handing back the finished one would leave the person no way to ask again.
// `principal` is who asked for the work (spec/v0_2/auth.md §6.1); "" for work
// the app queues on its own.
func (s *Store) enqueueTask(event, capability string, payload M, principal, dedupKey string) Task {
	var task Task
	s.transaction(func(tx *sql.Tx) {
		if dedupKey != "" {
			var existing string
			err := tx.QueryRow("SELECT task_id FROM dedup WHERE key = ?", dedupKey).Scan(&existing)
			if err == nil {
				if t := readTask(tx, existing); t != nil && !terminalTask[t.Status] {
					task = *t
					return
				}
			} else if !errors.Is(err, sql.ErrNoRows) {
				must(err)
			}
		}
		created := isoOf(s.now())
		zero := 0.0
		task = Task{
			ID: newID("tsk"), App: s.app, Event: event, Status: "submitted",
			Request:   TaskRequest{Capability: capability, Payload: jsonSafe(payload).(M)},
			Progress:  TaskProgress{Percent: &zero},
			CreatedAt: created, UpdatedAt: created, Deliveries: 1,
		}
		if principal != "" {
			task.Request.Principal = &principal
		}
		if dedupKey != "" {
			task.DedupKey = &dedupKey
			_, err := tx.Exec("INSERT INTO dedup (key, task_id) VALUES (?, ?) "+
				"ON CONFLICT (key) DO UPDATE SET task_id = excluded.task_id", dedupKey, task.ID)
			must(err)
		}
		writeTask(tx, task)
	})
	return task
}

func (s *Store) getTask(id string) *Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	return readTask(s.db, id)
}

// listTasks is every task (with `status` only those), oldest first.
func (s *Store) listTasks(status string) []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Task{}
	for _, t := range eachJSON[Task](s.db, "SELECT data FROM tasks ORDER BY rowid") {
		if status == "" || t.Status == status {
			out = append(out, t)
		}
	}
	return out
}

// saveTask writes a changed task, stamping when it changed.
func (s *Store) saveTask(t *Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t.UpdatedAt = isoOf(s.now())
	writeTask(s.db, *t)
}

// sweep returns abandoned claims to the queue: a working task with no update
// for timeout goes back to submitted so another agent can take it, and fails
// with redelivery_exhausted once it has been handed out maxDeliveries times.
// Never a silent drop.
func (s *Store) sweep(timeout time.Duration, maxDeliveries int) {
	s.transaction(func(tx *sql.Tx) {
		now := s.now()
		for _, task := range eachJSON[Task](tx, "SELECT data FROM tasks ORDER BY rowid") {
			if task.Status != "working" {
				continue
			}
			if updated, ok := parseISO(task.UpdatedAt); ok && now.Sub(updated) < timeout {
				continue
			}
			if task.Deliveries >= maxDeliveries {
				exhausted := "redelivery_exhausted"
				task.Status, task.Reason = "failed", &exhausted
			} else {
				task.Status, task.Claim = "submitted", nil
				task.Deliveries++
			}
			task.UpdatedAt = isoOf(now)
			writeTask(tx, task)
		}
	})
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
	// eventTypes is written once, by NewAdapter, before anything is served.
	if len(s.eventTypes) > 0 && !s.eventTypes[etype] {
		return nil, fmt.Errorf("event type %q is not declared", etype)
	}
	if payload == nil {
		payload = M{}
	}
	principal := s.caller
	ev := s.appendEvent(etype, payload)
	var taskID any
	if capability != "" {
		// Dedup is keyed on the OCCURRENCE, not on the event record: the same
		// trigger firing twice must make one task. The event id is fresh per
		// emit, so keying on it would deduplicate nothing. The occurrence is what
		// the app asked for (type, capability, payload) in canonical JSON, so key
		// order cannot tell two identical triggers apart. Who asked is part of
		// it: the same request from two people is two tasks, each run as the
		// person who asked.
		occurrence := M{"type": etype, "capability": capability, "payload": payload}
		if principal != "" {
			occurrence["principal"] = principal
		}
		dedupKey := "sha256:" + sha256Hex(canonicalize(occurrence))
		taskID = s.enqueueTask(ev.ID, capability, payload, principal, dedupKey).ID
	}
	return M{"eventId": ev.ID, "taskId": taskID}, nil
}

/* audit ------------------------------------------------------------------ */

// AuditEntry is one row of the audit log: who did what to which target, and
// how it ended. Kept in a ring of auditRetention rows; not served over HTTP.
type AuditEntry struct {
	At           string  `json:"at"`
	CredentialID *string `json:"credentialId"`
	AgentName    *string `json:"agentName"`
	Principal    *string `json:"principal"`
	Target       string  `json:"target"`
	RecordID     *string `json:"recordId"`
	Outcome      string  `json:"outcome"` // ok · rejected
	Code         string  `json:"code,omitempty"`
}

func (s *Store) appendAudit(entry AuditEntry) {
	s.transaction(func(tx *sql.Tx) {
		putJSON(tx, "INSERT INTO audit (data) VALUES (?)", entry)
		_, err := tx.Exec("DELETE FROM audit WHERE seq <= (SELECT MAX(seq) FROM audit) - ?", auditRetention)
		must(err)
	})
}

// auditTail is the last n audit entries, oldest first.
func (s *Store) auditTail(n int) []AuditEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := eachJSON[AuditEntry](s.db, "SELECT data FROM (SELECT seq, data FROM audit ORDER BY seq DESC LIMIT ?) ORDER BY seq", n)
	return entries
}

/* ----------------------------------------------------------------- adapter */

func randomHex(nBytes int) string { return hex.EncodeToString(randomBytes(nBytes)) }

// OperationRunner is the signature schema.go implements: (args, ctx, store) ->
// JSON-able result. Returning an *OperationError refuses the call with its own
// status and code; any other error (or a panic) becomes operation_failed.
// ctx is who is calling: {"credentialId", "agentName", "principal", "role"}.
// An `owner` may touch every record; a `member` only the records it owns, and
// a runner holds itself to the same rule for records it touches.
type OperationRunner func(args M, ctx M, store *Store) (any, error)

// OperationError is how a runner refuses a call in terms an agent can act on:
// the reply is HTTPStatus (400 when unset) with {code, message} plus Extra,
// instead of a 500 operation_failed. Parity oracle: adapter-core OperationError.
type OperationError struct {
	Code       string
	Message    string
	HTTPStatus int
	Extra      M
}

func (e *OperationError) Error() string { return e.Message }

// declaredEntities is an app's ENTITIES as the adapter takes them: a list of
// entities, each naming itself with "name", in the order describe shows them.
// An older schema.go declares a map instead, which still works, in name order.
func declaredEntities[T map[string]M | []M](declared T) []M {
	switch d := any(declared).(type) {
	case []M:
		return d
	case map[string]M:
		names := make([]string, 0, len(d))
		for name := range d {
			names = append(names, name)
		}
		sort.Strings(names)
		out := make([]M, 0, len(d))
		for _, name := range names {
			entity := M{"name": name}
			for k, v := range d[name] {
				entity[k] = v
			}
			out = append(out, entity)
		}
		return out
	}
	return nil
}

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
	AppID   string
	AppName any // string, or nil for an unnamed app
	// Entities is the model, one {"name", "module", "fields", ...} per entity,
	// in declaration order (see declaredEntities).
	Entities   []M
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
	PublicURL string
	Runners   map[string]OperationRunner
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
	appID   string
	appName any
	// the entities as declared, and by name in that order
	entityList     []M
	entityDefs     map[string]M
	entityOrder    []string
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

	// Open tabs, by the opaque per-tab id their update watcher sends with its
	// identity poll, and when each was last heard from. A COUNT is all this
	// answers — "is anyone looking at this app?", so the CLI knows whether to
	// open a browser — never who: held in memory only, never published.
	viewersMu sync.Mutex
	viewers   map[string]time.Time
}

const (
	viewerTTL = 60 * time.Second
	viewerCap = 1000
)

// NewAdapter builds the adapter or reports every declaration problem. A model
// whose entities or operations name a module that was never declared cannot be
// walked, so serving it would answer 200 while omitting real capability —
// construction fails fast instead.
func NewAdapter(cfg AdapterConfig) (*Adapter, error) {
	a := &Adapter{
		appID:          cfg.AppID,
		appName:        cfg.AppName,
		entityList:     cfg.Entities,
		entityDefs:     map[string]M{},
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
		viewers:        map[string]time.Time{},
	}
	if a.authMode != "multi-user" {
		a.authMode = "none"
	}
	a.multiUser = a.authMode == "multi-user"
	a.sessionCookieName = "a2app_session_" + a.appID
	a.secureCookies = strings.HasPrefix(cfg.PublicURL, "https://")
	a.signInFailures = newFailureLimiter(signInFailureMax, signInWindow, func() time.Time { return a.now() })
	// App text is bounded before it is forwarded to an agent; the framework's
	// own sentence is the fallback.
	a.credentialHint = boundAppText(cfg.CredentialHint)
	if a.credentialHint == "" {
		a.credentialHint = defaultCredentialHint
	}
	if a.runners == nil {
		a.runners = map[string]OperationRunner{}
	}
	for _, e := range cfg.Entities {
		name := getStr(e, "name")
		if _, taken := a.entityDefs[name]; !taken {
			a.entityOrder = append(a.entityOrder, name)
		}
		a.entityDefs[name] = e
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
		}
	}
	// Every task and event names the app it came from.
	cfg.Store.app = cfg.AppID
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
// adapters/adapter-core/src/describe.ts, plus the two a declared list can get
// wrong that an object cannot (a missing or repeated entity name).
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
	named := map[string]bool{}
	for _, e := range a.entityList {
		name := getStr(e, "name")
		if name == "" {
			problems = append(problems, `an entity declares no "name"`)
		} else if named[name] {
			problems = append(problems, `duplicate entity "`+name+`"`)
		}
		named[name] = true
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

// entityNames is every entity in declaration order — the order describe lists
// them in, as the app's author chose it (the most-used first), and the order a
// budget-trimmed list keeps.
func (a *Adapter) entityNames() []string { return a.entityOrder }

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
			rec[name] = isoOf(a.store.now())
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
	now := a.now()
	_, offsetSeconds := now.Zone()
	doc := M{
		"a2app": true, "protocol": PROTOCOL_VERSION, "adapterVersion": ADAPTER_VERSION,
		"app": M{"id": a.appID, "name": a.appName}, "schemaVersion": a.schemaVersion(),
		// Moves on every record write. A View watcher compares this separately
		// from appVersion/schemaVersion so it can re-read data without reloading.
		"dataVersion": a.dataVersion(),
		"serverNow":   isoOf(now),
		// The server's own UTC offset, so a client can say "today" as it does.
		"serverTzOffsetMinutes": offsetSeconds / 60,
		"authMode":              a.authMode,
		"accountUrl":            accountURL,
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

// levelSize is a level's serialized size in the units the budget is stated
// in: characters of its JSON, as JavaScript counts them.
func levelSize(level M) int { return jsLength(stableJSON(level)) }

// fitList trims a list until the level fits, always reporting what was
// dropped. Entries are dropped from the end, so the declared order — the
// author's, most-used first — decides what survives.
func fitList(build func(items []M, truncated int) M, items []M) M {
	whole := build(append([]M{}, items...), 0)
	if levelSize(whole) <= describeBudgetChars {
		return whole
	}
	lo, hi := 0, len(items)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if levelSize(build(items[:mid], len(items)-mid)) <= describeBudgetChars {
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

func (a *Adapter) describeRoot(access accessView, showAll bool) M {
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

	build := func(rows []M, truncated int, summaries bool) M {
		listed := rows
		if !summaries {
			listed = make([]M, len(rows))
			for i, row := range rows {
				listed[i] = M{"name": row["name"], "entities": row["entities"], "operations": row["operations"], "access": row["access"]}
			}
		}
		next := []string{"describe/{module}", "describe?find={term}"}
		if truncated > 0 {
			next = append(next, "describe?all=true")
		}
		level := M{
			"level":       "root",
			"app":         M{"id": a.appID, "name": a.appName},
			"modules":     listed,
			"conventions": conventions(),
			"next":        next,
		}
		if truncated > 0 {
			level["truncated"] = truncated
		}
		return level
	}
	if showAll {
		return build(modules, 0, true)
	}
	// Shed DETAIL before EXISTENCE: a module's summary is prose, its name,
	// counts and access are what make it reachable, so summaries go first and
	// every module stays named. Only if bare names still do not fit are rows
	// dropped — counted, and `?all=true` returns them.
	if whole := build(modules, 0, true); levelSize(whole) <= describeBudgetChars {
		return whole
	}
	if bare := build(modules, 0, false); levelSize(bare) <= describeBudgetChars {
		return bare
	}
	return fitList(func(rows []M, truncated int) M { return build(rows, truncated, false) }, modules)
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

func (a *Adapter) describeEntity(module, name string, d M, access accessView, showAll bool) M {
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
	path := module + "/" + name
	build := func(operations []M, truncated int) M {
		next := []string{"describe/" + path + "/{id}", "data " + name + " list"}
		if truncated > 0 {
			next = append(next, "describe/"+path+"?all=true")
		}
		level := M{
			"level":      "entity",
			"path":       path,
			"label":      labelFieldOf(fieldsOf(d)),
			"records":    "/api/collections/" + name + "/records",
			"fields":     fields,
			"operations": operations,
			"next":       next,
		}
		if getBool(d, "auth") {
			level["auth"] = true
		}
		if ownedBy := getStr(d, "ownedBy"); ownedBy != "" {
			level["ownedBy"] = ownedBy
		}
		if truncated > 0 {
			level["truncated"] = truncated
		}
		return level
	}
	// FIELDS ARE NEVER TRIMMED: a client treats a field absent from describe as
	// write-only and exempts it from the read-back check. Operations can be —
	// they are reachable from the module screen and from search too, and the
	// count is always reported.
	if showAll {
		return build(ops, 0)
	}
	return fitList(build, ops)
}

// targetParamOf is the parameter that takes THIS record, when an operation
// names exactly one: a single required `ref` to this entity. The record screen
// invites a call at the record's own path, but the wire call cannot see the
// path, so naming the parameter lets a client fill it in; with two candidates
// nothing is named and the caller passes it explicitly.
func targetParamOf(o M, entity string) string {
	params, _ := o["params"].(M)
	candidates := []string{}
	for name, p := range params {
		param, _ := p.(M)
		if getStr(param, "type") == "ref" && getStr(param, "entity") == entity && param["required"] == true {
			candidates = append(candidates, name)
		}
	}
	if len(candidates) != 1 {
		return ""
	}
	return candidates[0]
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
		if target := targetParamOf(o, name); target != "" {
			row["targetParam"] = target
		}
		if when, ok := o["appliesWhen"].(M); ok && !evaluatePredicate(when, record, fields) {
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
		"writes":  "Prefer a declared operation over a raw write where one exists.",
		"labels":  "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
		"dates":   `Relative words ("tomorrow") are rejected by the app; resolve them to ISO 8601 client-side.`,
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

// defaultCredentialHint is the `how` on a 401 agent_token_required. It
// describes a file on the app's own host, so it is an answer only the app's
// owner can act on; an app served to others sets AdapterConfig.CredentialHint.
const defaultCredentialHint = "Read the app's .agent-token file (mode 0600) in the project directory."

// appTextMax is the cap on app-supplied text forwarded into an agent's
// context: long enough for a hint, far too short to carry instructions.
const appTextMax = 300

// boundAppText is text the APP supplied, made safe to forward to an agent: one
// line (runs of whitespace become one space, so it cannot impersonate a new
// section) and at most appTextMax characters, with a marker saying how much
// was cut. "" for blank input. Parity oracle: adapter-core agentText.ts.
func boundAppText(value string) string {
	single := strings.Join(strings.FieldsFunc(value, isJSSpace), " ")
	length := jsLength(single)
	if length <= appTextMax {
		return single
	}
	// The suffix counts toward the cap and its own length changes the count it
	// reports; three passes reach the fixed point.
	suffix := ""
	for i := 0; i < 3; i++ {
		suffix = fmt.Sprintf(" [truncated by adapter, %d chars cut]", length-appTextMax+jsLength(suffix))
	}
	units := utf16.Encode([]rune(single))
	return string(utf16.Decode(units[:max(0, appTextMax-jsLength(suffix))])) + suffix
}

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
	token := firstHeader(headers, "x-a2app-token", "x-lui-token")
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
		taskOver = task == nil || terminalTask[task.Status]
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

// firstHeader is the first of these headers the request carries, even an empty
// one (JavaScript's `a ?? b`), or "".
func firstHeader(headers map[string]string, names ...string) string {
	for _, name := range names {
		if value, present := headers[name]; present {
			return value
		}
	}
	return ""
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
// this app does not answer to, else a nil body. Handle checks it before every
// path — adapter routes, the View and the system pages alike — since any of
// them is a free fingerprint of the app for a rebound page: binding loopback
// does not stop a page on evil.com whose DNS re-resolves to 127.0.0.1, but its
// Host header still says evil.com.
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
		// The origin, as a browser writes it in the Origin header: a default port
		// is not part of it.
		host := strings.ToLower(u.Host)
		if port := u.Port(); port == "" || (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
			host = strings.TrimSuffix(strings.TrimSuffix(host, port), ":")
		}
		publicURL = scheme + "://" + host
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

// rateGate counts one request against the caller's budget for a route class:
// keyed by the credential presented, else the page's Origin, else "anon".
// Over the limit answers 429 before any work, and the refusal is audited so a
// flood is visible afterwards. A token is a secret and the audit log is
// persisted, so a caller is keyed by its token's hash, never the token.
func (a *Adapter) rateGate(headers map[string]string, cls string) (int, M) {
	caller := "anon"
	if token := firstHeader(headers, "x-a2app-token", "x-lui-token"); token != "" {
		caller = "token:" + hashSecret(token)
	} else if origin := headers["origin"]; origin != "" {
		caller = "origin:" + origin
	}
	decision := a.limiter.check(caller, cls)
	if decision.allowed {
		return 0, nil
	}
	a.writeAudit(&auditActor{credentialID: caller}, "rate:"+cls, "", "rejected", codeRateLimited)
	return errEnv(429, codeRateLimited,
		fmt.Sprintf("Rate limit exceeded (%d per window). Slow down and retry.", decision.limit),
		M{"retryAfterSeconds": decision.retryAfterSeconds})
}

// auditActor is who an audit entry names: a call context, or for a refusal
// that came before anyone was resolved, just the key it was counted under.
type auditActor struct {
	credentialID string
	agentName    any
	principal    string
}

func actorOf(ctx M) *auditActor {
	if ctx == nil {
		return nil
	}
	return &auditActor{credentialID: getStr(ctx, "credentialId"), agentName: ctx["agentName"], principal: getStr(ctx, "principal")}
}

// writeAudit appends one entry to the audit log: who (nil when the request
// was refused before anyone was resolved), the target (`data:<entity>`,
// `op:<name>`, `task:<action>`, `rate:<class>`), the record, and how it ended.
func (a *Adapter) writeAudit(actor *auditActor, target, recordID, outcome, code string) {
	entry := AuditEntry{At: isoOf(a.now()), Target: target, Outcome: outcome, Code: code}
	if recordID != "" {
		entry.RecordID = &recordID
	}
	if actor != nil {
		entry.CredentialID = &actor.credentialID
		if name, ok := actor.agentName.(string); ok {
			entry.AgentName = &name
		}
		if actor.principal != "" {
			entry.Principal = &actor.principal
		}
	}
	a.store.appendAudit(entry)
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
		return 200, a.describeRoot(access, q["all"] == "true")
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
		return 200, a.describeEntity(moduleName, entity, d, access, q["all"] == "true")
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
		relations := []string{}
		for _, f := range fieldsOf(d) {
			if getStr(f, "type") == "list<ref>" && !getBool(f, "writeOnly") {
				relations = append(relations, getStr(f, "name"))
			}
		}
		return errEnv(404, "unknown_relation", `"`+relation+`" is not a sub-resource of `+entity+".", M{"relations": relations})
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
		id := jsString(rid)
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

// The path prefixes the adapter owns outright: a miss under one is the
// adapter's 404. Any other path is the host app's — here, the View.
var adapterNamespaces = []string{"/api/_a2app", "/api/ops", "/api/collections"}

func isAdapterNamespace(path string) bool {
	for _, ns := range adapterNamespaces {
		if path == ns || strings.HasPrefix(path, ns+"/") {
			return true
		}
	}
	return false
}

var recordsRe = regexp.MustCompile(`^/api/collections/([^/]+)/records(?:/([^/]+))?$`)
var opsRe = regexp.MustCompile(`^/api/ops/([^/]+)$`)
var trailingSlashRe = regexp.MustCompile(`/+$`)

// Request is one HTTP request as the adapter routes it (the reference's
// A2AppRequest).
type Request struct {
	Method string
	// The path as sent, still percent-encoded: routing splits it first and
	// decodes each segment after, so an escaped "/" inside a record id cannot
	// split it. A query string on it is read too.
	Path  string
	Query map[string]string
	// Lower-cased names. A header sent twice is its values joined by ", ".
	Headers map[string]string
	// The body as ParseBody read it (nil when there is none), and a top-level
	// object's keys in the order they were written.
	Body     any
	BodyKeys []string
}

// request is a Request as the routes read it.
type request struct {
	method  string
	path    string
	headers map[string]string
	query   map[string]string
	body    bodyView
}

// Handle answers one request. handled is false for a path that is not the
// adapter's (outside identity and its namespaces): the host app answers it —
// here, the static View. The Host check comes first, on every path, so the
// View is refused under a foreign Host exactly as the API is. The reply
// headers are the ones beyond its content type (a session's Set-Cookie). A
// panic inside — a database failure, a malformed escape in a path segment —
// answers 500 adapter_error, as an exception escaping the reference's router
// does.
func (a *Adapter) Handle(req Request) (status int, payload M, replyHeaders map[string]string, handled bool) {
	defer func() {
		if p := recover(); p != nil {
			status, payload, replyHeaders, handled = 500, M{"a2app": true, "ok": false, "code": "adapter_error", "message": panicMessage(p)}, nil, true
		}
	}()
	r := &request{method: strings.ToUpper(req.Method), headers: map[string]string{}, query: map[string]string{}}
	for k, v := range req.Headers {
		r.headers[strings.ToLower(k)] = v
	}
	for k, v := range req.Query {
		r.query[k] = v
	}
	path := req.Path
	if i := strings.Index(path, "?"); i >= 0 {
		for k, v := range parseQuery(path[i+1:]) {
			r.query[k] = v
		}
		path = path[:i]
	}
	r.path = trailingSlashRe.ReplaceAllString(path, "")
	if r.path == "" {
		r.path = "/"
	}
	r.body = viewBody(req.Body, req.BodyKeys)

	// Before any route, including the unauthenticated identity document, which
	// is otherwise a free fingerprint of the app for a rebound page: binding
	// loopback does not stop a page on evil.com whose DNS re-resolves to
	// 127.0.0.1, but its Host header still says evil.com. A request with no
	// Host at all (HTTP/1.0) names no other host, and is answered.
	if host, present := r.headers["host"]; present {
		if status, refusal := a.hostRefusal(host); refusal != nil {
			return status, refusal, nil, true
		}
	}
	status, payload, replyHeaders = a.route(r)
	return status, payload, replyHeaders, payload != nil
}

func panicMessage(p any) string {
	if err, ok := p.(error); ok {
		return err.Error()
	}
	return fmt.Sprint(p)
}

// route answers every adapter path; a nil payload means the path is not one.
func (a *Adapter) route(r *request) (int, M, map[string]string) {
	method, path, headers, q, body := r.method, r.path, r.headers, r.query, r.body.fields

	if path == "/.well-known/a2app.json" || path == "/api/_a2app" {
		// The update watcher polls identity anyway, so its "I am still here"
		// rides along rather than doubling every open tab's requests.
		a.noteViewer(headers, q)
		return plain(200, a.identity())
	}
	// How many people have this app open: a COUNT only, and behind the same
	// check as any read — "how many are using this now" is not for anyone who
	// asks.
	if path == "/api/_a2app/viewers" {
		if _, status, refusal := a.authorize(headers, "", false); refusal != nil {
			return plain(status, refusal)
		}
		return plain(200, M{"a2app": true, "viewers": a.countViewers(), "ttlMs": viewerTTL.Milliseconds()})
	}
	// Describe is navigational: the bare path is the root level, and each
	// extra segment moves one level inward (A2APP-SPEC 3).
	if path == "/api/_a2app/describe" {
		return plain(a.handleDescribe(headers, nil, q))
	}
	if strings.HasPrefix(path, "/api/_a2app/describe/") {
		raw := strings.Split(path[len("/api/_a2app/describe/"):], "/")
		segments := make([]string, len(raw))
		for i, s := range raw {
			segments[i] = mustDecode(s)
		}
		if len(segments) > 4 {
			return plain(errEnv(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.", nil))
		}
		for _, s := range segments {
			if s == "" {
				return plain(errEnv(404, "usage", "describe path has an empty segment.", nil))
			}
		}
		return plain(a.handleDescribe(headers, segments, q))
	}
	if path == "/api/_a2app/whoami" {
		return plain(a.whoami(headers))
	}
	if strings.HasPrefix(path, "/api/_a2app/auth/") {
		// Unauthenticated by design (an agent starts here with nothing), so it
		// is metered like an operation before anything is looked up.
		if status, limited := a.rateGate(headers, "ops"); limited != nil {
			return plain(status, limited)
		}
		if status, reply, ok := a.handleDevice(method, path, headers, body); ok {
			return plain(status, reply)
		}
	}
	if path == "/api/_a2app/credentials" || strings.HasPrefix(path, "/api/_a2app/credentials/") {
		return plain(a.handleCredentials(method, path, headers, body))
	}
	// Accounts, sessions and invites — the routes whose replies set the session
	// cookie. They exist only on a multi-user app.
	for _, prefix := range []string{"/api/_a2app/session", "/api/_a2app/invites", "/api/_a2app/users"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			if !a.multiUser {
				return plain(errEnv(404, "not_multi_user", "This app has no accounts: its authMode is none.", nil))
			}
			return a.handleAccounts(method, path, headers, body)
		}
	}
	if path == "/api/_a2app/context" {
		if _, status, refusal := a.authorize(headers, "", false); refusal != nil {
			return plain(status, refusal)
		}
		return plain(200, M{"a2app": true, "view": nil, "selected": []any{}})
	}
	if path == "/api/_a2app/events" {
		return plain(a.handleEvents(headers, q))
	}
	if path == "/api/_a2app/tasks" || strings.HasPrefix(path, "/api/_a2app/tasks/") {
		rest := []string{}
		if path != "/api/_a2app/tasks" {
			rest = strings.Split(path[len("/api/_a2app/tasks/"):], "/")
		}
		return plain(a.handleTasks(method, headers, rest, body, q))
	}
	if m := recordsRe.FindStringSubmatch(path); m != nil {
		recID := ""
		if m[2] != "" {
			recID = mustDecode(m[2])
		}
		return plain(a.handleRecords(method, headers, mustDecode(m[1]), recID, r.body, q))
	}
	if m := opsRe.FindStringSubmatch(path); m != nil {
		if method != "POST" {
			return plain(errEnv(405, "usage", "Operations are POST-only.", nil))
		}
		return plain(a.handleOperation(headers, mustDecode(m[1]), r.body))
	}
	// A miss in the adapter's own namespaces is the adapter's to answer; the
	// rest is the host app's.
	if isAdapterNamespace(path) {
		return plain(errEnv(404, "not_found", unknownRouteMessage, nil))
	}
	return 0, nil, nil
}

// whoami answers whoever this app will actually serve, which is what
// authorize decides — so it asks the same question. The 401 that remains is
// the honest one: on a multi-user app with nothing presented, authorize really
// would refuse.
func (a *Adapter) whoami(headers map[string]string) (int, M) {
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
	// The reach the request was given: a credential's scopes intersected with
	// what its person may do now, or a person's own. An anonymous read on a
	// single-user app was never scope-checked, so it reports the reach describe
	// renders for it — one source, so the two cannot disagree.
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

// noteViewer records an open tab's heartbeat, if this request carries one:
// the id in the x-a2app-viewer header, or ?viewer= on the goodbye a closing
// tab sends with sendBeacon (which cannot set headers). A goodbye
// (x-a2app-viewer-leaving, or ?leaving) drops the tab at once rather than at
// the end of the TTL.
func (a *Adapter) noteViewer(headers, query map[string]string) {
	id, present := headers["x-a2app-viewer"]
	if !present {
		id, present = query["viewer"]
	}
	if !present || id == "" || jsLength(id) > 64 {
		return
	}
	a.viewersMu.Lock()
	defer a.viewersMu.Unlock()
	_, leavingHeader := headers["x-a2app-viewer-leaving"]
	_, leavingQuery := query["leaving"]
	if leavingHeader || leavingQuery {
		delete(a.viewers, id)
		return
	}
	a.viewers[id] = a.now()
	// A reloaded page gets a fresh id, so the map would otherwise grow with
	// every reload until the process restarts.
	if len(a.viewers) > viewerCap {
		a.liveViewersLocked()
	}
}

// countViewers is how many tabs were heard from within the TTL.
func (a *Adapter) countViewers() int {
	a.viewersMu.Lock()
	defer a.viewersMu.Unlock()
	return a.liveViewersLocked()
}

// liveViewersLocked prunes the expired and counts the rest; the caller holds
// viewersMu.
func (a *Adapter) liveViewersLocked() int {
	cutoff := a.now().Add(-viewerTTL)
	for id, seen := range a.viewers {
		if seen.Before(cutoff) {
			delete(a.viewers, id)
		}
	}
	return len(a.viewers)
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

// guardEnvelope is the 400 a guard refusal answers: the first violation up
// front, every one listed.
func guardEnvelope(violations []M, serverNow string) (int, M) {
	first := violations[0]
	listed := make([]M, len(violations))
	for i, v := range violations {
		listed[i] = M{"code": v["code"], "field": v["field"], "expected": v["expected"], "got": v["got"]}
	}
	return 400, M{
		"a2app": true, "ok": false, "code": first["code"], "field": first["field"],
		"expected": first["expected"], "got": first["got"],
		"message":    describeViolation(first, serverNow),
		"violations": listed,
	}
}

func (a *Adapter) handleRecords(method string, headers map[string]string, entity, recID string, body bodyView, query map[string]string) (int, M) {
	if status, limited := a.rateGate(headers, "data"); limited != nil {
		return status, limited
	}
	d, known := a.entityDefs[entity]
	if !known {
		return errEnv(404, "unknown_entity", `No such entity "`+entity+`".`, nil)
	}
	fields := fieldsOf(d)
	serverNow := isoOf(a.now())
	notFound := func() (int, M) {
		return errEnv(404, "record_not_found", "No "+entity+` record "`+recID+`".`, nil)
	}

	if method == "GET" {
		ctx, status, refusal := a.authorize(headers, "data:"+entity+":read", false)
		if refusal != nil {
			return status, refusal
		}
		if recID != "" {
			rec := a.visible(d, ctx, a.store.getRecord(entity, recID))
			if rec == nil {
				return notFound()
			}
			return 200, rec
		}
		listQuery := M{}
		if a.ownedOnly(d, ctx) {
			listQuery["where"] = map[string]string{getStr(d, "ownedBy"): getStr(ctx, "principal")}
		}
		for _, name := range []string{"filter", "sort"} {
			if v, present := query[name]; present {
				listQuery[name] = v
			}
		}
		// Paging arrives as text and is read as Number() reads it, edge cases
		// and all (see Store.listRecords).
		for _, name := range []string{"perPage", "page"} {
			if v, present := query[name]; present {
				listQuery[name] = jsNumber(v)
			}
		}
		result, err := a.store.listRecords(entity, listQuery)
		var unsupported *UnsupportedFilter
		if errors.As(err, &unsupported) {
			// Refuse, never ignore: unfiltered rows under a filter would be a 200
			// with the wrong records (see the grammar's comment).
			return errEnv(400, codeInvalidFilter, err.Error(), M{"got": unsupported.Expression})
		}
		return 200, result
	}

	target := "data:" + entity
	ctx, status, refusal := a.authorize(headers, target+":write", true)
	if refusal != nil {
		a.writeAudit(nil, target, recID, "rejected", getStr(refusal, "code"))
		return status, refusal
	}
	actor := actorOf(ctx)

	if method == "DELETE" {
		if recID == "" {
			return errEnv(400, "usage", "DELETE requires a record id.", nil)
		}
		if a.ownedOnly(d, ctx) && a.visible(d, ctx, a.store.getRecord(entity, recID)) == nil {
			return notFound()
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
			a.writeAudit(actor, target, recID, "rejected", codeRecordReferenced)
			return errEnv(409, codeRecordReferenced,
				"Cannot delete "+entity+` "`+recID+`": `+said+" it ("+strings.Join(where, ", ")+").",
				M{
					"referencedBy": blockers,
					"resolution": "Remove or repoint the referencing records first, or run an operation the app " +
						"provides for this. An app that intends references to outlive the record " +
						"declares `onDelete: \"ignore\"` on the ref.",
				})
		}

		deleted := a.store.deleteRecord(entity, recID)
		outcome := "ok"
		if !deleted {
			outcome = "rejected"
		}
		a.writeAudit(actor, target, recID, outcome, "")
		if !deleted {
			return notFound()
		}
		a.markDataChanged()
		return 200, M{"a2app": true, "ok": true, "deleted": recID}
	}

	if method != "POST" && method != "PATCH" {
		return errEnv(405, "usage", method+" not allowed on records.", nil)
	}

	// Idempotency: a replayed key answers 409 naming the record. A create's key
	// is scoped to the entity, an update's to the row it targeted, so the two
	// can never collide; checked before the guard, recorded only after a write
	// that read back whole.
	idem := headers["idempotency-key"]
	idemActive := idem != "" && (method == "POST" || recID != "")
	idemScope := entity
	if method == "PATCH" {
		idemScope = entity + "#" + recID
	}
	if idemActive {
		if prior, found := a.store.idempotencyGet(idemScope, idem); found {
			return errEnv(409, codeDuplicateRequest, "This idempotency key was already applied.", M{"id": prior})
		}
	}

	// Guard the RAW body before any coercion. Required fields left out are
	// enforced on a create only — a PATCH is a legitimate partial write.
	allow := map[string]bool{}
	for _, k := range toAnyList(d["writeAllow"]) {
		allow[toStr(k)] = true
	}
	if violations := validate(fields, body.keys, body.fields, allow, method == "POST"); len(violations) > 0 {
		a.writeAudit(actor, target, recID, "rejected", getStr(violations[0], "code"))
		return guardEnvelope(violations, serverNow)
	}

	// Backend write. The owner field is the adapter's to set: the guard has
	// already refused a client that tried, because it is read-only.
	var stored M
	if method == "POST" {
		create := M{}
		for k, v := range body.fields {
			create[k] = v
		}
		if ownedBy := getStr(d, "ownedBy"); ownedBy != "" {
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
			return notFound()
		}
		for _, f := range fields {
			name := getStr(f, "name")
			if getBool(f, "readOnly") || !hasKey(body.fields, name) {
				continue
			}
			if v := body.fields[name]; v == nil || v == "" {
				delete(existing, name)
			} else {
				existing[name] = coerce(f, v)
			}
		}
		a.store.putRecord(entity, existing)
		stored = existing
	}

	// Read-back: did every non-blank requested value land?
	lost := divergences(fields, body.keys, body.fields, func(n string) any { return stored[n] })
	if len(lost) > 0 {
		lostViolations := []M{}
		for _, l := range lost {
			lostViolations = append(lostViolations, M{"code": codeNotStored, "field": l["field"]})
		}
		a.writeAudit(actor, target, getStr(stored, "id"), "rejected", codeNotStored)
		return 422, M{
			"a2app": true, "ok": false, "code": codeNotStored,
			"message":    describeIncomplete(lost),
			"violations": lostViolations,
			"id":         stored["id"],
		}
	}

	if idemActive {
		a.store.idempotencyPut(idemScope, idem, getStr(stored, "id"))
	}
	a.writeAudit(actor, target, getStr(stored, "id"), "ok", "")
	a.markDataChanged()
	return 200, stored
}

/* -- operations ----------------------------------------------------------------- */

// paramFields is an operation's parameters in the shape the guard validates.
// An operation IS a write, often a destructive one, so its arguments meet the
// same rules as a record write — before anything acts on them, and before an
// approval key is minted for a call that could never run.
func paramFields(decl M) []M {
	params, _ := decl["params"].(M)
	names := make([]string, 0, len(params))
	for name := range params {
		names = append(names, name)
	}
	sort.Strings(names) // a Go map keeps no declaration order
	out := make([]M, 0, len(names))
	for _, name := range names {
		p, _ := params[name].(M)
		field := M{"name": name, "type": getStr(p, "type")}
		for _, attr := range []string{"required", "max", "values", "entity"} {
			if v, present := p[attr]; present {
				field[attr] = v
			}
		}
		out = append(out, field)
	}
	return out
}

func (a *Adapter) handleOperation(headers map[string]string, name string, body bodyView) (int, M) {
	if status, limited := a.rateGate(headers, "ops"); limited != nil {
		return status, limited
	}
	decl, known := a.opByName[name]
	if !known {
		return errEnv(404, "unknown_operation", `No declared operation "`+name+`".`, nil)
	}
	ctx, status, refusal := a.authorize(headers, "op:"+name, !getBool(decl, "readOnly"))
	if refusal != nil {
		return status, refusal
	}
	target := "op:" + name
	actor := actorOf(ctx)
	args := body.fields

	// Every parameter is supplied fresh on each call — there is no partial
	// update here — so a declared `required` is always enforced.
	if violations := validate(paramFields(decl), body.keys, args, nil, true); len(violations) > 0 {
		a.writeAudit(actor, target, "", "rejected", getStr(violations[0], "code"))
		return guardEnvelope(violations, isoOf(a.now()))
	}

	// Idempotency: a retried call carrying the same key must not run twice. Its
	// scope is `op:<name>`, apart from every record key; it is checked before
	// approval and recorded only after a success, so a first call that needed
	// approval or failed leaves the retry free to run.
	idem := headers["idempotency-key"]
	if idem != "" {
		if _, found := a.store.idempotencyGet(target, idem); found {
			return errEnv(409, codeDuplicateRequest, "This idempotency key already ran this operation.", M{"operation": name})
		}
	}

	// Approval: a destructive op needs the content-addressed key of this exact
	// call, issued by a first call and used once.
	if getBool(decl, "destructive") {
		key := approvalKey(name, body.raw)
		provided := firstHeader(headers, "x-a2app-approval", "x-lui-approval")
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
		var refused *OperationError
		if errors.As(err, &refused) {
			a.writeAudit(actor, target, "", "rejected", refused.Code)
			status := refused.HTTPStatus
			if status == 0 {
				status = 400
			}
			return errEnv(status, refused.Code, refused.Message, refused.Extra)
		}
		a.writeAudit(actor, target, "", "rejected", "operation_failed")
		return errEnv(500, "operation_failed", `Operation "`+name+`" threw: `+err.Error(), nil)
	}
	if idem != "" {
		a.store.idempotencyPut(target, idem, name)
	}
	// A declared read-only operation promises no side effects; anything else is
	// assumed to have touched data, since the adapter cannot see inside it.
	if !getBool(decl, "readOnly") {
		a.markDataChanged()
	}
	a.writeAudit(actor, target, "", "ok", "")
	return 200, M{"a2app": true, "ok": true, "operation": name, "result": result}
}

// runOperation shields the surface from a runner that panics: app code failing
// must answer operation_failed, never take the process down mid-request (a
// panic carrying an *OperationError still refuses as one). The runner's store
// is bound to its caller, so a task it queues is done by an agent acting as
// whoever called it.
func (a *Adapter) runOperation(runner OperationRunner, args M, ctx M) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, isError := r.(error); isError {
				err = e
			} else {
				err = fmt.Errorf("%v", r)
			}
		}
	}()
	return runner(args, ctx, a.store.forCaller(getStr(ctx, "principal")))
}

/* -- tasks / events ---------------------------------------------------------------- */

func (a *Adapter) handleEvents(headers map[string]string, query map[string]string) (int, M) {
	if status, limited := a.rateGate(headers, "data"); limited != nil {
		return status, limited
	}
	if _, status, refusal := a.authorize(headers, "", false); refusal != nil {
		return status, refusal
	}
	events, next := a.store.eventsSince(query["since"])
	wire := make([]M, len(events))
	for i, e := range events {
		wire[i] = M{"id": e.ID, "app": e.App, "type": e.Type, "payload": e.Payload, "createdAt": e.CreatedAt}
	}
	return 200, M{"a2app": true, "events": wire, "nextCursor": next, "pollAfterMs": 3000}
}

func (a *Adapter) handleTasks(method string, headers map[string]string, rest []string, body M, query map[string]string) (int, M) {
	if status, limited := a.rateGate(headers, "data"); limited != nil {
		return status, limited
	}
	c, status, refusal := a.resolve(headers, method != "GET")
	if refusal != nil {
		return status, refusal
	}
	ctx := c.ctx
	actor := actorOf(ctx)
	isOwner := getStr(ctx, "role") == "owner"

	// A task holds who asked and what was asked and answered, so it is reached
	// like a record (spec/v0_2/auth.md §6.3): an owner reaches every task, a
	// task credential its own, anyone else the tasks they queued.
	reaches := func(t Task) bool {
		if c.grant != nil && c.grant.Task != "" {
			return c.grant.Task == t.ID
		}
		return isOwner || (t.Request.Principal != nil && *t.Request.Principal == getStr(ctx, "principal"))
	}
	// Progress and completion come from whoever runs the task.
	runs := func(t Task) bool {
		return isOwner || (c.grant != nil && c.grant.Task == t.ID) ||
			(t.Claim != nil && t.Claim.CredentialID == getStr(ctx, "credentialId") && t.Claim.Principal == getStr(ctx, "principal"))
	}

	a.store.sweep(taskTimeout, taskMaxDeliveries)

	if len(rest) == 0 && method == "GET" {
		tasks := []M{}
		for _, t := range a.store.listTasks(query["status"]) {
			if reaches(t) {
				tasks = append(tasks, taskWire(t))
			}
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
	// A task out of reach answers as one that does not exist: its existence is
	// itself something the caller may not learn.
	task := a.store.getTask(taskID)
	if task == nil || !reaches(*task) {
		return errEnv(404, codeTaskNotFound, `No task "`+taskID+`".`, nil)
	}
	// A report on a task the caller reaches but does not run, refused and
	// audited like the other task refusals.
	notHeld := func() (int, M) {
		a.writeAudit(actor, "task:"+action, taskID, "rejected", codeTaskNotHeld)
		return errEnv(403, codeTaskNotHeld, "Task "+taskID+" is held by another credential; only the run that holds it reports on it.", nil)
	}
	if !hasAction && method == "GET" {
		return 200, taskWire(*task)
	}
	if method != "POST" {
		return errEnv(405, "usage", method+" not allowed here.", nil)
	}

	switch action {
	case "claim":
		if task.Status != "submitted" {
			a.writeAudit(actor, "task:claim", taskID, "rejected", codeTaskNotClaimable)
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" is "+task.Status+", not claimable.", nil)
		}
		// An agent may name itself in the body ({agent: <credentialId>}), but only
		// as the credential it presented: claiming as someone else is refused
		// rather than recorded under a name that is not the caller's.
		if requested, _ := body["agent"].(string); requested != "" &&
			requested != getStr(ctx, "credentialId") && requested != ctx["agentName"] {
			a.writeAudit(actor, "task:claim", taskID, "rejected", "principal_mismatch")
			return errEnv(403, "principal_mismatch",
				"Cannot claim task "+taskID+` as "`+requested+`": the credential presented is `+getStr(ctx, "credentialId")+".",
				M{"requested": requested, "actual": ctx["credentialId"]})
		}
		task.Status = "working"
		task.Claim = &TaskClaim{CredentialID: getStr(ctx, "credentialId"), Principal: getStr(ctx, "principal"), ClaimedAt: isoOf(a.now())}
		a.store.saveTask(task)
		a.writeAudit(actor, "task:claim", taskID, "ok", "")
		return 200, taskWire(*task)
	case "progress":
		if task.Status == "canceled" {
			return errEnv(409, codeTaskCanceled, "Task "+taskID+" was canceled.", nil)
		}
		if task.Status != "working" && task.Status != "input-required" {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" is "+task.Status+".", nil)
		}
		if !runs(*task) {
			return notHeld()
		}
		if step, ok := body["step"].(string); ok {
			task.Progress.Step = &step
		}
		if percent, ok := body["percent"].(float64); ok {
			task.Progress.Percent = &percent
			if math.IsNaN(percent) || math.IsInf(percent, 0) {
				task.Progress.Percent = nil // what JSON.stringify writes for it
			}
		}
		if ask, asked := body["ask"]; asked {
			task.Ask = jsonSafe(ask)
			task.Status = "input-required"
		} else if task.Status == "input-required" {
			task.Status = "working"
		}
		a.store.saveTask(task)
		a.writeAudit(actor, "task:progress", taskID, "ok", "")
		return 200, taskWire(*task)
	case "complete":
		if task.Status == "canceled" {
			return errEnv(409, codeTaskCanceled, "Task "+taskID+" was canceled.", nil)
		}
		// A terminal write belongs to a live claim. Once the sweeper has returned
		// a task to the queue, a late completion from the run that abandoned it
		// must not close work someone else may now be doing.
		if task.Status != "working" && task.Status != "input-required" {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" is "+task.Status+", not in progress.", nil)
		}
		if !runs(*task) {
			return notHeld()
		}
		code := ""
		switch body["status"] {
		case "completed":
			task.Status = "completed"
			task.Result = jsonSafe(body["result"])
			if task.Result == nil {
				task.Result = M{}
			}
		case "failed":
			reason, ok := body["reason"].(string)
			if !ok {
				reason = "unspecified"
			}
			task.Status, task.Reason, code = "failed", &reason, "failed"
		default:
			return errEnv(400, "usage", `complete requires status "completed" or "failed".`, nil)
		}
		a.store.saveTask(task)
		a.writeAudit(actor, "task:complete", taskID, "ok", code)
		return 200, taskWire(*task)
	case "cancel":
		// Terminal is terminal: relabelling finished work as canceled would move
		// it backwards and rewrite the outcome of work that already happened.
		if terminalTask[task.Status] {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" already reached "+task.Status+".", nil)
		}
		task.Status = "canceled"
		a.store.saveTask(task)
		a.writeAudit(actor, "task:cancel", taskID, "ok", "")
		return 200, taskWire(*task)
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
		if terminalTask[task.Status] {
			return errEnv(409, codeTaskNotClaimable, "Task "+taskID+" already reached "+task.Status+".", nil)
		}
		principal := ownerPrincipal.ID
		if task.Request.Principal != nil {
			principal = *task.Request.Principal
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
		if declared, ok := a.capabilities[task.Request.Capability]["scopes"]; ok && declared != nil {
			scopes = scopeList(declared)
		}
		token, grant := a.mintCredential(principal, agentName, scopes, taskCredentialSeconds, taskID)
		a.writeAudit(actor, "task:credential", taskID, "ok", "")
		return 201, M{"a2app": true, "token": token, "credential": credentialWire(grant, info.Name)}
	}
	return errEnv(404, "usage", `Unknown task action "`+action+`".`, nil)
}

// taskWire is a task as served: its delivery count, dedup key and question
// are the queue's own business.
func taskWire(t Task) M {
	// `principal` is who queued the task (null for the app's own work) — the
	// person its agent acts as.
	request := M{"capability": t.Request.Capability, "payload": t.Request.Payload, "principal": nil}
	if t.Request.Principal != nil {
		request["principal"] = *t.Request.Principal
	}
	var claim, reason any
	if t.Claim != nil {
		claim = t.Claim
	}
	if t.Reason != nil {
		reason = *t.Reason
	}
	return M{
		"id": t.ID, "app": t.App, "event": t.Event, "status": t.Status,
		"request": request, "claim": claim, "progress": t.Progress,
		"result": t.Result, "reason": reason, "createdAt": t.CreatedAt,
		"updatedAt": t.UpdatedAt, "pollAfterMs": 2000,
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
		return a.handleInvite(method, mustDecode(strings.TrimPrefix(path, "/api/_a2app/invites/")), headers, body)
	case path == "/api/_a2app/users":
		return plain(a.handleUsers(method, "", headers, body))
	case strings.HasPrefix(path, "/api/_a2app/users/"):
		return plain(a.handleUsers(method, mustDecode(strings.TrimPrefix(path, "/api/_a2app/users/")), headers, body))
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
		if task == nil || terminalTask[task.Status] {
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
	return a.revokeCredential(headers, mustDecode(strings.TrimPrefix(path, "/api/_a2app/credentials/")))
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
//
// Approving is not enough on its own: anyone can start a request and send the
// person its link. So approval issues a one-time confirmation code, and the
// credential goes only to whoever presents it. An agent on the person's own
// computer receives it on a loopback port (RFC 8252) when the page returns the
// browser there; an agent elsewhere is given it by the person.

const (
	deviceCodeTTLSeconds      = 600
	devicePollIntervalSeconds = 5
	deviceSlowDownStepSeconds = 5
	// Wrong confirmation codes a request survives before it is void.
	deviceConfirmAttempts = 5
	// Where an agent on the person's computer waits for the confirmation.
	loopbackCallback = "/a2app/callback"
	loopbackPortMin  = 1024
	loopbackPortMax  = 65535
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
		code := mustDecode(strings.TrimPrefix(path, "/api/_a2app/auth/device/"))
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
	var loopbackPort *int
	if v := body["loopbackPort"]; v != nil {
		n, isNumber := v.(float64)
		if !isNumber || n != math.Trunc(n) || n < loopbackPortMin || n > loopbackPortMax {
			return errEnv(400, "usage", fmt.Sprintf("loopbackPort is the port, %d to %d, where the agent waits on 127.0.0.1.",
				loopbackPortMin, loopbackPortMax), nil)
		}
		port := int(n)
		loopbackPort = &port
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
		Interval: devicePollIntervalSeconds, Status: "pending", LoopbackPort: loopbackPort,
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
	if row.Status == "approved" && row.ApprovedBy != "" && row.ApprovedScopes != nil && row.ConfirmationHash != "" {
		// Answered at once, whatever the interval: wrong guesses are bounded by
		// deviceConfirmAttempts instead.
		confirmation := ""
		if typed, ok := body["confirmation"].(string); ok {
			confirmation = normalizeUserCode(typed)
		}
		if confirmation == "" {
			return errEnv(400, "confirmation_required", "Approved. Present the confirmation code the approval produced.",
				M{"interval": row.Interval})
		}
		if subtle.ConstantTimeCompare([]byte(hashSecret(confirmation)), []byte(row.ConfirmationHash)) != 1 {
			row.ConfirmAttempts++
			if row.ConfirmAttempts >= deviceConfirmAttempts {
				a.store.deleteAuthRow(tableDevices, key)
				return errEnv(400, "access_denied", "Too many wrong confirmation codes: this request is void. Start again.", nil)
			}
			a.store.putAuthRow(tableDevices, key, row)
			return errEnv(400, "confirmation_invalid", fmt.Sprintf("That is not this request's confirmation code (%d tries left).",
				deviceConfirmAttempts-row.ConfirmAttempts), nil)
		}
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
		// when the agent asked, and whether it waits on this computer: what the
		// person checks against the request their own agent just showed them
		"requestedAt": row.CreatedAt, "loopback": row.LoopbackPort != nil,
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
	// Approval hands over nothing by itself: the credential goes to whoever
	// presents this code, which reaches the agent through the person.
	confirmation := newUserCode()
	row.Status = "approved"
	row.ApprovedBy = mgr.principal
	row.ApprovedScopes = scopes
	row.ConfirmationHash = hashSecret(confirmation)
	a.store.putAuthRow(tableDevices, found.key, row)
	var redirect any
	if row.LoopbackPort != nil {
		redirect = fmt.Sprintf("http://127.0.0.1:%d%s?confirmation=%s", *row.LoopbackPort, loopbackCallback, url.QueryEscape(confirmation))
	}
	return 200, M{"a2app": true, "ok": true, "status": "approved", "confirmation": confirmation, "redirect": redirect}
}

/* ------------------------------------------------------------------ self-test */
// Rules-parity oracle, run by the toolkit gate (`go run . --selftest`). Its job
// is to prove this port and adapter-core agree, so a Go app and a Node app
// reject identical payloads identically, block identical operations for
// identical stated reasons, compute identical approval keys, and keep what
// they keep across a restart. The fixed vectors below were produced by
// adapter-core itself.
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
	codesOf := func(violations []M) []string {
		codes := []string{}
		for _, v := range violations {
			codes = append(codes, getStr(v, "code"))
		}
		return codes
	}
	// call answers one request through Handle, the way main.go does.
	call := func(app *Adapter, method, path string, headers map[string]string, body any) (int, M) {
		if body == nil && (method == "POST" || method == "PATCH") {
			body = M{}
		}
		status, reply, _, _ := app.Handle(Request{Method: method, Path: path, Headers: headers, Body: body})
		return status, reply
	}
	codeOf := func(_ int, reply M) any { return reply["code"] }
	firstOf := func(list []M) M {
		if len(list) == 0 {
			return M{}
		}
		return list[0]
	}
	statusOf := func(status int, _ M) int { return status }

	fields := []M{
		{"name": "title", "type": "string", "required": true, "max": 200},
		{"name": "status", "type": "enum", "values": []string{"todo", "doing", "done"}},
		{"name": "due", "type": "string", "max": 10, "dayKey": true},
		{"name": "created", "type": "datetime", "readOnly": true},
	}
	guard := func(body M, create bool) []M {
		view := viewBody(body, nil)
		return validate(fields, view.keys, view.fields, nil, create)
	}

	// 1. Guard: every violation, in the body's own order, by the current rules.
	codes := codesOf(guard(M{"nope": 1, "created": "x", "status": "nonsense", "due": "31-12-2026"}, false))
	sort.Strings(codes)
	check("guard reports every violation", codes,
		[]string{"invalid_daykey", "invalid_enum", "read_only_field", "unknown_field"})
	check("a good body yields no violations", len(guard(M{"title": "ok", "status": "todo"}, true)), 0)
	check("label field resolution", labelFieldOf(fields), any("title"))
	parsed, written := ParseBody([]byte(`{"status":"nonsense","2":1,"title":5,"1":0}`))
	view := viewBody(parsed, written)
	order := []string{}
	for _, v := range validate(fields, view.keys, view.fields, nil, false) {
		order = append(order, getStr(v, "field"))
	}
	check("violations follow the body's order, array-index keys first", order, []string{"1", "2", "status", "title"})
	check("a create needs every required field", codesOf(guard(M{"status": "todo"}, true)), []string{codeMissingRequired})
	check("…which an update may leave out", len(guard(M{"status": "todo"}, false)), 0)
	check("…but not blank", codesOf(guard(M{"title": ""}, false)), []string{codeMissingRequired})
	long := guard(M{"title": strings.Repeat("x", 201)}, false)
	check("text past its max is refused", []any{codesOf(long), firstOf(long)["expected"]},
		[]any{[]string{codeInvalidString}, "text of at most 200 characters"})
	check("…counted in characters", len(guard(M{"title": strings.Repeat("é", 200)}, false)), 0)
	tags := []M{{"name": "tags", "type": "list<enum>", "values": []string{"a", "b"}}}
	check("a list takes an array, not a bare value", firstOf(validate(tags, []string{"tags"}, M{"tags": "a"}, nil, false))["expected"], "an array of: a | b")
	check("…of declared values", firstOf(validate(tags, []string{"tags"}, M{"tags": []any{"a", "c"}}, nil, false))["expected"], "each of: a | b")
	check("with nothing writable, an unknown field says so",
		firstOf(validate([]M{{"name": "id", "type": "string", "readOnly": true}}, []string{"x"}, M{"x": 1.0}, nil, false))["expected"],
		"nothing — no writable fields are declared")
	numberField := []M{{"name": "n", "type": "number"}}
	numberCode := func(v any) any {
		if out := validate(numberField, []string{"n"}, M{"n": v}, nil, false); len(out) > 0 {
			return out[0]["code"]
		}
		return nil
	}
	check("a number sent as text is read as Number() reads it",
		[]any{numberCode("1e3"), numberCode("0x1A"), numberCode("Infinity"), numberCode("NaN"), numberCode("inf"), numberCode(" "), numberCode(true)},
		[]any{nil, nil, nil, codeInvalidNumber, codeInvalidNumber, codeInvalidNumber, codeInvalidNumber})
	check("…and stored as that number", []any{coerce(numberField[0], "0x1A"), coerce(numberField[0], "1e3")}, []any{26.0, 1000.0})
	check("…with Infinity stored as JSON holds it", stableJSON(M{"n": coerce(numberField[0], "Infinity")}), `{"n":null}`)
	secret := []M{{"name": "password", "type": "string", "writeOnly": true}}
	check("a write-only field is never expected back",
		len(divergences(secret, []string{"password"}, M{"password": "x"}, func(string) any { return nil })), 0)

	// 2. Predicates: availability AND the stated reason. Both are contractual —
	//    a blocked operation must say the same thing on every stack.
	record := M{"id": "t1", "title": "Ship it", "status": "doing"}
	check("ne holds", evaluatePredicate(M{"field": "status", "ne": "done"}, record, fields), true)
	check("eq fails", evaluatePredicate(M{"field": "status", "eq": "done"}, record, fields), false)
	check("eq explains with both values",
		explainPredicate(M{"field": "status", "eq": "done"}, record, fields), `status is "doing", not "done"`)
	check("in explains with the full set",
		explainPredicate(M{"field": "status", "in": []any{"todo", "done"}}, record, fields), `status is "doing", not "todo" or "done"`)
	check("all reports the first failing branch",
		explainPredicate(M{"all": []any{M{"field": "status", "ne": "done"}, M{"field": "title", "eq": "Other"}}}, record, fields),
		`title is "Ship it", not "Other"`)
	check("a negated leaf names its field",
		explainPredicate(M{"not": M{"field": "status", "in": []any{"doing"}}}, record, fields), "the condition on status is not met")
	check("a negated compound names the record",
		explainPredicate(M{"not": M{"all": []any{M{"field": "status", "ne": "done"}}}}, record, fields), "the condition on the record is not met")
	check("isBlank on an absent field", evaluatePredicate(M{"field": "due", "isBlank": true}, record, fields), true)
	boolFields := []M{{"name": "done", "type": "boolean"}}
	check("boolean compares by declared type, not storage shape",
		evaluatePredicate(M{"field": "done", "eq": true}, M{"id": "x", "done": "true"}, boolFields), true)
	check("unknown predicate form refuses", evaluatePredicate(M{"field": "status"}, record, fields), false)

	// 3. Fingerprint: stable, and moved by anything describe publishes.
	base := map[string]M{"tasks": {"fields": fields, "module": "planning"}}
	check("fingerprint is deterministic", schemaFingerprint(base, nil), schemaFingerprint(base, nil))
	if schemaFingerprint(base, nil) == schemaFingerprint(map[string]M{"tasks": {"fields": fields, "module": "other"}}, nil) {
		failures = append(failures, "fingerprint ignores an entity's module")
	}
	if schemaFingerprint(base, []M{{"name": "op", "params": M{}}}) ==
		schemaFingerprint(base, []M{{"name": "op", "params": M{"x": M{"type": "string"}}}}) {
		failures = append(failures, "fingerprint ignores operation params")
	}

	// 4. JavaScript semantics: what the reference's language decides.
	numbers := []string{}
	for _, s := range []string{"", " 12 ", "0x1A", "0b101", "0o17", "1e3", "Infinity", "-Infinity", "+Infinity", "inf",
		"NaN", "1_000", ".5", "5.", "-0x1A", "\u00a012\ufeff", "1e400", "0x", "abc"} {
		numbers = append(numbers, jsNumberString(jsNumber(s)))
	}
	check("Number() reads text as JavaScript does", numbers, []string{"0", "12", "26", "5", "15", "1000", "Infinity",
		"-Infinity", "Infinity", "NaN", "NaN", "NaN", "0.5", "5", "NaN", "12", "Infinity", "NaN", "NaN"})
	tenth, fifth := 0.1, 0.2
	printed := []string{}
	for _, f := range []float64{1e21, 1e-7, 0.000001, math.Copysign(0, -1), 123.456, 5e-324, 100, tenth + fifth, 1e20, -1.5e-10, math.MaxFloat64} {
		printed = append(printed, jsNumberString(f))
	}
	check("a number prints as JavaScript prints it", printed, []string{"1e+21", "1e-7", "0.000001", "0", "123.456", "5e-324",
		"100", "0.30000000000000004", "100000000000000000000", "-1.5e-10", "1.7976931348623157e+308"})
	jcsArgs := M{
		"title":  "Ship \"it\"\n\u0001é😀",
		"n":      []any{1e21, 1e-7, 0.000001, math.Copysign(0, -1), 123.456, 5e-324, 100.0, tenth + fifth},
		"nested": M{"b": true, "a": nil, "é": 1.0, "Z": 2.0, "10": 3.0, "9": 4.0},
	}
	check("RFC 8785 canonical JSON, as adapter-core writes it", canonicalize(jcsArgs),
		`{"n":[1e+21,1e-7,0.000001,0,123.456,5e-324,100,0.30000000000000004],"nested":{"10":3,"9":4,"Z":2,"a":null,"b":true,"é":1},"title":"Ship \"it\"\n\u0001é😀"}`)
	check("the approval key is adapter-core's", approvalKey("clear-done", jcsArgs), "050ee01259323efe2d3ab3ea30ff98c09f7d8327bb518fa498f7f2f9b8083845")
	check("…with no arguments too", approvalKey("clear-done", nil), "7d745c845ebc004f343ea667d5b6e711ae3a8b842858cb0e79e4d3026519c00c")
	check("an occurrence's dedup key is adapter-core's",
		"sha256:"+sha256Hex(canonicalize(M{"type": "task.needs_triage", "capability": "triage", "payload": M{"task": "t1"}, "principal": "usr_a"})),
		"sha256:2d0816034520f2e325a3dc59dc62a9d7716359739eacabb8076d992db9e4ca9e")
	nullBody, _ := ParseBody([]byte("null"))
	blankBody, _ := ParseBody([]byte(" \n"))
	arrayBody, _ := ParseBody([]byte(`["x"]`))
	junkBody, _ := ParseBody([]byte("{nope"))
	trailingBody, _ := ParseBody([]byte("{} x"))
	hugeBody, _ := ParseBody([]byte(`{"n":1e400}`))
	check("a body reads as JSON.parse reads it",
		[]any{nullBody == nil, blankBody == nil, viewBody(arrayBody, nil).keys, junkBody, hasKey(trailingBody.(M), "__unparsed__"), math.IsInf(numberOf(hugeBody.(M)["n"]), 1)},
		[]any{true, true, []string{"0"}, M{"__unparsed__": "{nope"}, true, true})
	decoded, _ := decodeURIComponent("a%2Fb%20c")
	_, badUTF8 := decodeURIComponent("%FF")
	_, badEscape := decodeURIComponent("%zz")
	check("decodeURIComponent decodes every escape and refuses a malformed one",
		[]any{decoded, badUTF8 != nil, badEscape != nil}, []any{"a/b c", true, true})
	check("a query reads as URLSearchParams reads it", parseQuery("a=1&a=2&b=x+y&c=%zz&d"),
		map[string]string{"a": "2", "b": "x y", "c": "%zz", "d": ""})
	check("JSON.stringify writes a non-finite number as null", stableJSON(M{"x": math.Inf(1), "y": []any{math.NaN()}}), `{"x":null,"y":[null]}`)
	bounded := boundAppText(strings.Repeat("x", 400))
	check("text an app forwards to an agent is one bounded line",
		[]any{boundAppText("a\n\n  b "), jsLength(bounded), strings.HasSuffix(bounded, " [truncated by adapter, 138 chars cut]")},
		[]any{"a b", 300, true})

	// 5. Referential deletes: the rule an app declares with a `ref` binds the
	//    generic record route, not just whatever operation the app wrote.
	invoiceFields := []M{
		{"name": "client", "type": "ref", "entity": "clients"},
		{"name": "projects", "type": "list<ref>", "entity": "projects"},
	}
	scanApp := func(invoices []M) *Adapter {
		app, err := NewAdapter(AdapterConfig{AppID: "scan", Store: NewStore(nil), Modules: []M{{"name": "sales"}}, Entities: []M{
			{"name": "clients", "module": "sales", "fields": []M{{"name": "name", "type": "string"}}},
			{"name": "projects", "module": "sales", "fields": []M{{"name": "title", "type": "string"}}},
			{"name": "invoices", "module": "sales", "fields": invoices},
		}})
		if err != nil {
			panic(err)
		}
		app.store.putRecord("clients", M{"id": "c_acme"})
		app.store.putRecord("clients", M{"id": "c_unused"})
		app.store.putRecord("projects", M{"id": "p_one"})
		app.store.putRecord("invoices", M{"id": "inv_1", "client": "c_acme", "projects": []any{"p_one"}})
		return app
	}
	ad := scanApp(invoiceFields)
	check("a referenced record reports who blocks it", ad.referencesTo("clients", "c_acme"),
		[]M{{"entity": "invoices", "field": "client", "ids": []string{"inv_1"}}})
	check("an unreferenced record blocks nothing", ad.referencesTo("clients", "c_unused"), []M{})
	check("a reference held in a list counts too", ad.referencesTo("projects", "p_one"),
		[]M{{"entity": "invoices", "field": "projects", "ids": []string{"inv_1"}}})
	adIgnoring := scanApp([]M{{"name": "client", "type": "ref", "entity": "clients", "onDelete": "ignore"}, invoiceFields[1]})
	check(`onDelete "ignore" removes the block`, adIgnoring.referencesTo("clients", "c_acme"), []M{})
	check("and leaves the other ref guarded", adIgnoring.referencesTo("projects", "p_one"),
		[]M{{"entity": "invoices", "field": "projects", "ids": []string{"inv_1"}}})

	// 6. Listing: the filter grammar (refused, never ignored, outside it), and
	//    sorting and paging exactly as the reference binding does them.
	fltStore := NewStore(nil)
	fltStore.putRecord("tasks", M{"id": "a", "title": "Ship it", "status": "todo"})
	fltStore.putRecord("tasks", M{"id": "b", "title": "Other work", "status": "done"})
	fltStore.putRecord("tasks", M{"id": "c", "title": "Unsorted"})
	listed := func(query M) []any {
		result, err := fltStore.listRecords("tasks", query)
		if err != nil {
			return []any{"<error: " + err.Error() + ">"}
		}
		ids := []string{}
		for _, r := range toMList(result["items"]) {
			ids = append(ids, getStr(r, "id"))
		}
		return []any{ids, stableJSON(result["page"]), stableJSON(result["perPage"]), result["totalItems"]}
	}
	check("filter: equality", listed(M{"filter": `status = "todo"`})[0], []string{"a"})
	check("filter: negation", listed(M{"filter": `status != "todo"`})[0], []string{"b", "c"})
	check("filter: contains", listed(M{"filter": `title ~ "Ship"`})[0], []string{"a"})
	if _, err := fltStore.listRecords("tasks", M{"filter": `status = "todo" && title ~ "x"`}); err == nil {
		failures = append(failures, "an unsupported filter expression was silently accepted")
	} else {
		var unsupported *UnsupportedFilter
		if !errors.As(err, &unsupported) {
			failures = append(failures, "an unsupported filter raised the wrong error: "+err.Error())
		}
	}
	check("a missing value sorts first", listed(M{"sort": "status"})[0], []string{"c", "b", "a"})
	check("…and last descending", listed(M{"sort": "-status"})[0], []string{"a", "b", "c"})
	check("no paging asked: every record, one page", listed(M{}), []any{[]string{"a", "b", "c"}, "1", "3", 3})
	check("perPage=0 is an empty page", listed(M{"perPage": 0.0}), []any{[]string{}, "1", "0", 3})
	check("perPage that is not a number is an empty page", listed(M{"perPage": math.NaN()}), []any{[]string{}, "1", "null", 3})
	check("page=0 is an empty page", listed(M{"page": 0.0, "perPage": 2.0}), []any{[]string{}, "0", "2", 3})
	check("a fractional page size pages as slice() does", listed(M{"page": 2.0, "perPage": 1.5})[0], []string{"b", "c"})

	// 7. The SQLite store: records, credentials, accounts, idempotency keys,
	//    approvals, tasks, events and the audit log all survive a restart
	//    (reopening the same file), and keys expire when they should.
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
			first.idempotencyPut("tasks", "key-1", "t1")
			first.putGrant(Grant{CredentialID: "cred_a", TokenHash: hashSecret("token-a"), Principal: "owner", Scopes: []string{"*"}})
			first.putAuthRow(tableUsers, "usr_a", Account{ID: "usr_a", Login: "a", Role: "member", Active: true})
			first.approvalIssue("approval-1")
			fired, _ := first.trigger("task.review", M{"task": "t1"}, "review")
			first.appendAudit(AuditEntry{At: nowISO(), Target: "data:tasks", Outcome: "ok"})
			check("sqlite get returns what was put", getStr(first.getRecord("tasks", "t1"), "title"), "persisted")
			check("a task gets a random id", regexp.MustCompile(`^tsk_[0-9a-f]{16}$`).MatchString(toStr(fired["taskId"])), true)
			check("…and an event too", regexp.MustCompile(`^evt_[0-9a-f]{16}$`).MatchString(toStr(fired["eventId"])), true)
			first.Close()

			second, err := NewSqliteStore(dbPath, nil)
			if err != nil {
				failures = append(failures, "could not reopen the sqlite store: "+err.Error())
			} else {
				check("an existing database refuses the seed", second.WantsSeed, false)
				check("records survive a restart", getStr(second.getRecord("tasks", "t1"), "title"), "persisted")
				produced, found := second.idempotencyGet("tasks", "key-1")
				check("idempotency keys survive a restart", []any{produced, found}, []any{"t1", true})
				restored := second.grantByTokenHash(hashSecret("token-a"))
				check("credentials survive a restart, found by their token's hash", restored != nil && restored.CredentialID == "cred_a", true)
				var account Account
				check("accounts survive a restart", second.authRow(tableUsers, "usr_a", &account) && account.Login == "a", true)
				check("tasks survive a restart", second.getTask(toStr(fired["taskId"])) != nil, true)
				events, cursor := second.eventsSince("")
				check("events survive a restart", []any{len(events), cursor}, []any{1, "1"})
				refired, _ := second.trigger("task.review", M{"task": "t1"}, "review")
				check("…and so does dedup: the same occurrence is the same task", refired["taskId"], fired["taskId"])
				newer, next := second.eventsSince(cursor)
				check("…and the sequence: a saved cursor reads only what is newer", []any{len(newer), next}, []any{1, "2"})
				check("approval keys survive a restart", second.approvalConsume("approval-1"), true)
				check("…and are used once", second.approvalConsume("approval-1"), false)
				check("the audit log survives a restart", len(second.auditTail(10)), 1)
				second.putGrant(Grant{CredentialID: "cred_a", TokenHash: hashSecret("token-b"), Principal: "owner", Scopes: []string{"*"}})
				check("a rotated token replaces the old one", second.grantByTokenHash(hashSecret("token-a")) == nil, true)
				check("…with the new one in force", second.grantByTokenHash(hashSecret("token-b")) != nil, true)
				check("an updated grant keeps one row", len(second.listGrants()), 1)
				check("delete removes the row", second.deleteRecord("tasks", "t1"), true)
				check("a second delete reports not-found", second.deleteRecord("tasks", "t1"), false)

				clock := time.Now()
				second.now = func() time.Time { return clock }
				second.approvalIssue("approval-2")
				clock = clock.Add(approvalTTL + time.Second)
				check("an approval key expires after ten minutes", second.approvalConsume("approval-2"), false)
				second.idempotencyPut("tasks", "key-2", "t2")
				clock = clock.Add(idempotencyTTL + time.Second)
				_, found = second.idempotencyGet("tasks", "key-2")
				check("an idempotency key expires after a day", found, false)
				second.Close()
			}
		}
	}
	rings := NewStore(nil)
	for i := 0; i < eventRetention+3; i++ {
		rings.appendEvent("tick", M{})
		rings.appendAudit(AuditEntry{At: nowISO(), Target: "rate:data", Outcome: "rejected"})
	}
	ringEvents, ringCursor := rings.eventsSince("0")
	check("the event log keeps the last 5000, numbering on", []any{len(ringEvents), ringEvents[0].Seq, ringCursor},
		[]any{eventRetention, int64(4), strconv.Itoa(eventRetention + 3)})
	check("the audit log keeps the last 5000", len(rings.auditTail(2*auditRetention)), auditRetention)
	stillThere, _ := rings.eventsSince("abc")
	check("a cursor that is not one reads from the beginning", len(stillThere), eventRetention)

	// 8. Host and network policy: the app answers only to loopback and its own
	//    origins (the public URL among them), on every path, and refuses to
	//    listen where the agent token would cross a network in clear.
	if hostApp, err := NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Token: "t", Modules: []M{{"name": "core"}},
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
		foreign := map[string]string{"host": "evil.example.com"}
		for _, path := range []string{"/api/_a2app", "/", "/_a2app/account", "/no-such-page"} {
			status, reply, _, handled := hostApp.Handle(Request{Method: "GET", Path: path, Headers: foreign})
			check("a foreign host is refused on "+path, []any{status, reply["code"], handled}, []any{403, "forbidden_host", true})
		}
		_, _, _, handled := hostApp.Handle(Request{Method: "GET", Path: "/index.html", Headers: map[string]string{"host": "127.0.0.1:9931"}})
		check("a path that is not the adapter's is left to the View", handled, false)
		check("a request naming no host is answered", statusOf(call(hostApp, "GET", "/api/_a2app", nil, nil)), 200)
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
	check("…without a default port", policy("", "https://crm.example.com:443/x"), "127.0.0.1 https://crm.example.com")
	check("…keeping any other", policy("", "https://crm.example.com:8443"), "127.0.0.1 https://crm.example.com:8443")
	check("a non-loopback bind needs a public URL", policy("0.0.0.0", ""), "refused")
	check("…an https one", policy("0.0.0.0", "http://localhost:8080"), "refused")
	check("a non-loopback bind behind https is allowed", policy("0.0.0.0", "https://crm.example.com"), "0.0.0.0 https://crm.example.com")
	check("a plain-http public name is refused", policy("", "http://crm.example.com"), "refused")
	check("a plain-http tunnel to loopback is allowed", policy("", "http://localhost:9000"), "127.0.0.1 http://localhost:9000")
	check("a public URL that is not a URL is refused", policy("", "crm.example.com"), "refused")

	// 9. Auth primitives (spec/v0_2/auth.md): what a secret looks like, how a
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
	rateClock := int64(0)
	rates := newRateLimiter(map[string]int{"data": 1}, func() int64 { return rateClock })
	rates.check("anon", "data")
	rateClock = 500
	check("a rate refusal rounds its wait up", rates.check("anon", "data").retryAfterSeconds, 60)
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

	// 10. The resolution order and the ceiling, through Handle on a multi-user
	//     app: each refusal, effective scopes, ownership through a credential
	//     and a session, CSRF, task credentials, and device sign-in.
	notes := []M{{"name": "notes", "module": "core", "ownedBy": "owner", "fields": []M{
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
		as := func(token string) map[string]string { return map[string]string{"x-a2app-token": token} }
		alice := Account{ID: "usr_alice", Name: "Alice", Login: "alice", Role: "owner", Active: true, CreatedAt: nowISO()}
		bob := Account{ID: "usr_bob", Name: "Bob", Login: "bob", Role: "member", Active: true, CreatedAt: nowISO()}
		authApp.store.putAuthRow(tableUsers, alice.ID, alice)
		authApp.store.putAuthRow(tableUsers, bob.ID, bob)
		aliceToken, _ := authApp.mintCredential(alice.ID, "", []string{"*"}, 3600, "")
		bobToken, bobGrant := authApp.mintCredential(bob.ID, "suite", []string{"*"}, 3600, "")

		_, identity := call(authApp, "GET", "/api/_a2app", nil, nil)
		check("identity speaks 0.2 and says how people sign in",
			[]any{identity["protocol"], identity["authMode"], identity["accountUrl"]}, []any{"0.2", "multi-user", "/_a2app/account"})
		_, admin := call(authApp, "GET", "/api/_a2app/whoami", as("admin-token"), nil)
		check("the admin credential acts as the owner", []any{admin["principal"], admin["role"], admin["scopes"]},
			[]any{"owner", "owner", []string{"data:notes:read", "data:notes:write", "op:review-note"}})
		_, who := call(authApp, "GET", "/api/_a2app/whoami", as(bobToken), nil)
		check("a `*` credential is held to its person's permissions",
			[]any{who["principal"], who["principalName"], who["role"], who["scopes"]},
			[]any{"usr_bob", "Bob", "member", []string{"data:notes:read", "op:review-note"}})
		check("…so it cannot write", codeOf(call(authApp, "POST", "/api/collections/notes/records", as(bobToken), M{"title": "x"})), codeInsufficientScope)
		_, created := call(authApp, "POST", "/api/collections/notes/records", as(aliceToken), M{"title": "Alice's"})
		check("a record is owned by whoever created it", created["owner"], "usr_alice")
		check("the owner field is the adapter's to write",
			codeOf(call(authApp, "POST", "/api/collections/notes/records", as(aliceToken), M{"title": "x", "owner": "usr_bob"})), codeReadOnlyField)
		_, listedNotes := call(authApp, "GET", "/api/collections/notes/records", as(bobToken), nil)
		check("a member does not list another's records", len(toMList(listedNotes["items"])), 0)
		check("…nor read one by id", statusOf(call(authApp, "GET", "/api/collections/notes/records/"+getStr(created, "id"), as(bobToken), nil)), 404)
		check("an unknown token is refused", codeOf(call(authApp, "GET", "/api/_a2app/whoami", as("a2a_nonsense"), nil)), "credential_invalid")
		check("an agent's credential manages nothing", codeOf(call(authApp, "GET", "/api/_a2app/credentials", as(bobToken), nil)), "not_a_manager")

		bob.Active = false
		authApp.store.putAuthRow(tableUsers, bob.ID, bob)
		check("deactivating a person stops their agents", codeOf(call(authApp, "GET", "/api/_a2app/whoami", as(bobToken), nil)), "principal_inactive")
		bob.Active = true
		authApp.store.putAuthRow(tableUsers, bob.ID, bob)
		check("…and reactivating restores them", statusOf(call(authApp, "GET", "/api/_a2app/whoami", as(bobToken), nil)), 200)

		authApp.store.putAuthRow(tableSessions, hashSecret("bob-session"), sessionRow{
			Principal: bob.ID, CreatedAt: nowISO(), ExpiresAt: isoOf(time.Now().Add(time.Hour)),
		})
		session := map[string]string{"cookie": "a2app_session_selftest=bob-session", "origin": "http://127.0.0.1:9931"}
		_, sessionWho := call(authApp, "GET", "/api/_a2app/whoami", session, nil)
		check("a session acts as its person, within their permissions",
			[]any{sessionWho["credentialId"], sessionWho["principal"], sessionWho["scopes"]},
			[]any{"session", "usr_bob", []string{"data:notes:read", "op:review-note"}})
		check("a signed-in change needs the app's own Origin",
			codeOf(call(authApp, "POST", "/api/collections/notes/records", map[string]string{"cookie": session["cookie"]}, M{"title": "x"})), "forbidden_origin")
		check("a stranger is told to bring a credential",
			codeOf(call(authApp, "GET", "/api/collections/notes/records", nil, nil)), codeAgentTokenRequired)
		check("…and the app's own page to sign in",
			codeOf(call(authApp, "GET", "/api/collections/notes/records", map[string]string{"sec-fetch-site": "same-origin"}, nil)), "sign_in_required")

		_, ran := call(authApp, "POST", "/api/ops/review-note", session, M{"note": getStr(created, "id")})
		fired, _ := ran["result"].(M)
		taskID := toStr(fired["taskId"])
		_, task := call(authApp, "GET", "/api/_a2app/tasks/"+taskID, as("admin-token"), nil)
		request, _ := task["request"].(M)
		check("a task records who called the runner that queued it", request["principal"], "usr_bob")
		appFired, _ := authApp.trigger("note.review", M{"note": "app"}, "review")
		_, appTask := call(authApp, "GET", "/api/_a2app/tasks/"+toStr(appFired["taskId"]), as("admin-token"), nil)
		appRequest, _ := appTask["request"].(M)
		check("work the app queues itself records nobody", hasKey(appRequest, "principal") && appRequest["principal"] == nil, true)
		check("a member cannot issue a task's credential",
			codeOf(call(authApp, "POST", "/api/_a2app/tasks/"+taskID+"/credential", session, nil)), "not_a_manager")
		taskStatus, taskCred := call(authApp, "POST", "/api/_a2app/tasks/"+taskID+"/credential", as("admin-token"), M{"agentName": "bridge"})
		credential, _ := taskCred["credential"].(M)
		check("the admin credential issues it, for that person, the capability's scopes, and that task",
			[]any{taskStatus, credential["principal"], credential["scopes"], credential["task"]},
			[]any{201, "usr_bob", []string{"data:notes:read"}, taskID})
		taskToken := getStr(taskCred, "token")
		check("…and it works while the task is open", statusOf(call(authApp, "GET", "/api/_a2app/whoami", as(taskToken), nil)), 200)
		openTask := authApp.store.getTask(taskID)
		openTask.Status = "completed"
		authApp.store.saveTask(openTask)
		check("…and is dead once the task is over", codeOf(call(authApp, "GET", "/api/_a2app/whoami", as(taskToken), nil)), "credential_revoked")
		check("…and none is issued for a finished task",
			codeOf(call(authApp, "POST", "/api/_a2app/tasks/"+taskID+"/credential", as("admin-token"), nil)), codeTaskNotClaimable)

		// Who reaches a task (spec §6.3): an owner every task, a task credential
		// its own, anyone else the tasks they asked for.
		carol := Account{ID: "usr_carol", Name: "Carol", Login: "carol", Role: "member", Active: true, CreatedAt: nowISO()}
		authApp.store.putAuthRow(tableUsers, carol.ID, carol)
		authApp.store.putAuthRow(tableSessions, hashSecret("carol-session"), sessionRow{
			Principal: carol.ID, CreatedAt: nowISO(), ExpiresAt: isoOf(time.Now().Add(time.Hour)),
		})
		carolSession := map[string]string{"cookie": "a2app_session_selftest=carol-session", "origin": "http://127.0.0.1:9931"}
		queue := func(headers map[string]string, note string) string {
			_, ran := call(authApp, "POST", "/api/ops/review-note", headers, M{"note": note})
			fired, _ := ran["result"].(M)
			return toStr(fired["taskId"])
		}
		bobs := queue(session, getStr(created, "id"))
		check("once a task is finished, the same request queues a new one", bobs != "" && bobs != taskID, true)
		carols := queue(carolSession, "c")
		check("…while one still open is joined", queue(carolSession, "c"), carols)
		listed := func(headers map[string]string) map[string]bool {
			_, reply := call(authApp, "GET", "/api/_a2app/tasks", headers, nil)
			ids := map[string]bool{}
			for _, t := range toMList(reply["tasks"]) {
				ids[getStr(t, "id")] = true
			}
			return ids
		}
		appTaskID := toStr(appFired["taskId"])
		byOwner, byBob := listed(as(aliceToken)), listed(session)
		check("an owner lists every task", []bool{byOwner[bobs], byOwner[carols], byOwner[appTaskID]}, []bool{true, true, true})
		check("a member lists only the tasks they asked for", []bool{byBob[bobs], byBob[carols], byBob[appTaskID]}, []bool{true, false, false})
		check("…another's answers as one that does not exist, to read, cancel or claim",
			[]any{codeOf(call(authApp, "GET", "/api/_a2app/tasks/"+carols, session, nil)),
				codeOf(call(authApp, "POST", "/api/_a2app/tasks/"+carols+"/cancel", session, nil)),
				codeOf(call(authApp, "POST", "/api/_a2app/tasks/"+carols+"/claim", session, nil))},
			[]any{codeTaskNotFound, codeTaskNotFound, codeTaskNotFound})
		check("…while their own is theirs to read", statusOf(call(authApp, "GET", "/api/_a2app/tasks/"+bobs, session, nil)), 200)
		check("the bridge claims Carol's task", statusOf(call(authApp, "POST", "/api/_a2app/tasks/"+carols+"/claim", as("admin-token"), nil)), 200)
		_, carolsCred := call(authApp, "POST", "/api/_a2app/tasks/"+carols+"/credential", as("admin-token"), nil)
		carolsRun := as(getStr(carolsCred, "token"))
		check("a task credential reaches its own task", statusOf(call(authApp, "GET", "/api/_a2app/tasks/"+carols, carolsRun, nil)), 200)
		check("…and no other", codeOf(call(authApp, "GET", "/api/_a2app/tasks/"+bobs, carolsRun, nil)), codeTaskNotFound)
		check("…nor lists any other", listed(carolsRun), map[string]bool{carols: true})
		check("the person who asked cannot report on a run they do not hold",
			codeOf(call(authApp, "POST", "/api/_a2app/tasks/"+carols+"/complete", carolSession, M{"status": "completed", "result": M{}})), codeTaskNotHeld)
		refusal := authApp.store.auditTail(1)[0]
		check("…which is audited", []any{refusal.Target, refusal.Outcome, refusal.Code}, []any{"task:complete", "rejected", codeTaskNotHeld})
		check("…but can cancel it", statusOf(call(authApp, "POST", "/api/_a2app/tasks/"+carols+"/cancel", carolSession, nil)), 200)
		check("a member who claims their own task holds it, and reports on it",
			[]any{statusOf(call(authApp, "POST", "/api/_a2app/tasks/"+bobs+"/claim", session, nil)),
				statusOf(call(authApp, "POST", "/api/_a2app/tasks/"+bobs+"/progress", session, M{"step": "reading"})),
				statusOf(call(authApp, "POST", "/api/_a2app/tasks/"+bobs+"/complete", session, M{"status": "completed", "result": M{}}))},
			[]any{200, 200, 200})

		// Device sign-in (spec §7): approving hands over nothing by itself.
		start := func(body M) M {
			_, reply := call(authApp, "POST", "/api/_a2app/auth/device", nil, body)
			return reply
		}
		poll := func(deviceCode string, confirmation any) any {
			body := M{"deviceCode": deviceCode}
			if confirmation != nil {
				body["confirmation"] = confirmation
			}
			return codeOf(call(authApp, "POST", "/api/_a2app/auth/token", nil, body))
		}
		approve := func(userCode string) M {
			_, reply := call(authApp, "POST", "/api/_a2app/auth/device/"+userCode, session, M{"approve": true})
			return reply
		}
		started := start(M{"agentName": "device", "scopes": []any{"data:notes:read"}})
		deviceCode, userCode := getStr(started, "deviceCode"), getStr(started, "userCode")
		check("polling waits for the person", poll(deviceCode, nil), "authorization_pending")
		_, review := call(authApp, "GET", "/api/_a2app/auth/device/"+userCode, session, nil)
		check("the review says when it was asked, and that no agent waits on this computer",
			[]any{review["agentName"], regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T`).MatchString(getStr(review, "requestedAt")), review["loopback"]},
			[]any{"device", true, false})
		approval := approve(userCode)
		confirmation := getStr(approval, "confirmation")
		check("approval answers a confirmation code, with nowhere to send it",
			[]any{approval["status"], regexp.MustCompile(`^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`).MatchString(confirmation), approval["redirect"]},
			[]any{"approved", true, nil})
		check("approval alone hands nothing over", poll(deviceCode, nil), "confirmation_required")
		check("…nor does a wrong code", poll(deviceCode, "BBBB-BBBB"), "confirmation_invalid")
		_, granted := call(authApp, "POST", "/api/_a2app/auth/token", nil,
			M{"deviceCode": deviceCode, "confirmation": strings.ToLower(strings.ReplaceAll(confirmation, "-", ""))})
		grantedCredential, _ := granted["credential"].(M)
		check("the right code, in any case, dash optional, gets the credential",
			[]any{grantedCredential["principal"], grantedCredential["scopes"]}, []any{"usr_bob", []string{"data:notes:read"}})
		check("…once", poll(deviceCode, confirmation), "expired_token")
		guessed := start(M{})
		approve(getStr(guessed, "userCode"))
		for i := 0; i < deviceConfirmAttempts-1; i++ {
			poll(getStr(guessed, "deviceCode"), "BBBB-BBBB")
		}
		check("five wrong codes void the request", poll(getStr(guessed, "deviceCode"), "BBBB-BBBB"), "access_denied")
		check("a loopback port must be a real one",
			[]any{codeOf(call(authApp, "POST", "/api/_a2app/auth/device", nil, M{"loopbackPort": 80.0})),
				codeOf(call(authApp, "POST", "/api/_a2app/auth/device", nil, M{"loopbackPort": 8080.5})),
				codeOf(call(authApp, "POST", "/api/_a2app/auth/device", nil, M{"loopbackPort": "8080"}))},
			[]any{"usage", "usage", "usage"})
		local := start(M{"loopbackPort": 53682.0})
		_, localReview := call(authApp, "GET", "/api/_a2app/auth/device/"+getStr(local, "userCode"), session, nil)
		check("an agent on the person's computer is shown as such", localReview["loopback"], true)
		sent := approve(getStr(local, "userCode"))
		check("approval sends the browser back to the agent's port with the code", sent["redirect"],
			"http://127.0.0.1:53682/a2app/callback?confirmation="+getStr(sent, "confirmation"))

		authApp.store.updateGrant(bobGrant.CredentialID, func(g *Grant) { g.ExpiresAt = isoOf(time.Now().Add(-time.Second)) })
		check("an expired credential says so", codeOf(call(authApp, "GET", "/api/_a2app/whoami", as(bobToken), nil)), "token_expired")
		aliceGrant := authApp.store.grantByTokenHash(hashSecret(aliceToken))
		check("a credential revokes itself", statusOf(call(authApp, "DELETE", "/api/_a2app/credentials/"+aliceGrant.CredentialID, as(aliceToken), nil)), 200)
		check("…and is told so after", codeOf(call(authApp, "GET", "/api/_a2app/whoami", as(aliceToken), nil)), "credential_revoked")
		check("the admin credential cannot be revoked through the API",
			codeOf(call(authApp, "DELETE", "/api/_a2app/credentials/cred_local", as("admin-token"), nil)), "not_a_manager")
	}

	// 11. Declarations are checked at construction, and a single-user app has
	//     one principal and no accounts.
	_, err = NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Modules: []M{{"name": "core"}}, Entities: notes,
		Capabilities: map[string]M{"review": {"scopes": []string{"data:other:read"}}},
	})
	check("a capability's undeclared scope is refused at boot", err != nil && strings.Contains(err.Error(), `capability "review"`), true)
	_, err = NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Modules: []M{{"name": "core"}},
		Entities: []M{{"name": "notes", "module": "core", "ownedBy": "owner", "fields": []M{{"name": "owner", "type": "string"}}}},
	})
	check("ownedBy must name a readOnly string field", err != nil && strings.Contains(err.Error(), "must be a readOnly string field"), true)
	_, err = NewAdapter(AdapterConfig{
		AppID: "selftest", Store: NewStore(nil), Modules: []M{{"name": "core"}},
		Entities: []M{{"name": "notes", "module": "core"}, {"name": "notes", "module": "core"}, {"module": "core"}},
	})
	check("an entity is named once", err != nil && strings.Contains(err.Error(), `duplicate entity "notes"`) &&
		strings.Contains(err.Error(), `an entity declares no "name"`), true)
	check("an older schema.go's map of entities still declares them, by name",
		declaredEntities(map[string]M{"b": {"module": "core"}, "a": {"module": "core"}}),
		[]M{{"name": "a", "module": "core"}, {"name": "b", "module": "core"}})

	// 12. The single-user surface: operations (the argument guard, approval,
	//     idempotency, typed refusals), records (update idempotency, filters,
	//     escaped ids), the task lifecycle, events, viewers and describe — each
	//     as the reference answers it.
	soloStore := NewStore(map[string][]M{"notes": {{"id": "a/b", "title": "slash"}}})
	solo, err := NewAdapter(AdapterConfig{
		AppID: "solo", Store: soloStore, Token: "admin-token", Modules: []M{{"name": "core"}},
		// Declared out of name order: describe lists them as declared.
		Entities: []M{
			{"name": "notes", "module": "core", "ownedBy": "owner", "fields": []M{
				{"name": "title", "type": "string", "required": true},
				{"name": "tags", "type": "list<ref>", "entity": "labels"},
				{"name": "owner", "type": "string", "readOnly": true},
			}},
			{"name": "labels", "module": "core", "fields": []M{{"name": "name", "type": "string"}}},
		},
		Operations: []M{
			{"name": "wipe", "module": "core", "destructive": true, "params": M{}},
			{"name": "count", "module": "core", "readOnly": true, "params": M{}},
			{"name": "refuse", "module": "core", "params": M{}},
			{"name": "boom", "module": "core", "params": M{}},
			{"name": "queue", "module": "core", "params": M{}},
			{"name": "touch", "module": "core", "entity": "notes", "appliesWhen": M{"field": "title", "ne": "done"},
				"params": M{"note": M{"type": "ref", "entity": "notes", "required": true}}},
		},
		Runners: map[string]OperationRunner{
			"wipe":  func(M, M, *Store) (any, error) { return M{"wiped": true}, nil },
			"count": func(M, M, *Store) (any, error) { return M{"count": 1}, nil },
			"refuse": func(M, M, *Store) (any, error) {
				return nil, &OperationError{Code: "not_now", Message: "Not now.", HTTPStatus: 409, Extra: M{"retryAfter": 5}}
			},
			"boom":  func(M, M, *Store) (any, error) { panic("it broke") },
			"queue": func(_ M, _ M, store *Store) (any, error) { return store.trigger("work", M{"n": 1}, "work") },
			"touch": func(M, M, *Store) (any, error) { return M{"ok": true}, nil },
		},
		Events: []M{{"type": "work"}},
	})
	if err != nil {
		failures = append(failures, "could not build a single-user adapter: "+err.Error())
	} else {
		adminHeaders := map[string]string{"x-a2app-token": "admin-token"}
		with := func(extra map[string]string) map[string]string {
			out := map[string]string{"x-a2app-token": "admin-token"}
			for k, v := range extra {
				out[k] = v
			}
			return out
		}
		status, anonymous := call(solo, "GET", "/api/_a2app/whoami", nil, nil)
		check("a single-user app reads anonymously as the owner, read-only",
			[]any{status, anonymous["principal"], anonymous["scopes"]},
			[]any{200, "owner", []string{"data:labels:read", "data:notes:read", "op:count"}})
		check("…and needs a credential to write", statusOf(call(solo, "POST", "/api/collections/notes/records", nil, M{"title": "x"})), 401)
		_, stored := call(solo, "POST", "/api/collections/notes/records", adminHeaders, M{"title": "x"})
		check("…where every record is the owner's", stored["owner"], "owner")
		_, refusal := call(solo, "GET", "/api/_a2app/session", nil, nil)
		check("…and there are no accounts", refusal["code"], "not_multi_user")

		check("an operation's required parameter is enforced", codeOf(call(solo, "POST", "/api/ops/touch", adminHeaders, M{})), codeMissingRequired)
		check("…and an undeclared one refused", codeOf(call(solo, "POST", "/api/ops/touch", adminHeaders, M{"note": "a/b", "extra": 1.0})), codeUnknownField)
		check("…and one with none takes nothing", codeOf(call(solo, "POST", "/api/ops/wipe", adminHeaders, M{"x": 1.0})), codeUnknownField)
		asked, askedReply := call(solo, "POST", "/api/ops/wipe", adminHeaders, M{})
		check("a destructive operation asks for approval with the JCS key",
			[]any{asked, askedReply["approvalKey"]}, []any{428, sha256Hex(`{"args":{},"operation":"wipe"}`)})
		approved := with(map[string]string{"x-a2app-approval": getStr(askedReply, "approvalKey")})
		check("…which runs it once", []any{statusOf(call(solo, "POST", "/api/ops/wipe", approved, M{})), statusOf(call(solo, "POST", "/api/ops/wipe", approved, M{}))}, []any{200, 428})
		_, refused := call(solo, "POST", "/api/ops/refuse", adminHeaders, M{})
		check("a runner refuses in its own terms", []any{codeOf(call(solo, "POST", "/api/ops/refuse", adminHeaders, M{})), refused["retryAfter"], refused["message"]},
			[]any{"not_now", 5, "Not now."})
		check("…with its own status", statusOf(call(solo, "POST", "/api/ops/refuse", adminHeaders, M{})), 409)
		boomStatus, boomReply := call(solo, "POST", "/api/ops/boom", adminHeaders, M{})
		check("a runner that panics is operation_failed", []any{boomStatus, boomReply["code"], boomReply["message"]},
			[]any{500, "operation_failed", `Operation "boom" threw: it broke`})
		once := with(map[string]string{"idempotency-key": "op-1"})
		call(solo, "POST", "/api/ops/count", once, M{})
		_, again := call(solo, "POST", "/api/ops/count", once, M{})
		check("a repeated operation is duplicate_request", []any{again["code"], again["operation"]}, []any{codeDuplicateRequest, "count"})
		check("an escaped operation name is decoded", statusOf(call(solo, "POST", "/api/ops/co%75nt", adminHeaders, M{})), 200)

		patchOnce := with(map[string]string{"idempotency-key": "patch-1"})
		call(solo, "PATCH", "/api/collections/notes/records/"+getStr(stored, "id"), patchOnce, M{"title": "y"})
		_, patchAgain := call(solo, "PATCH", "/api/collections/notes/records/"+getStr(stored, "id"), patchOnce, M{"title": "y"})
		check("a repeated update is duplicate_request, naming the record", []any{patchAgain["code"], patchAgain["id"]},
			[]any{codeDuplicateRequest, stored["id"]})
		_, badFilter := call(solo, "GET", "/api/collections/notes/records?filter=title%20~~%20x", adminHeaders, nil)
		check("a filter it cannot honour is invalid_filter, naming it", []any{badFilter["code"], badFilter["got"]}, []any{codeInvalidFilter, "title ~~ x"})
		_, slashed := call(solo, "GET", "/api/collections/notes/records/a%2Fb", adminHeaders, nil)
		check("an escaped id is decoded after routing", slashed["title"], "slash")
		check("a malformed escape answers as the reference's does", codeOf(call(solo, "GET", "/api/collections/notes/records/%FF", adminHeaders, nil)), "adapter_error")
		nullStatus, nullReply := call(solo, "POST", "/api/collections/notes/records", adminHeaders, func() any { b, _ := ParseBody([]byte("null")); return b }())
		check("a null body is no body", []any{nullStatus, nullReply["code"]}, []any{400, codeMissingRequired})
		arrayStatus, _ := call(solo, "POST", "/api/collections/notes/records", adminHeaders, []any{})
		check("an array body is refused", arrayStatus, 400)

		_, queued := call(solo, "POST", "/api/ops/queue", adminHeaders, M{})
		result, _ := queued["result"].(M)
		taskID := toStr(result["taskId"])
		_, task := call(solo, "GET", "/api/_a2app/tasks/"+taskID, adminHeaders, nil)
		check("a task names its app, and starts with no progress", []any{task["app"], stableJSON(task["progress"])},
			[]any{"solo", `{"step":null,"percent":0}`})
		check("claiming as someone else is principal_mismatch",
			codeOf(call(solo, "POST", "/api/_a2app/tasks/"+taskID+"/claim", adminHeaders, M{"agent": "someone-else"})), "principal_mismatch")
		_, claimed := call(solo, "POST", "/api/_a2app/tasks/"+taskID+"/claim", adminHeaders, M{"agent": "cred_local"})
		check("…and as itself works", claimed["status"], "working")
		_, asking := call(solo, "POST", "/api/_a2app/tasks/"+taskID+"/progress", adminHeaders, M{"ask": nil})
		check("an ask, even null, waits for input", asking["status"], "input-required")
		_, done := call(solo, "POST", "/api/_a2app/tasks/"+taskID+"/complete", adminHeaders, M{"status": "completed", "result": false})
		check("a result is kept as given, false included", []any{done["status"], done["result"]}, []any{"completed", false})
		check("a finished task cannot be canceled", codeOf(call(solo, "POST", "/api/_a2app/tasks/"+taskID+"/cancel", adminHeaders, M{})), codeTaskNotClaimable)
		_, fromStart := call(solo, "GET", "/api/_a2app/events", adminHeaders, nil)
		_, fromJunk := call(solo, "GET", "/api/_a2app/events?since=abc", adminHeaders, nil)
		check("events name their app, and a junk cursor reads from the beginning",
			[]any{firstOf(toMList(fromStart["events"]))["app"], len(toMList(fromJunk["events"])), fromJunk["nextCursor"]},
			[]any{"solo", len(toMList(fromStart["events"])), fromStart["nextCursor"]})
		tail := solo.store.auditTail(50)
		targets := map[string]bool{}
		for _, entry := range tail {
			targets[entry.Target+" "+entry.Outcome] = true
		}
		check("writes, operations and task actions are audited",
			[]bool{targets["data:notes ok"], targets["op:wipe ok"], targets["op:refuse rejected"], targets["task:claim rejected"], targets["task:complete ok"]},
			[]bool{true, true, true, true, true})

		call(solo, "GET", "/api/_a2app", map[string]string{"x-a2app-viewer": "tab-1"}, nil)
		_, watching := call(solo, "GET", "/api/_a2app/viewers", adminHeaders, nil)
		call(solo, "POST", "/api/_a2app?viewer=tab-1&leaving=1", nil, nil)
		_, left := call(solo, "GET", "/api/_a2app/viewers", adminHeaders, nil)
		check("an open tab is counted until it says goodbye", []any{watching["viewers"], watching["ttlMs"], left["viewers"]}, []any{1, int64(60000), 0})

		_, module := call(solo, "GET", "/api/_a2app/describe/core", nil, nil)
		names := []string{}
		for _, e := range toMList(module["entities"]) {
			names = append(names, getStr(e, "name"))
		}
		check("describe lists entities in declaration order", names, []string{"notes", "labels"})
		_, recordLevel := call(solo, "GET", "/api/_a2app/describe/core/notes/a%2Fb", adminHeaders, nil)
		check("a record's operation names the parameter that takes the record", firstOf(toMList(recordLevel["operations"]))["targetParam"], "note")
		_, relation := call(solo, "GET", "/api/_a2app/describe/core/notes/a%2Fb/nope", adminHeaders, nil)
		check("an unknown relation lists the real ones", []any{relation["code"], relation["relations"]}, []any{"unknown_relation", []string{"tags"}})

		solo.limiter = newRateLimiter(map[string]int{"data": 1, "ops": 1}, func() int64 { return 0 })
		call(solo, "GET", "/api/collections/notes/records", adminHeaders, nil)
		limitedStatus, limitedReply := call(solo, "GET", "/api/collections/notes/records", adminHeaders, nil)
		check("over the limit is 429, with a whole number of seconds to wait",
			[]any{limitedStatus, limitedReply["code"], limitedReply["retryAfterSeconds"]}, []any{429, codeRateLimited, 60})
		target, recorded := "", ""
		if refusals := solo.store.auditTail(1); len(refusals) == 1 && refusals[0].CredentialID != nil {
			target, recorded = refusals[0].Target, *refusals[0].CredentialID
		}
		check("…audited under the token's hash, never the token", []any{target, recorded},
			[]any{"rate:data", "token:" + hashSecret("admin-token")})
	}

	// 13. The root screen fits its budget: summaries go first, then rows, with
	//     the count reported and ?all=true returning everything.
	wide := []M{}
	for i := 0; i < 40; i++ {
		wide = append(wide, M{"name": fmt.Sprintf("module-%02d", i), "summary": strings.Repeat("a long summary ", 7)})
	}
	if wideApp, err := NewAdapter(AdapterConfig{AppID: "wide", Store: NewStore(nil), Modules: wide}); err != nil {
		failures = append(failures, "could not build a wide adapter: "+err.Error())
	} else {
		_, trimmed := call(wideApp, "GET", "/api/_a2app/describe", nil, nil)
		_, everything := call(wideApp, "GET", "/api/_a2app/describe?all=true", nil, nil)
		rows := toMList(trimmed["modules"])
		check("an overflowing root drops summaries, then rows, and says so",
			[]any{len(rows)+intOf(trimmed["truncated"]) == 40, hasKey(firstOf(rows), "summary"), levelSize(trimmed) <= describeBudgetChars,
				contains(scopeList(trimmed["next"]), "describe?all=true"), len(toMList(everything["modules"]))},
			[]any{true, false, true, true, 40})
	}

	// 14. A restart, end to end: a task and its credential, an event cursor and
	//     an approval key issued before it all hold after it, and a new task
	//     gets a new id.
	if restartDir, err := os.MkdirTemp("", "a2app-restart-"); err == nil {
		defer os.RemoveAll(restartDir)
		boot := func() (*Adapter, *Store) {
			store, err := NewSqliteStore(filepath.Join(restartDir, "db.sqlite"), nil)
			if err != nil {
				panic(err)
			}
			app, err := NewAdapter(AdapterConfig{
				AppID: "restart", Store: store, Token: "admin-token", Modules: []M{{"name": "core"}},
				Operations: []M{
					{"name": "queue", "module": "core", "params": M{"n": M{"type": "number"}}},
					{"name": "wipe", "module": "core", "destructive": true, "params": M{}},
				},
				Runners: map[string]OperationRunner{
					"queue": func(args M, _ M, store *Store) (any, error) { return store.trigger("work", args, "work") },
					"wipe":  func(M, M, *Store) (any, error) { return M{"wiped": true}, nil },
				},
				Events: []M{{"type": "work"}},
			})
			if err != nil {
				panic(err)
			}
			return app, store
		}
		admin := map[string]string{"x-a2app-token": "admin-token"}
		before, store := boot()
		_, queued := call(before, "POST", "/api/ops/queue", admin, M{"n": 1.0})
		taskID := toStr(queued["result"].(M)["taskId"])
		_, minted := call(before, "POST", "/api/_a2app/tasks/"+taskID+"/credential", admin, M{})
		_, events := call(before, "GET", "/api/_a2app/events", admin, nil)
		_, asked := call(before, "POST", "/api/ops/wipe", admin, M{})
		store.Close()

		after, store := boot()
		check("after a restart the task is still there", statusOf(call(after, "GET", "/api/_a2app/tasks/"+taskID, admin, nil)), 200)
		check("…and its credential still works", statusOf(call(after, "GET", "/api/_a2app/whoami", map[string]string{"x-a2app-token": getStr(minted, "token")}, nil)), 200)
		_, requeued := call(after, "POST", "/api/ops/queue", admin, M{"n": 2.0})
		newID := toStr(requeued["result"].(M)["taskId"])
		check("…a new task gets a fresh id", newID != taskID && newID != "", true)
		_, newer := call(after, "GET", "/api/_a2app/events?since="+getStr(events, "nextCursor"), admin, nil)
		check("…a saved cursor reads only newer events", len(toMList(newer["events"])), 1)
		check("…and the approval key issued before it still runs",
			statusOf(call(after, "POST", "/api/ops/wipe", map[string]string{"x-a2app-token": "admin-token", "x-a2app-approval": getStr(asked, "approvalKey")}, M{})), 200)
		store.Close()
	}

	if len(failures) > 0 {
		fmt.Println("a2app_adapter selftest FAILED:\n  - " + strings.Join(failures, "\n  - "))
		return 1
	}
	fmt.Println("a2app_adapter selftest ok (guard, predicates, fingerprint, JavaScript semantics and the approval key, " +
		"referential deletes, listing, sqlite store and persistence, host and network policy, auth primitives, " +
		"resolution order and ceiling, device confirmation, operations, records, tasks, events, viewers, describe, restart)")
	return 0
}
