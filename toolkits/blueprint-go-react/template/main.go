// The Agent App server (SYSTEM-OWNED — hash-locked in the ownership canon).
//
// A single Go process: net/http wiring around the A2App adapter
// (`a2app_adapter.go`), with the built React View (`dist/`, produced by
// `vite build`) served behind it. Records live in SQLite (`data/db.sqlite`,
// via modernc.org/sqlite). The agent evolves the app by editing `schema.go`
// (the Model + operations) and `src/` (the React View) — never this file.
// Because describe and `schemaVersion` are derived from the live schema, an
// agent always sees the true model.
//
// This binary is also the toolkit's tooling — one entry point, no scripts
// directory: `go run . --selftest` (rules parity), `go run . --check-ops`
// (every declared operation has a runner), `go run . --promote-check`
// (lifecycle.promote). `go run .` with no flag serves.
//
// The launch contract (`serve` and `dev` both set these; defaults cover a
// direct `go run .` from the project directory):
//   PORT            which port to bind. `serve` passes manifest.port; `dev` a
//                   hidden port. Fallback: manifest.port, then 8094.
//   A2APP_DATA_DIR  where records live. `serve` passes the toolkit's declared
//                   lifecycle dataDir ("data" — what backup/restore/promote
//                   protect); `dev` passes a fresh per-boot directory, which is
//                   how a dev instance runs against a disposable database.
//   A2APP_ENV       "live" or "dev" — decides how the static View is served.
package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	// Tooling flags first: none of them needs a built View, a manifest, or a
	// port, and the gate runs them on checkouts that have none of those yet.
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--selftest":
			os.Exit(selftest())
		case "--check-ops":
			os.Exit(checkOps())
		case "--promote-check":
			os.Exit(promoteCheck())
		}
	}
	serveApp()
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

/* ------------------------------------------------------------- tooling flags */

