# blueprint-go-react

A Go + React + SQLite Agent App blueprint. `agent-app <dir> scaffold --blueprint blueprint-go-react` scaffolds a running to-do app: a Go (net/http) server, a SQLite record store (modernc.org/sqlite — pure Go, no cgo), a React (Vite) View, and a native Go A2App adapter — the served surface and pure rules ported to Go, with parity proven by the adapter self-test and the conformance suite, not by inspection. Built from [../blueprint-base/](../blueprint-base/); vendors the reference [kit](../kit/)'s token sheet. The Go module is not part of the pnpm workspace; npm covers only the View build.

Layout:

| Path | Ownership | Role |
|---|---|---|
| `main.go` | system-owned (hash-locked) | the server: flag dispatch (`--selftest` / `--check-ops` / `--promote-check`), mounts the adapter, serves the built View (`dist/`) with cache validators |
| `a2app_adapter.go` | system-owned (hash-locked) | the served surface + pure rules (parity with `@a2app/rules`) + the SQLite store |
| `a2app-update.js` | system-owned (hash-locked) | the View's update watcher, served at `/_a2app/update.js` |
| `schema.go` | agent-owned | the data model + operations — edit this to evolve the app; `describe`/`schemaVersion` derive from it |
| `index.html`, `src/`, `vite.config.js` | agent-owned | the human View: a React app compiled by `vite build` into `dist/` |
| `public/` | agent-owned | assets copied through the build verbatim — the kit token sheet (`tokens.css`) and component styles (`ui.css`) |
| `manifest.json`, `operations.json`, `AGENT_APP.md`, `reference/requirements.md` | framework files | identity, declared ops, plan, requirements |
| `.a2app/system-hashes.json` | ownership canon | which files are system-owned |

The agent operates the app through A2App; a human uses the same data through the View. Both see each other's writes on the next read.

## Keeping an open tab honest

The View is served from a build on disk, so a promote is live server-side the moment the app restarts — but a browser tab opened beforehand is still running the JavaScript it downloaded, and nothing about that is visible to the person looking at it.

Two system-owned pieces close that, and neither needs anything from the app author:

- **`main.go` serves assets with `ETag`, `Last-Modified` and `Cache-Control: no-cache`.** A plain reload always revalidates and gets changed files; an unchanged file costs a bodyless 304.
- **`a2app-update.js`, mounted at `/_a2app/update.js`,** polls identity's `appVersion` — a content fingerprint of the served View, which moves for changes `schemaVersion` is blind to — and reloads (or offers a reload) when the code the tab is running has been superseded.

The View loads the watcher through one runtime import; keep it when you rewrite the View:

```js
// src/updater.js — a runtime import Vite must not try to bundle
const watcher = import(/* @vite-ignore */ "/_a2app/update.js").catch(() => null);
```

It **reloads only when the page holds nothing unsaved**, and otherwise offers a dismissible banner. These are data-entry apps: discarding half-typed input is worse than the stale tab it would be curing. The person is told, and chooses.
