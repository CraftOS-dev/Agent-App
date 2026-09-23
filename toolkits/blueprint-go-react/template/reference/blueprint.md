# Blueprint reference — go-react

A React (Vite) View + a Go (net/http) server + a SQLite store, with a native
Go A2App adapter (the served surface and pure rules ported to Go in
`a2app_adapter.go`).

Where the `creator`/`modify` skill says "per your stack", the answer is here. If
this file and the source disagree, the source wins.

## Read this first

The scaffold gives you a complete, runnable starter app — the A2App adapter, a
working data model, and a full React View — which you edit into your own:

- **entities** — the data model in `schema.go` (see **Schema** below);
- **custom operations** — declared in `OPERATIONS` + `operations.json` and
  implemented in `OPERATION_RUNNERS` (see **Operations**);
- **the View** — the React app in `index.html` + `src/`, built on the shipped
  shared components and design tokens (see **The View**).

The starter models a to-do list; replace it with your own entities, operations,
and screens.

## File map — who owns what

Every file that ships on a fresh scaffold, in the order you meet them:

| Path | Owner | What it is |
|---|---|---|
| `schema.go` | **YOURS** | the data model + operations: `ENTITIES`, `OPERATIONS`, `OPERATION_RUNNERS`, `SEED`, each entity carrying `module`/`summary`/`fields`. Edit this to evolve the app; `describe`/`schemaVersion` derive from it. |
| `operations.json` | **YOURS** | the operation declarations `describe` and approval read (name, module, typed params, entity, appliesWhen, flags). Byte-mirror of `OPERATIONS`. |
| `index.html` | **YOURS** | the Vite entry: links `tokens.css`/`ui.css`, mounts `#root`, loads `src/main.jsx`. |
| `src/main.jsx` | **YOURS** | React root: StrictMode + ToastProvider + App; imports `updater.js` to start the update watcher. |
| `src/App.jsx` | **YOURS** | the View logic: state machine (loading/ready/error), add/advance/delete actions, filters, the `a2app:datachange` listener, boot. |
| `src/api.js` | **YOURS** | the one fetch wrapper — 10 s timeout, GET retry-once, readable error messages. |
| `src/Icon.jsx` · `src/toast.jsx` · `src/ConfirmDialog.jsx` · `src/format.js` | **YOURS** | the shared pieces — icon set, `useToast`, `useConfirm` (in-app dialog, never `window.confirm`), day formatting. One impl each; compose, never re-implement. |
| `src/updater.js` | **YOURS** | the runtime bridge to the system-owned update watcher. Keep it when you rewrite the View. |
| `public/tokens.css` | **YOURS** | design tokens (the kit sheet): foundation `--agent-app-*` + semantic bridge, light + dark + style packs. Re-point values; keep the NAMES stable. |
| `public/ui.css` | **YOURS** | component styles (buttons, cards, list rows, dialog, toasts). Consumes semantic tokens only. |
| `vite.config.js` | **YOURS** | the View build: React plugin, `dist/` output, dev-server proxy to the running app. |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | ignores `data/`, `dist/`, `bin/`, credentials, and framework state. Extend for your own artifacts. |
| `go.mod` | build | the Go module: one dependency (modernc.org/sqlite — pure Go, no cgo). Referenced by the pipeline; `go mod tidy` maintains it. |
| `package.json` | build | the View's build tooling only (react, vite) + scripts (`build` = vite build, `dev:ui` = vite dev server). npm never touches the server. |
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]`, `authMode`, `pipeline` (install/build/start/health). Change modules via the CLI, never by hand-editing a locked field. |
| `main.go` | SYSTEM (hash-locked) | the server + tooling flags: serves the records API, identity, describe, the built View (`dist/`), `/_a2app/update.js`; `--selftest`, `--check-ops`, `--promote-check`. Never edit. |
| `a2app_adapter.go` | SYSTEM (hash-locked) | the served surface + pure rules (parity with `@a2app/rules`) + the SQLite store. Never edit. |
| `a2app-update.js` | SYSTEM (hash-locked) | the update watcher served at `/_a2app/update.js` — detects code vs. data staleness in an open tab. Never edit. |
| `dist/` | build output | the compiled View (`npm run build`). Git-ignored; served by `main.go`. Never edit by hand. |
| `data/` | runtime | the live SQLite database (git-ignored, created on first boot). Never edit by hand; never commit. |

SYSTEM files are hashed in `.a2app/system-hashes.json`; the gate fails the build
if one changes. Need a variant of a shared component? Wrap it in `src/`, never
edit the locked original.

## Mental model

- The **adapter is the only agent surface.** A human uses the View; an agent
  operates the same records through A2App. Both converge on the SQLite store.
- **`schema.go` is the single source of truth for the model.** You never
  hand-write `describe` — the adapter derives it (and `schemaVersion`) from your
  schema. Change the schema, and every A2App screen updates.
- **The store is schema-derived and additive.** Records are JSON rows in one
  SQLite table keyed (entity, id); there are no migration files on this stack.
  Add a field to the schema and it is simply available; existing rows keep
  their stored values. This is the opposite of the pocketbase stack — do not go
  looking for a `migrations/` directory.
- **The View is served BUILT.** `vite build` compiles `index.html` + `src/`
  into `dist/`; `main.go` serves `dist/` with real cache validators. A source
  edit does nothing until the next build.

## Schema — entities & fields

Edit `schema.go`. Entities and fields are declared as data (`M` is
`map[string]any`):

```go
var ENTITIES = map[string]M{
	"<entity>": {
		"module":  "<module-from-manifest>", // REQUIRED — every entity names its module
		"summary": "one line shown beside it on the module screen",
		"fields": []M{
			{"name": "title", "type": "string", "required": true, "max": 200},
			{"name": "status", "type": "enum", "values": []string{"todo", "doing", "done"}},
			{"name": "due", "type": "string", "max": 10, "dayKey": true}, // "YYYY-MM-DD"
			{"name": "created", "type": "datetime", "readOnly": true},   // server-set
		},
	},
}

