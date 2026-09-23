# blueprint-rails-vue

A Rails + Vue 3 + SQLite Agent App blueprint. `agent-app <dir> scaffold --blueprint blueprint-rails-vue` scaffolds a running to-do app: a Rails server (Puma, no ActiveRecord), a SQLite record store owned by the adapter, a Vue 3 (Vite) View built into `public/`, and a native Ruby A2App adapter — the served surface and pure rules ported to Ruby, with `ruby lib/a2app_adapter.rb --selftest` as the parity check. Built from [../blueprint-base/](../blueprint-base/); vendors the reference [kit](../kit/)'s token sheet. Not part of the pnpm workspace (Ruby + a nested npm project).

Layout:

| Path | Ownership | Role |
|---|---|---|
| `config/application.rb`, `config/routes.rb`, `config/puma.rb` | system-owned (hash-locked) | the minimal Rails app: action_controller only, `public/` served with no-cache headers, loopback bind, headless boot (no credentials ritual) |
| `app/controllers/a2app_controller.rb` | system-owned (hash-locked) | the wiring: Rack request → `adapter.dispatch()`, 5 MiB body cap, identity's `appVersion` fingerprint, the watcher route |
| `lib/a2app_adapter.rb` | system-owned (hash-locked) | the served surface + pure rules (parity with `@a2app/rules`) + the SQLite store + `--selftest` |
| `a2app-update.js` | system-owned (hash-locked) | the View's update watcher, served at `/_a2app/update.js` |
| `lib/a2app_schema.rb` | agent-owned | the data model + operations — edit this to evolve the app; `describe`/`schemaVersion` derive from it |
| `ui/` | agent-owned | the human View: a Vue 3 app compiled by `vite build` into `public/` (git-ignored build output — never hand-edited) |
| `ui/public/` | agent-owned | assets copied through the build verbatim — the kit token sheet (`tokens.css`) and component styles (`ui.css`) |
| `manifest.json`, `operations.json`, `AGENT_APP.md`, `reference/requirements.md` | framework files | identity, declared ops, plan, requirements |
| `.a2app/system-hashes.json` | ownership canon | which files are system-owned |

The agent operates the app through A2App; a human uses the same data through the View. Both see each other's writes on the next read.

## Keeping an open tab honest

The View is served from a build on disk, so a promote is live server-side the moment the app restarts — but a browser tab opened beforehand is still running the JavaScript it downloaded, and nothing about that is visible to the person looking at it.

Two system-owned pieces close that, and neither needs anything from the app author:

- **Rails serves `public/` with `Cache-Control: no-cache`** (via `config.public_file_server.headers` in `config/application.rb`). A plain reload always revalidates and gets changed files; an unchanged file costs a conditional round trip.
- **`a2app-update.js`, served at `/_a2app/update.js` by a controller action,** polls identity's `appVersion` — a content fingerprint of the served View (`public/**` + the schema + the watcher itself), which moves for changes `schemaVersion` is blind to — and reloads (or offers a reload) when the code the tab is running has been superseded.

The View loads the watcher through one runtime import; keep it when you rewrite the View:

```js
// ui/src/updater.js — a runtime import Vite must not try to bundle
const watcher = import(/* @vite-ignore */ "/_a2app/update.js").catch(() => null);
```

It **reloads only when the page holds nothing unsaved**, and otherwise offers a dismissible banner. These are data-entry apps: discarding half-typed input is worse than the stale tab it would be curing. The person is told, and chooses.
