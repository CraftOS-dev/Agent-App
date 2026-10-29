# Packaging, the marketplace, and install (framework, v0.2)

How an Agent App travels between machines: what a package is, where packages come from, and the one pipeline every source goes through. Every harness drives it through the same CLI, so an app installed from OpenClaw, Hermes, CraftBot, Claude Code or a terminal arrives in exactly the same state.

## 1. Package

A **package** is an Agent App's directory tree, optionally zipped. A zip may hold the tree at its root or inside one top-level folder.

**Must carry:** the framework files.
- `manifest.json` (schema `manifest.schema.json`), `operations.json`, `AGENT_APP.md`, `reference/`.
- `.a2app/toolkit.json` naming the blueprint it was built from, as `{ "id": "<toolkit id>" }`. Any `source` path in it is ignored: a package never chooses which code is trusted.
- Optionally `.a2app/system-hashes.json`.

**Never carries** (an installer removes it if present, and `export` never writes it):
- credentials: `.agent-token`, `.superuser`, `.principal`, and any `*.secret` / `.tunnel-secret` / `.lan-secret`;
- runtime state:
  - in `.a2app/`: `serve.*`, `dev.json`, `dev/`, `bridge.*`, `backups/`, `gate-pass.json`, `describe-cache.json`, `lifecycle.lock`;
  - `logs/`;
- the toolkit's data directory (`lifecycle.dataDir`): a package never carries accounts, sessions, credential hashes or records;
- `node_modules/`, `.git/`, and build output the pipeline recreates.

**Placeholders.** For compatibility with catalogue apps written before this framework, these text tokens are replaced at install:
- the identity tokens `{{PROJECT_ID}}`, `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{PORT}}`, `{{BACKEND_PORT}}`, `{{CREATED_AT}}`;
- `{{<key>}}` for each catalogue `customizable` key.

How each value is written depends on the file:
- `.json`: JSON-string-escaped.
- `.html` and `.md`: HTML-escaped.
- Any other text file: substituted only when the value has no quote, backslash, backtick, `$`, `<`, `>` or control character. Otherwise install refuses and names the file and key.

Binary files are never touched. An app in this framework's format needs none of this: identity lives in `manifest.json` and the View reads its name from the identity document.

## 2. Catalogue (the marketplace)

A marketplace is a GitHub repository whose root holds `catalogue.json` (schema `catalogue.schema.json`), plus one folder per app:

```json
{ "version": "1.0.0",
  "apps": [ { "id": "kanban-board", "name": "Kanban Board", "description": "…", "folder": "kanban-board",
              "tags": ["productivity"], "version": "1.0.0", "preview": "https://…/thumbnail.png",
              "customizable": [ { "key": "APP_TITLE", "label": "Board title", "type": "text", "default": "Kanban" } ] } ] }
```

**Where the catalogue comes from:**
- `A2APP_MARKETPLACE`, else `marketplace` in `$A2APP_HOME/settings.json`.
- Either one is `github:<owner>/<repo>[@<ref>]`, or a local directory holding `catalogue.json` and the app folders (offline use and tests).
- The default is `github:CraftOS-dev/agent-app-collection@main`, falling back to `github:CraftOS-dev/living-ui-marketplace@main` when that is unavailable. The fallback applies to the default only; a configured source never falls back.
- A ref given in the source wins over `A2APP_MARKETPLACE_REF`, which wins over `main`.

**How an app is delivered:**
- The catalogue is `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/catalogue.json`. It is strict JSON.
- The app comes from the branch archive, `https://github.com/<owner>/<repo>/archive/refs/heads/<ref>.zip`. From that archive the installer takes only `<root>/<folder>/`, matched by whole path segments.
- Limits: 512 MiB for the archive, 512 MiB for the extracted app.
- Extraction refuses:
  - absolute paths and `..` segments;
  - drive letters;
  - entries that are links;
  - any entry that would land outside the target.
- The archive's SHA-256 is recorded with the app (§4).

## 3. Sources

| Source | Written as | Trust |
|---|---|---|
| Marketplace app | `agent-app install <catalogue id>` | catalogued |
| Zip file | `agent-app install --from <file.zip>` | untrusted |
| Folder | `agent-app install --from <dir>` | untrusted |
| GitHub | `--from github:<owner>/<repo>[@<ref>][/<path>]`, or `--from https://github.com/<owner>/<repo>[/tree/<ref>/<path>]` (the branch archive, as in §2) | untrusted |
| Any git host | `--from git+<url>[#<ref>]` (a shallow clone; needs `git` on PATH; no submodules; no prompts) | untrusted |

`agent-app <dir> import` installs the folder `<dir>` in place, with the same pipeline and `untrusted` trust.

## 4. The install pipeline