var SEED = map[string][]M{
	"<entity>": {{"id": "…", "title": "…", "created": "2026-01-01T00:00:00Z"}},
}
```

**Field types** (the A2App protocol vocabulary): `string` · `number` ·
`boolean` · `datetime` · `enum` (+ `values`) · `ref` (+ `entity`) · `list<enum>`
· `list<ref>` · `json` · `binary`. Field flags: `required`, `readOnly`
(server-managed, agents may not write it), `max`, and `dayKey: true` for a
whole-day text field advertised as `YYYY-MM-DD`.

**Seeding:** `SEED` is applied when the store is built fresh (first boot,
`dev`, and after `promote`). Seeded data survives; test data you add at runtime
does not carry to a fresh DB.

## Operations — anything beyond plain CRUD

Plain create/read/update/delete needs no operation — the records API covers it.
A declared operation is required only for behavior beyond that. Declare it in
**two places that must agree**, then implement it:

1. `OPERATIONS` (in `schema.go`) — and the identical row in `operations.json`.
2. `OPERATION_RUNNERS` — the implementation.

```go
var OPERATIONS = []M{
	{"name": "clear-done", "description": "Delete every done task.",
		"destructive": true, "module": "planning", "params": M{}},
	{"name": "complete-task", "description": "Mark one task done.",
		"module": "planning", "entity": "tasks",
		"appliesWhen": M{"field": "status", "ne": "done"},
		"params":      M{"task": M{"type": "ref", "entity": "tasks", "required": true}}},
}

