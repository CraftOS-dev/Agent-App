# Packaging, the marketplace, and install (framework, v0.2)

How an Agent App travels between machines: what a package is, where packages come from, and the one pipeline every source goes through. Every harness drives it through the same CLI, so an app installed from OpenClaw, Hermes, CraftBot, Claude Code or a terminal arrives in exactly the same state.

## 1. Package

A **package** is an Agent App's directory tree, optionally zipped. A zip may hold the tree at its root or inside one top-level folder. Which one is decided by structure: the root when it holds `manifest.json`; else the one top-level folder that holds `manifest.json` (so a `__MACOSX/` beside it does not matter); else the only top-level folder, when everything is inside one.

**Must carry:** the framework files.
- `manifest.json` (schema `manifest.schema.json`), `operations.json`, `AGENT_APP.md`, `reference/`.
- `.a2app/toolkit.json` naming the blueprint it was built from, as `{ "id": "<toolkit id>" }`. The id is a bare name, never a path. Any `source` path in it is ignored: a package never chooses which code is trusted.
- Optionally `.a2app/system-hashes.json`.

**Never carries** (an installer removes it if present, and `export` never writes it):
- credentials, wherever they sit: `.agent-token`, `.superuser`, `.principal`, and any `*.secret` / `.tunnel-secret` / `.lan-secret`;
- runtime state:
  - everything in `.a2app/` except `toolkit.json` and `system-hashes.json`: `serve.*`, `dev.json`, `dev/`, `bridge.*`, `backups/`, `gate-pass.json`, `describe-cache.json`, `lifecycle.lock`, `public/`, and whatever runtime state is added later;
  - `logs/`;
- the toolkit's data directory (`lifecycle.dataDir`): a package never carries accounts, sessions, credential hashes or records;
- `node_modules/` and `.git/`, at any depth;
- build output the pipeline recreates: whatever the root `.gitignore` of the package, or of its toolkit's template, excludes. That file is where a stack already declares its build output (`dist/`, `target/`, `pb/pb_public/`, `.venv/`). Each file's rules apply on their own, so a `!` in the package's file never re-includes what the toolkit's excludes. Nested `.gitignore` files are not read.

**Placeholders.** For compatibility with catalogue apps written before this framework, these text tokens are replaced at install:
- the identity tokens `{{PROJECT_ID}}`, `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{PORT}}`, `{{BACKEND_PORT}}` (the same port), `{{CREATED_AT}}`;
- `{{<key>}}` for each catalogue `customizable` key, and for each `--set` key.

How each value is written depends on the file:
- `.json`: JSON-string-escaped.
- `.html` and `.md`: HTML-escaped.
- Any other text file: substituted only when the value has no quote, backslash, backtick, `$`, `<`, `>` or control character. Otherwise install refuses and names the file and key. Every file is checked before any is written.

Binary files (a NUL byte, or not UTF-8) are never touched, and neither are the toolkit's system files, which stay byte-identical to the toolkit's. A token with no value is left as written. An app in this framework's format needs none of this: identity lives in `manifest.json` and the View reads its name from the identity document.

## 2. Catalogue (the marketplace)

A marketplace is a GitHub repository whose root holds `catalogue.json` (schema `catalogue.schema.json`), plus one folder per app:

```json
{ "version": "1.0.0",
  "apps": [ { "id": "kanban-board", "name": "Kanban Board", "description": "…", "folder": "kanban-board",
              "tags": ["productivity"], "version": "1.0.0", "preview": "https://…/thumbnail.png",
              "toolkit": "blueprint-react-node", "agentAppVersion": "0.1.0",
              "customizable": [ { "key": "APP_TITLE", "label": "Board title", "type": "text", "default": "Kanban" } ] } ] }
```

A catalogue without an `apps` list is refused. An entry that does not match the schema is dropped with a warning, so one bad listing never hides the rest.

**What an entry may require.** `catalogue` marks each entry `compatible` from what the entry itself lists, without downloading the app:
- `toolkit`: met when that toolkit is installed here;
- `agentAppVersion` (a string): met when it is on this CLI's line (the same major, and for 0.x the same minor);
- `livingUIVersion`, or a numeric `agentAppVersion`: a CraftBot Living UI app, which is never installable as is (§7).

`compatible` is `true` when everything listed is met, `false` with a `reason` when something is not, and `null` when the entry lists nothing: unknown is reported as unknown.

**Where the catalogue comes from:**
- `--source`, else `A2APP_MARKETPLACE`, else `marketplace` in `$A2APP_HOME/settings.json`.
- Each is `github:<owner>/<repo>[@<ref>]`, or a local directory holding `catalogue.json` and the app folders (offline use and tests). A relative directory is resolved against the working directory, or against `$A2APP_HOME` when it comes from `settings.json`.
- The default is `github:CraftOS-dev/agent-app-collection`, falling back to `github:CraftOS-dev/living-ui-marketplace` when the default cannot be read (not found, unreachable, or not a catalogue). The fallback applies to the default only; a configured source never falls back.
- A ref given in the source wins over `A2APP_MARKETPLACE_REF`, which wins over `main`. The default names no ref, so `A2APP_MARKETPLACE_REF` applies to it and to its fallback.

