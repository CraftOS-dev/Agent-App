# blueprint-react-node

A Node + browser Agent App blueprint. `agent-app <dir> scaffold --blueprint blueprint-react-node` scaffolds a running to-do app: a Node backend on the built-in `http` module with a JSON-file store, a dependency-free SPA View, and the A2App adapter (`@a2app/adapter-core`) mounted as embedded middleware. Built from [../blueprint-base/](../blueprint-base/); vendors the reference [kit](../kit/).

Layout:

| Path | Ownership | Role |
|---|---|---|
| `server.mjs` | system-owned (hash-locked) | HTTP server: mounts the adapter, serves `public/` with cache validators, persists records to `a2app.data.json` |
| `a2app-update.js` | system-owned (hash-locked) | the View's update watcher, served at `/_a2app/update.js` |
| `a2app.schema.mjs` | agent-owned | the data model + operations — edit this to evolve the app; `describe`/`schemaVersion` derive from it |
| `public/` | agent-owned | the human View (`index.html`, `app.js`) |
| `manifest.json`, `operations.json`, `AGENT_APP.md`, `reference/requirements.md` | framework files | identity, declared ops, plan, requirements |
| `.a2app/system-hashes.json` | ownership canon | which files are system-owned |

The agent operates the app through A2App; a human uses the same data through the View. Both see each other's writes on the next read.

## Keeping an open tab honest

The View is served from disk, so a promote is live server-side the moment the app restarts — but a browser tab opened beforehand is still running the JavaScript it downloaded, and nothing about that is visible to the person looking at it.

Two system-owned pieces close that, and neither needs anything from the app author:

- **`server.mjs` serves assets with `ETag`, `Last-Modified` and `Cache-Control: no-cache`** (via `createStaticView` from `@a2app/adapter-core`). A plain reload always revalidates and gets changed files; an unchanged file costs a bodyless 304.
- **`a2app-update.js`, mounted at `/_a2app/update.js`,** polls identity's `appVersion` — a content fingerprint of the served View, which moves for changes `schemaVersion` is blind to — and offers a reload when the code the tab is running has been superseded.

`index.html` loads the watcher with one line; keep it when you rewrite the View:

```html
<script type="module" src="/_a2app/update.js"></script>
```

It **never reloads the page by itself**, and no option makes it. These are data-entry apps: discarding half-typed input is worse than the stale tab it would be curing. The person is told, and chooses.