Every source goes through the same steps, in this order. A step that fails stops the install, and nothing is left registered or half-placed.

1. **acquire**:
   - Download or copy the source into a fresh staging directory under `$A2APP_HOME/staging/`.
   - Nothing from the source runs.
2. **inspect**: classify the staged tree (§5). Only `agent-app` packages continue; anything else stops with the reason and the route to take (§7).
3. **sanitize**: remove everything §1 says a package never carries.
4. **revendor**: replace the system files from a **locally installed** toolkit.
   - The toolkit is chosen by the id in `.a2app/toolkit.json`, or by `--blueprint <id>`.
   - Never by a path from the package.
   - An unknown toolkit stops the install.
   - The manifest is merged (the toolkit's `pipeline`; the app's identity and modules) and the canon is re-recorded.
5. **customize**: replace placeholders (§1) with the new identity and `--set KEY=VALUE` values. A catalogue key that is not set takes its `default`.
6. **place**:
   - Move the staged tree to the target: `--into <dir>`, which must be absent or empty; otherwise `$A2APP_HOME/apps/<slug>`, with `-2`, `-3`, … added on a clash.
   - The move is a single rename where the filesystem allows it.
7. **register**:
   - Give the app a new `id` (12 hex characters).
   - Its `name` comes from `--name`, else the catalogue entry, else the manifest.
   - Reserve a free port and mint a fresh `.agent-token` (0600).
   - Write the scaffold's ignore rules and harness guides, and link local toolkit packages.
   - Record `source` (provenance) in `manifest.json`: `{ kind, location, ref?, catalogueId?, version?, sha256?, installedAt }`.
8. **dependencies**: run the manifest's `pipeline.install`.
9. **gate**: `validate`. A failure stops the install; the app stays registered so it can be fixed, and the result says so.
10. **serve**: launch and health-poll, unless `--no-start`.
11. **open**: only with `--open`.

**Trust decides what is still owed after a successful install:**
- **catalogued:** nothing. A marketplace app is not walk-verified.
- **untrusted:** walk-verify, run by a separate agent, before the app is used for real work. The result lists it under `next`.

## 5. Inspect

`agent-app inspect <catalogue id>` and `agent-app inspect --from <source>` stage the source, classify it, report, and delete the staging. Nothing is installed. The report (schema `inspect-report.schema.json`):

| Field | Meaning |
|---|---|
| `kind` | `agent-app` (a framework manifest with `agentAppVersion` and `modules`), `living-ui` (a CraftBot Living UI manifest: `livingUIVersion`, or a numeric `agentAppVersion`), or `foreign` (no manifest). |
| `installable`, `reason` | Whether `install` would proceed, and why not. |
| `app` | `name`, `authMode`, `modules`. |
| `toolkit` | `id`; `installed` (whether this machine has it); `adapterVersion` as `{ package, current }`. |
| `integrity` | `intact`, `drifted` (listing the changed system files) or `absent`, against the package's own canon. |
| `pipeline` | The shell commands the app's toolkit will run. |
| `capabilities` | As declared. |
| `strips` | What sanitize would remove. |
| `placeholders` | The tokens found. |
| `warnings` | Anything else to know. |

## 6. Export

`agent-app <dir> export [--out <file.zip>]` writes the app as a package: one top-level folder named after the app, everything §1 excludes left out, and `.a2app/toolkit.json` reduced to its `id`. It prints `{ ok, file, sha256, bytes, files }`. A zip it writes installs on another machine with `install --from`.

## 7. Sources that are not packages

| `kind` | What happens |
|---|---|
| `living-ui` | Not installable as is. The importer skill converts it: scaffold on the matching blueprint, then rebuild from the source kept read-only in `reference/source/`. |
| `foreign` | **Adopt** runs the app unchanged behind the framework's sidecar adapter (`blueprint-sidecar`). **Convert** rebuilds it as above. |

The importer skill decides between these with the person.

## 8. Output

These commands follow the CLI contract: exit `0` success, `1` rejected, `2` usage, `3` unreachable. The result is JSON on stdout and diagnostics go to stderr.

| Command | Result |
|---|---|
| `catalogue [--search <words>] [--source <src>]` | `{ ok, source, apps:[…entry, compatible, reason?] }` |
| `inspect` | the report (§5) |
| `install` | `{ ok, id, name, dir, port, url?, trust, source, gate:{ ok, failures? }, served, next:[…] }` |
| `export` | §6 |

**With `--events`,** `install` writes one JSON object per line on stdout instead:
- `{ "event":"step", "step":"<name>", "status":"start|done|failed", … }` for each step in §4;
- then `{ "event":"result", …result }` last.

UIs show progress from these lines. The step names are `acquire inspect sanitize revendor customize place register dependencies gate serve open`.