// checkOps is the gate's "operations resolve" step: every entry in OPERATIONS
// must have a runner in OPERATION_RUNNERS, or the app answers 501 for a
// capability it advertised.
func checkOps() int {
	missing := []string{}
	for _, o := range OPERATIONS {
		name := getStr(o, "name")
		if _, ok := OPERATION_RUNNERS[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		fmt.Fprintln(os.Stderr, "declared with no runner: "+strings.Join(missing, ", "))
		return 1
	}
	fmt.Println("operations resolve ok")
	return 0
}

// promoteCheck is lifecycle.promote — apply a code change to the live database.
//
// For a schema-in-code SQLite store there is no destructive migration chain:
// changes are additive (a new field simply defaults to absent, an existing
// record stays valid). By the time this runs, the framework has ALREADY taken
// the mandatory pre-promote backup. The Python blueprint's first step —
// "the app must compile" — is inherent here: `go run .` refuses to run code
// that does not compile. This step therefore:
//  1. confirms the current LIVE database is still readable under the new schema,
//  2. REFUSES the one destructive case — an entity that still holds live data
//     being removed from the schema — so promote can never silently orphan data.
func promoteCheck() int {
	refuse := func(err error) int {
		fmt.Fprintf(os.Stderr, "live database is unreadable (%v) — refusing to promote\n", err)
		return 1
	}

	live := filepath.Join("data", "db.sqlite")
	if _, err := os.Stat(live); os.IsNotExist(err) {
		fmt.Println("first install — no live database to migrate")
		return 0
	}
	abs, err := filepath.Abs(live)
	if err != nil {
		return refuse(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(abs)+"?mode=ro")
	if err != nil {
		return refuse(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT entity, COUNT(*) FROM records GROUP BY entity ORDER BY entity")
	if err != nil {
		return refuse(err)
	}
	defer rows.Close()
	type heldRow struct {
		entity string
		count  int
	}
	held := []heldRow{}
	for rows.Next() {
		var hr heldRow
		if err := rows.Scan(&hr.entity, &hr.count); err != nil {
			return refuse(err)
		}
		held = append(held, hr)
	}
	if err := rows.Err(); err != nil {
		return refuse(err)
	}

	// Refuse to orphan data: an entity that holds live records must still exist
	// in the new schema (removing it is a destructive migration).
	orphaned := []string{}
	liveEntities := []string{}
	for _, hr := range held {
		if hr.count == 0 {
			continue
		}
		liveEntities = append(liveEntities, hr.entity)
		if _, declared := ENTITIES[hr.entity]; !declared {
			orphaned = append(orphaned, hr.entity)
		}
	}
	if len(orphaned) > 0 {
		plural := "ies"
		if len(orphaned) == 1 {
			plural = "y"
		}
		fmt.Fprintf(os.Stderr,
			"refusing to promote: live data exists for entit%s removed from the schema (%s). "+
				"Removing an entity that holds data is destructive — migrate or export that data first.\n",
			plural, strings.Join(orphaned, ", "))
		return 1
	}

	inLive := strings.Join(liveEntities, ", ")
	if inLive == "" {
		inLive = "none"
	}
	fmt.Printf("live database compatible with the new schema (%d declared; live data in: %s)\n",
		len(ENTITIES), inLive)
	return 0
}

/* ------------------------------------------------------------ structured log */

// logLine writes one JSON line per event to stdout (the log `agent-app serve`
// captures): a single schema — ts, level, evt, then event fields — so
// diagnosis filters by field instead of parsing prose. Never log record
// contents or secrets.
func logLine(level, evt string, fields M) {
	line := M{"ts": nowISO(), "level": level, "evt": evt}
	for k, v := range fields {
		line[k] = v
	}
	os.Stdout.WriteString(stableJSON(line) + "\n")
}

/* ------------------------------------------------------------- static View */

// The View, served BUILT and with real cache validators.
//
// "Live loads code at boot": in the live environment the View is served from a
// SNAPSHOT of `dist/` taken at this boot (`.a2app/public`), matching how the
// rest of the code is fixed at process start. Without it, a rebuild mid-
// iteration would reach live users on their next refresh — before any gate or
// verify has seen it. The dev instance serves `dist/` directly (rebuild →
// refresh); for tight View iteration `npm run dev:ui` runs Vite's dev server
// with `/api` proxied here.
//
// Every asset answers with `ETag`, `Last-Modified` and `Cache-Control:
// no-cache` and honours conditional requests, so a plain reload always
// re-checks and an unchanged file costs a bodyless 304. This file is
// system-owned and hash-locked precisely so an app author never has to fix
// cache correctness themselves. (`no-cache` means "revalidate before every
// use", not "do not cache" — the right default for plain, unhashed filenames
// edited in place.)
//
// version() fingerprints the bytes it serves. That is published as identity's
// `appVersion`, and it is the ONLY signal that moves for a View-only change —
// `schemaVersion` covers entities and operations, so a new component, a CSS
// tweak or reworded copy leaves it byte-identical. `schema.go` is folded in as
// well: an operation's description is not in `schemaVersion` either, yet it
// changes what the app tells an agent.

// Content types for the file kinds a built View is made of.
var staticMime = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json",
	".map":  "application/json",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt":  "text/plain; charset=utf-8",
}

type staticView struct {
	root    string
	aliases map[string]string
	// Extra files folded into version() — app source that shapes the served
	// app without being served itself.
	fingerprintExtra []string
	// An opaque string mixed into version() (manifest.appVersion), so an
	// author can move the marker deliberately.
	salt string

	// version() is polled by every open tab; a short cache bounds that cost.
	// It is not a correctness knob (a promote is followed by a restart).
	mu            sync.Mutex
	cachedVersion string
	cachedAt      time.Time
}

// filesUnder is every regular file under path (a file is itself), sorted,
// never following a symlink — the same containment rule the ownership canon
// walks with.
func filesUnder(path string) []string {
	out := []string{}
	stack := []string{path}
	seen := map[string]bool{}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[current] {
			continue
		}
		seen[current] = true
		st, err := os.Lstat(current)
		if err != nil || st.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if st.IsDir() {
			entries, err := os.ReadDir(current)
			if err != nil {
				continue
			}
			for _, e := range entries {
				stack = append(stack, filepath.Join(current, e.Name()))
			}
		} else {
			out = append(out, current)
		}
	}
	sort.Strings(out)
	return out
}

// fingerprintTree hashes content, not mtime: a `touch`, a checkout, or a
// re-copy of identical bytes must NOT look like a new version — an app that
// cried "update available" every time its files were re-stamped would train
// users to dismiss the one notice that matters. Paths are hashed alongside
// content (relative to each entry, so the same tree fingerprints identically
// from a different absolute location).
func fingerprintTree(paths []string) string {
	h := sha256.New()
	for _, p := range paths {
		root, err := filepath.Abs(p)
		if err != nil {
			continue
		}
		for _, file := range filesUnder(root) {
			rel := filepath.ToSlash(strings.TrimPrefix(file, root))
			h.Write([]byte(rel))
			h.Write([]byte{0})
			if content, err := os.ReadFile(file); err == nil {
				h.Write(content)
			}
			h.Write([]byte{0})
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (v *staticView) version() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.cachedVersion != "" && time.Since(v.cachedAt) < time.Second {
		return v.cachedVersion
	}
	versioned := []string{v.root}
	aliasPaths := make([]string, 0, len(v.aliases))
	for _, target := range v.aliases {
		aliasPaths = append(aliasPaths, target)
	}
	sort.Strings(aliasPaths) // alias targets count too: they are code the tab runs
	versioned = append(versioned, aliasPaths...)
	versioned = append(versioned, v.fingerprintExtra...)
	sum := sha256.Sum256([]byte(v.salt + "\x00" + fingerprintTree(versioned)))
	v.cachedVersion = "av_" + hex.EncodeToString(sum[:])[:16]
	v.cachedAt = time.Now()
	return v.cachedVersion
}

// resolveFile is the file this request names, or "" when there is none to
// serve. Returns "" rather than erroring for every hostile shape (traversal, a
// NUL byte, a directory) so the caller answers one honest 404.
func (v *staticView) resolveFile(rawPath string) string {
	if target, ok := v.aliases[rawPath]; ok {
		if st, err := os.Stat(target); err == nil && st.Mode().IsRegular() {
			return target
		}
		return ""
	}
	rel := rawPath // net/http has already percent-decoded the path
	if rel == "/" || rel == "" {
		rel = "/index.html"
	}
	if strings.ContainsRune(rel, 0) {
		return ""
	}
	file := filepath.Join(v.root, filepath.FromSlash(rel))
	// Containment: a prefix check alone would also accept a sibling whose name
	// merely begins with root's (…/public-backup), so the separator is part of
	// the test.
	if file != v.root && !strings.HasPrefix(file, v.root+string(filepath.Separator)) {
		return ""
	}
	if st, err := os.Stat(file); err != nil || !st.Mode().IsRegular() {
		return ""
	}
	return file
}

// matchesEtag parses an `If-None-Match` list. `*` matches anything; weak
// comparison is the correct one for a conditional GET (RFC 9110 13.1.2), so
// `W/` is stripped.
func matchesEtag(header, etag string) bool {
	if header == "" {
		return false
	}
	strip := func(s string) string { return strings.TrimPrefix(strings.TrimSpace(s), "W/") }
	for _, candidate := range strings.Split(header, ",") {
		value := strip(candidate)
		if value == "*" || value == strip(etag) {
			return true
		}
	}
	return false
}

func (v *staticView) serveHTTP(w http.ResponseWriter, r *http.Request) {
	method := strings.ToUpper(r.Method)
	if method != "GET" && method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, 405, M{"a2app": true, "ok": false, "code": "method_not_allowed", "message": "Static assets are GET-only."})
		return
	}

	file := v.resolveFile(r.URL.Path)
	if file == "" {
		writeJSON(w, 404, M{"a2app": true, "ok": false, "code": "not_found", "message": "No such route."})
		return
	}

	body, err := os.ReadFile(file)
	if err != nil {
		writeJSON(w, 404, M{"a2app": true, "ok": false, "code": "not_found", "message": "No such route."})
		return
	}
	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:])[:32] + `"`
	lastModified := time.Now()
	if st, err := os.Stat(file); err == nil {
		lastModified = st.ModTime()
	}

	contentType := staticMime[strings.ToLower(filepath.Ext(file))]
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", etag)
	h.Set("Last-Modified", lastModified.UTC().Format(http.TimeFormat))

	// ETag wins where both validators are present: it compares content, while
	// If-Modified-Since compares a whole-second timestamp that an edit inside
	// the same second cannot move.
	inm := r.Header.Get("If-None-Match")
	fresh := matchesEtag(inm, etag)
	if !fresh && inm == "" {
		if ims, err := http.ParseTime(r.Header.Get("If-Modified-Since")); err == nil {
			fresh = !lastModified.Truncate(time.Second).After(ims)
		}
	}
	if fresh {
		w.WriteHeader(304)
		return
	}

	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(200)
	if method != "HEAD" {
		w.Write(body)
	}
}

