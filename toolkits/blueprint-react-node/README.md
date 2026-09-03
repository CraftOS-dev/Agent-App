# blueprint-react-node

A Node + browser Agent App blueprint. `agent-app scaffold --blueprint blueprint-react-node` scaffolds a running to-do app: a Node backend on the built-in `http` module with a JSON-file store, a dependency-free SPA View, and the A2App adapter (`@a2app/adapter-core`) mounted as embedded middleware. Built from [../blueprint-base/](../blueprint-base/); vendors the reference [kit](../kit/).

Layout:

| Path | Ownership | Role |
|---|---|---|
| `server.mjs` | system-owned (hash-locked) | HTTP server: mounts the adapter, serves `public/`, persists records to `a2app.data.json` |
| `a2app.schema.mjs` | agent-owned | the data model + operations — edit this to evolve the app; `describe`/`schemaVersion` derive from it |
| `public/` | agent-owned | the human View (`index.html`, `app.js`) |
| `manifest.json`, `operations.json`, `AGENT_APP.md`, `reference/requirements.md` | framework files | identity, declared ops, plan, requirements |
| `.a2app/system-hashes.json` | ownership canon | which files are system-owned |

The agent operates the app through A2App; a human uses the same data through the View. Both see each other's writes on the next read.
