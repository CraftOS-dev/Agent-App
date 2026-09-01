---
name: importer
activity: importer
description: Bring existing apps into the framework — install a marketplace app, import an Agent App export (zip/folder/git), adopt a foreign app to run as-is, or convert a foreign app by rebuilding it. Load for import/install/adopt/convert. Untrusted on origin; re-verified.
---

# Importer

Bring existing apps in: **marketplace installs** (pre-built, pre-verified apps),
**imports** of an Agent App export from a zip / local folder / git URL,
**adoptions** of a foreign app (it runs UNCHANGED behind an adapter), and
**conversions** of a foreign app — which are REBUILDS: the original code becomes
reference material and the behavior is re-implemented on this platform. Be honest
about that cost before converting: nothing of the original code runs afterward.

Imported code is **untrusted on origin** and re-verified; it earns no capability
without the owner's consent.

## Which path?

| The user has… | Do this |
|---|---|
| An app name / "what's in the marketplace?" | resolve the exact app id (match the user's words; never guess ids), then **install** it |
| A `.zip`, a project folder path, or a git URL of an Agent App | **import** — one door for all three |
| A foreign app to keep running as-is | **adopt** — pipeline verbs + operation mapping |
| A foreign (non-Agent-App) codebase to rebuild | **convert** — a full REBUILD; tell the user first |

## Install (marketplace)

Resolve the exact app id, download, and check the hash against the marketplace
plus version/build compatibility. Assign a fresh identity and port; strip any
shipped credentials. Marketplace apps are pre-built and **pre-verified upstream —
no walk-verify needed**. An app still in a legacy format is rejected with a clear
error; tell the user it hasn't been re-published for this version yet, and do not
improvise a workaround. On a launch error, treat it like any build failure under
the ownership rules: read ALL errors, fix, `a2app validate`, relaunch.

## Import (an Agent App export: zip / folder / git)

The source already carries framework files.

1. Extract; verify the framework files are present and valid. Register a NEW
   delivered project (fresh id + port, shipped credentials stripped, kit
   re-vendored).
2. `a2app toolkit-sync <dir>` then `a2app adapter-sync <dir>` — re-vendor system
   files and re-deliver the adapter.
3. `a2app validate` → launch → **walk-verify**. It is not trusted just for
   carrying framework files.

## Adopt (a foreign app, runs AS-IS)

The app runs UNCHANGED in its own runtime — **never rebuild it, never edit its
code** except configuration needed to bind the assigned port. You put an A2App
adapter (the sidecar / reverse-proxy form) in front of it so agents can drive its
declared operations; everything else passes through.

1. **Inspect** the source at the project path: README, dependency manifests
   (package.json / pyproject.toml / go.mod / Cargo.toml), how it starts, which
   port/env it expects, whether it has a build step.
2. **Write the pipeline verbs** into the framework `manifest.json` (install /
   build / start / health). Bind `127.0.0.1` on the assigned port. Use the app's
   OWN runner (its npm script, uvicorn, a static server, a compiled binary). Pick a
   health strategy the app satisfies (an HTTP path it answers, or process liveness
   for servers that 404 on `/`).
3. **Map its controllable surface** into `operations.json` so agents can DRIVE it
   over A2App. Each declared operation maps its A2App path onto the app's OWN
   upstream endpoint (the reverse-proxy adapter forwards it). Probe in order: an
   OpenAPI/Swagger spec in the repo → route definitions in code → the README. Mark
   anything that deletes/overwrites `"destructive": true`. If the app has NO server
   API (a static site or client-side SPA), leave `operations` empty and say so —
   never invent verbs, never map direct DB writes. A foreign app exposes
   **operations only, no protocol entities** — its own API passes through.
4. **Note what the app is** in `AGENT_APP.md`. Do NOT author feature requirements
   for it: verification covers *the app launches and its main screen renders* —
   never the foreign app's internal features (you can't fix those and must not try;
   it ships as-is, quirks included).
5. `a2app validate` / launch. Errors come back with the app's own log excerpts; fix
   the VERBS or the port binding, not the app's features, and retry.
6. **Verify the operation mappings for real**: invoke every non-destructive mapped
   operation through the adapter and confirm it works; destructive ones are
   shape-checked, never fired. A mapping that does not work must not ship — fix it or
   remove the operation.
7. walk-verify the launch, then announce. If the app fundamentally cannot run here
   (needs a database server, private APIs, system deps), STOP and tell the user
   exactly what is missing — do not fake a start command that serves an error page.

Changes to a running adopted app apply LIVE (no staging): edit → relaunch.

## Convert (a foreign app, REBUILT)

Conversion scaffolds a fresh Agent App, ships the original source read-only at
`reference/source/`, synthesizes `reference/requirements.md` FROM that source, and
runs the normal creator build. **Tell the user the cost first** — nothing of the
original code runs afterward. If the source turns out to already be an Agent App,
use the **import** path instead.

## Notes

- Imported/installed projects are ordinary Agent Apps afterward: operate them via
  the `a2app` CLI (`ops` / `run` / `data`), modify them via the modify skill. Adopted
  external apps speak the same operations surface through their adapter — `a2app ops`
  / `a2app run` work against them too; only the `data` verbs don't apply (external
  apps expose operations only; the app's own API passes through instead).
- Never edit system-owned files of an Agent App — the gate hashes them.
- Re-verification (gate + walk-verify) is mandatory for every path except a
  marketplace app already verified upstream. An app that cannot be made to run or
  comply is rejected honestly.