// copyDir is a recursive copy that never follows a symlink. (The Node
// blueprint documents the same choice against fs.cpSync for a Windows crash;
// here it simply keeps the snapshot walk identical to the fingerprint walk.)
func copyDir(src, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		from := filepath.Join(src, e.Name())
		to := filepath.Join(dest, e.Name())
		st, err := os.Lstat(from)
		if err != nil || st.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if st.IsDir() {
			if err := copyDir(from, to); err != nil {
				return err
			}
			continue
		}
		data, err := os.ReadFile(from)
		if err != nil {
			return err
		}
		if err := os.WriteFile(to, data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

/* ------------------------------------------------------------------ server */

// A protocol write is tiny; anything larger is a mistake or an attack, and
// buffering it whole would let a hostile client OOM the app. Same cap and
// envelope as @a2app/adapter-core's Node transport (http.ts).
const maxRequestBodyBytes = 5 * 1024 * 1024

func writeJSON(w http.ResponseWriter, status int, payload M) {
	body := stableJSON(payload)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	io.WriteString(w, body)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func agentToken() string {
	const file = ".agent-token"
	if data, err := os.ReadFile(file); err == nil {
		return strings.TrimSpace(string(data))
	}
	token := "a2app_" + randomHex(24)
	if err := os.WriteFile(file, []byte(token+"\n"), 0o600); err != nil {
		fatal("could not write .agent-token: " + err.Error())
	}
	return token
}

func serveApp() {
	manifestBytes, err := os.ReadFile("manifest.json")
	if err != nil {
		fatal("could not read manifest.json (run from the project directory): " + err.Error())
	}
	var manifest M
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		fatal("manifest.json is not valid JSON: " + err.Error())
	}

	// The CLI reaches a running app at manifest.port; bind the same port so the
	// two always agree. PORT env overrides (`serve` passes manifest.port; `dev`
	// a hidden port), then manifest.port.
	port := 8094
	if p := intOf(manifest["port"]); p != 0 {
		port = p
	}
	if envPort := os.Getenv("PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil {
			port = p
		}
	}
	envName := os.Getenv("A2APP_ENV")
	if envName == "" {
		envName = "live"
	}
	dataDir := os.Getenv("A2APP_DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}

	// The React View is served BUILT: `vite build` (the pipeline `build` step)
	// compiles `index.html` + `src/` into `dist/`. Source is never served.
	const distDir = "dist"
	if st, err := os.Stat(distDir); err != nil || !st.IsDir() {
		// Refuse to serve an app with no View rather than 404-ing every human
		// who opens it: the build step is part of the pipeline, so a missing
		// dist/ means the pipeline has not run, not that this app is API-only.
		fatal("dist/ not found — the View is not built. Run the pipeline build (npm run build) first.")
	}
	servedDir := distDir
	if envName == "live" {
		snapshot := filepath.Join(".a2app", "public")
		if err := os.RemoveAll(snapshot); err != nil {
			fatal("could not clear the live View snapshot: " + err.Error())
		}
		if err := copyDir(distDir, snapshot); err != nil {
			fatal("could not snapshot dist/ for the live View: " + err.Error())
		}
		servedDir = snapshot
	}
	servedAbs, err := filepath.Abs(servedDir)
	if err != nil {
		fatal(err.Error())
	}

	view := &staticView{
		root: servedAbs,
		// The update watcher lives at the project root, not inside the View
		// build: it is system-owned, and the View is the agent's to rewrite
		// entirely.
		aliases:          map[string]string{"/_a2app/update.js": "a2app-update.js"},
		fingerprintExtra: []string{"schema.go"},
		// An author who wants to move the marker by hand can bump
		// manifest.appVersion.
		salt: getStr(manifest, "appVersion"),
	}

	// Durable store: records + idempotency keys in SQLite inside the lifecycle
	// dataDir. Seeded only when this boot CREATED the database file.
	store, err := NewSqliteStore(filepath.Join(dataDir, "db.sqlite"), SEED)
	if err != nil {
		fatal("could not open the database: " + err.Error())
	}

	adapter, err := NewAdapter(AdapterConfig{
		AppID:      getStr(manifest, "id"),
		AppName:    manifest["name"],
		Entities:   ENTITIES,
		Operations: OPERATIONS,
		Store:      store,
		Token:      agentToken(),
		// Modules are declared in the manifest and are what describe's root
		// level lists; every entity and operation names one.
		Modules:        toMList(manifest["modules"]),
		AllowedOrigins: []string{fmt.Sprintf("http://localhost:%d", port), fmt.Sprintf("http://127.0.0.1:%d", port)},
		Runners:        OPERATION_RUNNERS,
		AuthMode:       getStr(manifest, "authMode"),
		// Re-derived per request (behind a one-second cache), so it stays true
		// for a server whose files changed under it — the same "derive, do not
		// declare" rule schemaVersion follows.
		AppVersion: view.version,
	})
	if err != nil {
		fatal(err.Error())
	}

	// Route ownership, in order: (1) the A2App adapter answers every path it
	// owns (identity, describe, records, operations, tasks/events); (2)
	// anything else falls through to the static View. The adapter is the only
	// agent surface; the View is the human one.
	apiHandler := func(w http.ResponseWriter, r *http.Request) {
		var body M
		method := strings.ToUpper(r.Method)
		if method == "POST" || method == "PATCH" || method == "PUT" {
			// Count bytes as they arrive rather than trusting Content-Length,
			// so a client that lies about the length gains nothing.
			raw, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodyBytes+1))
			if err != nil {
				writeJSON(w, 400, M{"a2app": true, "ok": false, "code": "bad_request", "message": "The request body could not be read."})
				return
			}
			if len(raw) > maxRequestBodyBytes || r.ContentLength > maxRequestBodyBytes {
				w.Header().Set("Connection", "close")
				writeJSON(w, 413, M{
					"a2app": true, "ok": false, "code": "payload_too_large",
					"message":    fmt.Sprintf("Request body exceeds the %d-byte limit.", maxRequestBodyBytes),
					"limitBytes": maxRequestBodyBytes,
				})
				return
			}
			if text := strings.TrimSpace(string(raw)); text != "" {
				// A body that is not a JSON object is handed to the guard as
				// `__unparsed__` so it is rejected by the adapter's own rules
				// rather than 500-ing here.
				var parsed any
				if json.Unmarshal([]byte(text), &parsed) == nil {
					if obj, ok := parsed.(map[string]any); ok {
						body = obj
					} else {
						body = M{"__unparsed__": text}
					}
				} else {
					body = M{"__unparsed__": text}
				}
			}
		}
		headers := map[string]string{}
		for k, vs := range r.Header {
			if len(vs) > 0 {
				headers[strings.ToLower(k)] = vs[0]
			}
		}
		query := map[string]string{}
		for k, vs := range r.URL.Query() {
			if len(vs) > 0 {
				query[k] = vs[len(vs)-1]
			}
		}
		status, payload := func() (status int, payload M) {
			// Fail open internally: an adapter bug never 500s the whole app
			// silently — it answers with a machine-readable adapter error.
			defer func() {
				if p := recover(); p != nil {
					status, payload = 500, M{"a2app": true, "ok": false, "code": "adapter_error", "message": fmt.Sprint(p)}
				}
			}()
			return adapter.dispatch(method, r.URL.Path, headers, body, query)
		}()
		writeJSON(w, status, payload)
	}

	var nextRequestID atomic.Int64
	root := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := nextRequestID.Add(1)
		started := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		// Observe (never handle) every request for the log: id, method, path,
		// status, duration. Paths only — query strings can carry filters over
		// user data. A panic that escapes the adapter's own recovery is a
		// crash: log a structured last line and exit, so the launch contract's
		// supervisor restarts the process, not the process itself.
		defer func() {
			if p := recover(); p != nil {
				logLine("error", "crash", M{"message": fmt.Sprint(p), "stack": string(debug.Stack())})
				os.Exit(1)
			}
			level := "info"
			if rec.status >= 500 {
				level = "error"
			}
			logLine(level, "http", M{
				"id": id, "method": r.Method, "path": r.URL.Path,
				"status": rec.status, "ms": time.Since(started).Milliseconds(),
			})
		}()
		path := r.URL.Path
		if path == "/.well-known/a2app.json" || path == "/api" || strings.HasPrefix(path, "/api/") {
			apiHandler(rec, r)
			return
		}
		view.serveHTTP(rec, r)
	})

	// Bind loopback explicitly. Binding every interface would make the app
	// reachable from the network while its own log line said localhost — and a
	// same-origin request is trusted as the owner without a credential, which
	// would make a scaffolded Agent App remotely writable by anyone who could
	// reach the port. Exposing it must be a deliberate act, hence the env var.
	host := os.Getenv("A2APP_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		logLine("error", "crash", M{"message": err.Error()})
		os.Exit(1)
	}
	appLabel := manifest["name"]
	if appLabel == nil || appLabel == "" {
		appLabel = manifest["id"]
	}
	logLine("info", "boot", M{
		"app": appLabel, "a2appId": manifest["id"],
		"url": fmt.Sprintf("http://%s:%d", host, port),
	})
	if err := http.Serve(listener, root); err != nil {
		logLine("error", "crash", M{"message": err.Error()})
		os.Exit(1)
	}
}