**How an app is delivered:**
- The catalogue is `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/catalogue.json`. It is strict JSON.
- The app comes from the branch archive of the same repository and ref, `https://github.com/<owner>/<repo>/archive/refs/heads/<ref>.zip`. From that archive the installer takes only `<root>/<folder>/`, matched by whole path segments.
- An entry with no `preview` has `<folder>/thumbnail.png` on the same ref.
- Downloads send a `User-Agent`, follow redirects, and are bounded while bytes arrive: 8 MiB and 30 s for a catalogue, 512 MiB and 10 minutes for an archive. A declared size over the cap is refused before the body is read.
- Limits: 512 MiB for the archive, 512 MiB for the extracted app (counted as it unpacks, not taken from the archive's index).
- Extraction refuses, before anything is written:
  - absolute paths and `..` segments, with `/` or `\` as the separator;
  - drive letters, and any `:` in a name (a drive or an alternate data stream on Windows); on Windows, device names;
  - entries that are links, or anything else that is not a file or a folder;
  - encrypted entries, and compression other than stored and deflate;
  - the same path twice, and a local header naming a different file than the archive's index;
  - an entry that unpacks past its declared size, or whose checksum does not match;
  - any entry that would land outside the target.
- `node_modules/` and `.git/` are never extracted.
- The archive's SHA-256 is recorded with the app (§4).

## 3. Sources

| Source | Written as | Trust |
|---|---|---|
| Marketplace app | `agent-app install <catalogue id> [--source <marketplace>]` | catalogued |
| Zip file | `agent-app install --from <file.zip>` (any file is read as a zip) | untrusted |
| Folder | `agent-app install --from <dir>` | untrusted |
| GitHub | `--from github:<owner>/<repo>[@<ref>][/<path>]`, or `--from https://github.com/<owner>/<repo>[/tree/<ref>/<path>]` (the branch archive, as in §2) | untrusted |
| Any git host | `--from git+<url>[#<ref>]` | untrusted |

- **GitHub:** in the shorthand, the ref ends at the first `/`. With no ref, `A2APP_MARKETPLACE_REF`, else `main`. An `https://` source is read only from github.com; any other host goes through `git+`.
- **Git:** a shallow clone with `git` on PATH: no submodules; no prompts of any kind (terminal, askpass, credential-manager window, SSH password), so a private repository fails instead of waiting; no hooks (no template is copied, and `core.hooksPath` points nowhere); the URL follows `--`, so it is never read as an option. `.git` is removed and the commit is recorded.
- **Folders** are copied, never moved: what §1 says a package never carries is left behind (the folder's own `.gitignore` included), and a link is refused.

`agent-app <dir> import` installs the folder `<dir>` in place, with the same pipeline and `untrusted` trust. It refuses a folder whose app is serving.

## 4. The install pipeline

Every source goes through the same steps, in this order. A step that fails stops the install, and nothing is left registered or half-placed.

1. **acquire**:
   - Download or copy the source into a fresh staging directory under `$A2APP_HOME/staging/`. The staging is removed however the install ends.
   - Nothing from the source runs.
2. **inspect**: classify the staged tree (§5). Only `agent-app` packages continue; anything else stops with the reason and the route to take (§7).
3. **sanitize**: remove everything §1 says a package never carries.
4. **revendor**: replace the system files from a **locally installed** toolkit.
   - The toolkit is chosen by the id in `.a2app/toolkit.json`, or by `--blueprint <id>`.
   - Never by a path from the package, and never from inside it: a toolkit folder of the same id inside the package (or inside the folder imported in place, which may be the working directory the id is first looked up in) is skipped.
   - An unknown toolkit stops the install.
   - The package's own copies of every system path go first, so a system file the template lacks, or an extra file inside a system folder, never survives into the canon.
   - The manifest is merged (the toolkit's `pipeline`; the app's identity, modules and `source`) and the canon is re-recorded.
5. **customize**: replace placeholders (§1) with the new identity and `--set KEY=VALUE` values. A catalogue key that is not set takes its `default`. For a catalogue app, `--set` names one of its `customizable` keys; it never names an identity token.
6. **place**:
   - Move the staged tree to the target: `--into <dir>`, which must be absent or empty; otherwise `$A2APP_HOME/apps/<slug>`, with `-2`, `-3`, … added on a clash.
   - The move is a single rename where the filesystem allows it; across filesystems, a copy beside the target and then a rename.
   - In place (`import`), the folder's entries move aside into a sibling and the new ones move in; the old entries are kept until the install ends, so a failure puts the folder back exactly as it was.
7. **register**:
   - Give the app a new `id` (12 hex characters).
   - Its `name` comes from `--name`, else the catalogue entry, else the manifest.
   - Reserve a free port and mint a fresh `.agent-token` (0600). The port customize wrote (`--port` when free) is the one reserved; if another app took it meanwhile and a port token was written, the install stops and can be run again.
   - Write the scaffold's ignore rules and harness guides, and link local toolkit packages (re-pointing a `file:` path the package carries from the machine it came from).
   - Record `source` (provenance) in `manifest.json`: `{ kind, location, ref?, catalogueId?, version?, sha256?, commit?, installedAt }`, where `kind` is `marketplace`, `zip`, `folder`, `github` or `git`. The canon is recorded over this final manifest.
8. **dependencies**: run the manifest's `pipeline.install`.
9. **gate**: `validate`. A failure stops the install; the app stays registered so it can be fixed, and the result says so.
10. **serve**: launch and health-poll, unless `--no-start`.
11. **open**: only with `--open`.

**`--no-start`** installs the files only: dependencies and serve are skipped (`agent-app <dir> serve --install` does both later), and the gate runs without its build step (`validate --no-build`).

**Trust decides what is still owed after a successful install:**
- **catalogued:** nothing. A marketplace app is not walk-verified.
- **untrusted:** walk-verify, run by a separate agent, before the app is used for real work. The result lists it under `next`.

## 5. Inspect

`agent-app inspect <catalogue id> [--source <marketplace>]` and `agent-app inspect --from <source>` stage the source, classify it, report, and delete the staging. Nothing is installed and nothing from the source runs. With `--keep <dir>` (absent or empty), the source is also kept there exactly as a package would carry it — no credentials, secrets, runtime state, data, `.git/`, `node_modules/` or build output — as the read-only reference a conversion rebuilds from (§7); the report gains `kept`. The report (schema `inspect-report.schema.json`):

| Field | Meaning |
|---|---|
| `kind` | `agent-app` (a framework manifest with `agentAppVersion` as a string, and `modules`), `living-ui` (a CraftBot Living UI manifest: `livingUIVersion`, or a numeric `agentAppVersion`), or `foreign` (no manifest, or any other). |
| `installable`, `reason` | Whether `install` would proceed, and why not. |
| `routes` | For a tree that is not a package, what can be done with it instead (§7): `convert`, `adopt`. |
| `source` | The provenance `install` would record (and the catalogue entry's `name`). |
| `app` | `name`, `authMode`, `modules`. |
| `toolkit` | `id`; `installed` (whether this machine has it); `adapterVersion` as `{ package, current }`. Null when the tree is not a package. |
| `integrity` | `intact`, `drifted` (listing the changed system files) or `absent`, against the package's own canon. |
| `pipeline` | The shell commands the app's toolkit will run. |
| `capabilities` | As declared. |
| `strips` | What sanitize would remove, and what acquire left behind. |
| `placeholders` | The tokens found. |
| `warnings` | Anything else to know. |

## 6. Export

`agent-app <dir> export [--out <file.zip>]` writes the app as a package: one top-level folder named after the app, everything §1 excludes left out, and `.a2app/toolkit.json` reduced to its `id`. `--out` defaults to `<slug>.zip` in the working directory, and never replaces an existing file. A link in the app is refused. It prints `{ ok, file, sha256, bytes, files }`. A zip it writes installs on another machine with `install --from`.

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
| `catalogue [--search <words>] [--source <src>]` | `{ ok, source:{ kind, location, repository?, ref?, fallbackFrom? }, apps:[…entry, compatible, reason?], warnings? }` |
| `inspect` | the report (§5) |
| `install` | `{ ok, id, name, dir, port, url?, trust, source, gate:{ ok, failures?, unchecked? }, served, opened?, via?, next:[…] }` |
| `export` | §6 |

`--search` keeps the entries whose id, name, description or tags contain every word, ignoring case.

An install that stops at any step but the gate is rolled back and prints `{ ok:false, step, error }` (`step` is the step that failed), plus `kind`, `reason` and `routes` when inspect stopped it, and exits `1`, `2` or `3` by the cause. One whose gate fails stays installed, prints the full result with `ok:false`, and exits `1`.

**With `--events`,** `install` writes one JSON object per line on stdout instead:
- `{ "event":"step", "step":"<name>", "status":"start|done|failed", … }` for each step in §4 that runs;
- `{ "event":"step", "step":"<name>", "status":"skipped", "reason":"…" }` once for a step that does not run on this install (`dependencies` and `serve` with `--no-start`, `open` without `--open`, `serve` and `open` after a failed gate);
- then `{ "event":"result", …result }` last.

UIs show progress from these lines. The step names are `acquire inspect sanitize revendor customize place register dependencies gate serve open`.