var OPERATION_RUNNERS = map[string]OperationRunner{
	"clear-done": func(_ M, _ M, store *Store) (any, error) {
		removed := 0
		result, _ := store.listRecords("tasks", M{})
		for _, rec := range toMList(result["items"]) {
			if rec["status"] == "done" && store.deleteRecord("tasks", getStr(rec, "id")) {
				removed++
			}
		}
		return M{"removed": removed}, nil
	},
	"complete-task": func(args M, _ M, store *Store) (any, error) {
		task := store.getRecord("tasks", getStr(args, "task"))
		/* … */
		store.putRecord("tasks", task)
		return M{"ok": true}, nil
	},
}
```

- **Runner signature:** `func(args M, ctx M, store *Store) (any, error)` —
  return any JSON-able result. `store` is the SQLite-backed record store —
  `listRecords(entity, query)` · `getRecord(entity, id)` ·
  `putRecord(entity, record)` · `deleteRecord(entity, id)`. Writes are durable
  when the call returns; there is no separate persist() step. Returning an
  error (or panicking) answers `operation_failed`.
- **`params` is REQUIRED and typed** (same vocabulary as fields); use `M{}` for
  none. The record screen renders it as the signature — args described only in
  prose can neither be shown nor checked.
- **`entity`** attaches the op to a record screen; **`appliesWhen`** decides
  availability on a given record and the adapter derives the blocked reason from
  it. Comparisons only — `eq`, `ne`, `in`, `notIn`, `isBlank`, composed with
  `all`/`any`/`not`. Never a natural-language rule.
- **Flags:** `destructive: true` (requires human approval), `readOnly: true`
  (no side effects), `idempotent: true` (safe to repeat).
- The gate step **"operations resolve"** (`go run . --check-ops`) fails the
  build if any declared operation has no runner function.

## The View — `index.html` + `src/`

A React SPA over the same records API the agent uses. Same-origin writes are
trusted by the adapter, so the browser needs no token.

**Records API** the View calls (PocketBase-compatible REST, served by the adapter):

| Call | Meaning |
|---|---|
| `GET /api/collections/<entity>/records?sort=-created&page=1&perPage=100&filter=status = "todo"` | list; returns `{ items, totalItems }` |
| `POST /api/collections/<entity>/records` (JSON body) | create; returns the stored record |
| `PATCH /api/collections/<entity>/records/<id>` | update |
| `DELETE /api/collections/<entity>/records/<id>` | delete |
| `GET /api/_a2app` | identity (app name, versions) |

Always render back what the server **stored**, not what you sent. Never render an
unbounded collection — page with `perPage`.

**Shared pieces — `src/`** (one implementation each; import, don't rebuild):
`<Icon name size>` · `useToast()` → `toast(kind, message)` ·
`useConfirm()` → `[confirm, confirmElement]` (in-app dialog — never
`window.confirm`) · `api(path, init)` · `fmtDay(dayKey)` · `isPastDay(dayKey)`.
Component styles are plain CSS classes in `public/ui.css`.

**Tokens — `public/tokens.css`:** the kit sheet — `--agent-app-*` foundation →
semantic bridge. Components consume ONLY semantic tokens (`--bg-surface`,
`--text-primary`, `--accent-solid`, `--danger-solid`, `--focus-ring`, `--sp-*`,
`--r-*`, `--fs-*`, `--dur-*`, …). Theme by re-pointing the foundation or picking
a `[data-style]` pack; keep the names stable. Light and dark both resolve every
token and hold WCAG AA. Never hardcode a value where a token exists.

**Realtime / staleness — `src/updater.js`** bridges to the system-owned
watcher (`/_a2app/update.js`, a RUNTIME import the bundler must leave alone).
It reloads the tab on a CODE change when nothing is unsaved, and on a DATA
change (an agent wrote through A2App) dispatches `a2app:datachange` on `window`
so the View re-reads without discarding a half-typed form. Keep the bridge and
the listener when you rewrite the View. Do not add your own polling or reload
logic.

**Building:** `npm run build` (part of the pipeline build step) compiles the
View into `dist/`. For tight iteration `npm run dev:ui` runs Vite's dev server
with `/api` and `/_a2app` proxied to the running app — start the app first
(`agent-app <dir> serve` or `dev`).

## External data (third-party APIs)

Call the internet from the **backend only** — never the frontend (CORS breaks,
keys leak). On this stack the backend seam you own is the **operation runner**:
runners execute in-process on the Go server and can make outbound HTTP via
`net/http` (add the import to `schema.go`). Put third-party calls (and any
secret-bearing request) in a runner, expose the result as records or an
operation return. `main.go` is system-owned, so boot-time fetches are not your
seam — model an initial sync as a runner (e.g. a `refresh` operation) that
fills the store when it is empty.

## App→agent triggers

**This blueprint ships no trigger manifest in v0.1.** The creator skill's
"App→agent triggers" section does not apply here — there is no declared-trigger
surface to fire against. Handle app events with plain code. If a feature
genuinely needs the agent to react, say so in `requirements.md` as a known
limitation rather than inventing an unsupported mechanism.

## Build, run, gate

`manifest.json`'s `pipeline` drives everything (`install` → `build` → `start`,
health at `/api/_a2app`). Install is `go mod download && npm install`; build is
`npm run build && go build ./...`; start is `go run .`. Never start a server by
hand.

```bash
agent-app <dir> dev        # boot the candidate on a hidden port: fresh seeded store, prints the dev URL
agent-app <dir> validate   # framework files → build → go vet + self-test → operations resolve → ownership canon → describe budget (on dev)
agent-app <dir> serve      # launch LIVE as a managed, health-polled background process; prints the URL
agent-app <dir> promote    # requires the gate pass; backup, go run . --promote-check, destroys the dev instance
```

Toolkit gate steps (from `a2app.toolkit.json`): **"go vet + adapter
self-test"** (`go vet ./... && go run . --selftest`) and **"operations
resolve"** (`go run . --check-ops`). `lifecycle.dataDir` is `data/`.

**Environments (one tree, redirected inputs).** `main.go` reads `PORT`,
`A2APP_DATA_DIR` and `A2APP_ENV` from the framework. The dev instance runs
against a disposable per-boot SQLite store and serves `dist/` directly — a
View edit needs a rebuild to show; a `main.go`/`schema.go` edit needs `dev`
again. The LIVE instance serves a boot-time snapshot of `dist/`
(`.a2app/public`), so edits never reach users until promote + serve.

## Footguns for this stack

- **Two files, one truth.** Every operation lives in BOTH `OPERATIONS` and
  `operations.json`, byte-agreeing on name/module/params/flags. The gate
  fails a mismatch.
- **The View is served built.** Editing `src/` changes nothing a browser sees
  until `npm run build` runs. If the app looks stale, check `dist/` before
  debugging the server.
- **No migrations here.** Schema is declarative and additive; do not look for or
  create a `migrations/` directory.
- **Empty-DB first paint.** A fresh app has no records — the View must render its
  loading/empty/error states without erroring. The verifier fails any first-paint
  error.
- **Keep the update-watcher bridge.** Rewriting the View without `src/updater.js`
  (the runtime import of `/_a2app/update.js`) leaves already-open tabs stale
  forever.
- **A fetched record is a copy — put it back.** The SQLite store hands you a
  decoded copy of the row; mutating it changes nothing until you
  `putRecord()` it. Runners that "worked in memory" and persisted nothing are
  this footgun.
