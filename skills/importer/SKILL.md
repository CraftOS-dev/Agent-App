---
name: importer
activity: importer
description: Bring an app in, or send one out. Install a marketplace app; install an Agent App package from a zip, a folder or a git repository (inspect first, walk-verify after); convert a CraftBot Living UI app or foreign code by rebuilding it; adopt a foreign app to run as it is behind the sidecar adapter; export an app to share. Load for marketplace / install / import / adopt / convert / export.
---

# Importer

Every way in goes through **one install pipeline**, run by the CLI:

`acquire → inspect → sanitize → revendor → customize → place → register → dependencies → gate → serve → open`

It is what makes an app from elsewhere safe to have, so never do its work by
hand: never unzip a package into place, never copy one's credentials or data,
never re-vendor someone else's app yourself. What the pipeline guarantees:

- Nothing from the source runs before the dependencies step, and what runs then
  is the pipeline of a toolkit **installed on this machine**, chosen by the id
  the package records, never by a path it records.
- Credentials, data, runtime state, `.git/`, `node_modules/` and build output
  are dropped; the app gets a fresh identity, port and credential.
- A step that fails leaves nothing behind. The one exception is the gate: an app
  that fails it stays installed so it can be fixed, and the result says so.

Every command prints JSON on stdout (diagnostics go to stderr) and exits `0`
success, `1` rejected, `2` usage, `3` unreachable. Read the JSON; never scrape
the prose.

## Which path?

| The person has… | Do this |
|---|---|
| An app name, or "what's in the marketplace?" | **Marketplace** |
| A `.zip`, a folder, or a git or GitHub URL | **Inspect it**, then follow what it is: |
| … and it is an Agent App package (`kind: agent-app`) | **Install it** — untrusted, so walk-verified after |
| … and it is a CraftBot Living UI app (`kind: living-ui`) | **Convert** |
| … and it is anything else (`kind: foreign`) | **Adopt** or **Convert** — the person decides |
| An app of their own to give someone | **Export** |

## Marketplace

1. **Find the id:** `agent-app catalogue --search "<their words>"`. Install only
   an id this returns; never guess one. Each entry says whether it runs here:
   `compatible: true`; `false` with a `reason` (a Living UI app → **Convert**, a
   toolkit not installed here → say which); `null` when the entry states no
   requirement. `--source <marketplace>` reads another marketplace
   (`github:<owner>/<repo>[@<ref>]`, or a local directory).
2. **Confirm with the person:** which app, its name, and its `customizable`
   fields (offer each default).
3. **Install:** `agent-app install <id> [--set KEY=VALUE]… [--name "<name>"]`.
   The result's `trust` is `catalogued`: the app was verified upstream, so
   nothing more is owed — **no walk-verify**. Give the person its `url`.
4. **Consent is still theirs.** If the app declares integrations
   (`capabilities`) or queues work for agents, ask before granting any. Never
   start a bridge for it (`agent-app <dir> bridge start`): each task it queues
   becomes an agent run, a capability a person grants knowingly, for an app
   they chose.

## A zip, a folder, or a git repository

1. **Inspect first:** `agent-app inspect --from <source>`. Nothing is installed
   and nothing from it runs. `<source>` is:
   - a zip file (any file is read as a zip);
   - a folder (copied, never moved: the folder is left as it was);
   - `github:<owner>/<repo>[@<ref>][/<path>]`, or
     `https://github.com/<owner>/<repo>[/tree/<ref>/<path>]`;
   - any other git host: `git+<url>[#<ref>]`.
2. **Show the person the report, and ask.** Say what it is (`kind`), whether it
   is `installable` and why not, what **will run on their machine** (`pipeline`:
   the commands of the toolkit installed here, not the package's), what install
   **removes** (`strips`), whether its system files match its own record
   (`integrity`), what it declares (`capabilities`), and every `warnings` entry.
3. **An installable package:** `agent-app install --from <source> [--name "<name>"]`.
   Its `trust` is `untrusted`, and its `next` names what is owed: before the app
   is used for real work, a **separate** agent — never you, the installer — runs
   the walk-verify skill against it. Until then, report it as installed and
   unverified.
   - Not installable because its toolkit is not here: the `reason` names it.
     `--blueprint <id>` re-vendors it from another toolkit installed here, but
     that toolkit's system files replace the package's, so only with the
     person's agreement.
   - The person wants the app to stay in its folder: `agent-app <dir> import`
     runs the same pipeline in place (untrusted, the same walk-verify owed). It
     refuses a folder whose app is serving: `agent-app <dir> stop` first.
4. **Not a package:** the report's `routes` say what can be done instead —
   **Convert** (`convert`) or **Adopt** (`adopt`), below.

`install` is the same for both kinds of source: a source that turns out not to
be a package stops at `inspect`, with `{ ok: false, step: "inspect", kind,
reason, routes }`. Take it to the route; never force it.

## Convert — a rebuild

For a CraftBot Living UI app, or foreign code the person wants rebuilt as an
Agent App. **Tell the person the cost first:** nothing of the original code runs
afterward; its behaviour is re-implemented.

1. **Scaffold** a new app on the blueprint that fits what it does:
   `agent-app <dir> scaffold --blueprint <id>`.
2. **Keep the original as a read-only reference** — the CLI fetches it, from
   any source, without its credentials, data or build output:
   `agent-app inspect <catalogue id> --keep <dir>/reference/source`, or
   `agent-app inspect --from <source> --keep <dir>/reference/source`.
   Read it; never edit it, never run it.
4. **Synthesize `reference/requirements.md` from it** — its screens, its data,
   what each action does — and build it with the **creator** skill: feature by
   feature under the ownership rule, `agent-app <dir> validate`, launch, and a
   walk-verify by a separate agent before announcing it.

## Adopt — run it as it is

For a foreign app that must keep running unchanged: any HTTP app, in any stack.
The app runs from `upstream/`, and the sidecar adapter in front of it serves the
A2App surface and forwards each declared operation to one of its own routes.

1. **Scaffold on the sidecar blueprint:** `agent-app <dir> scaffold --blueprint blueprint-sidecar`,
   then read `<dir>/reference/blueprint.md` — the authoritative, step-by-step
   adopt guide. What follows is its outline.
2. **Place the source unchanged in `upstream/`.** Never edit it. If it cannot
   run here (a database server, private services, system packages), stop and
   tell the person exactly what is missing.
3. **Declare how it starts** in `sidecar.json`: an argv (never a shell
   string), `"port": "auto"` handed over as `{port}`, its environment, and a
   health path.
4. **Name the modules** from the grouping the app already has (OpenAPI tags,
   route prefixes, controllers), and **map its API**: one operation per thing an
   agent should be able to do, in `operations.json` (what it is: typed params,
   `destructive`, `readOnly`) and `sidecar.json` (which route it reaches). No
   server API means no operations: say so; never invent verbs or map database
   writes.
5. **Verify the mapping, not the app:** `agent-app <dir> validate`,
   `agent-app <dir> serve`, then invoke every non-destructive operation for real
   (`a2app <dir> <module> <operation> --…`); a destructive one is shape-checked
   (it answers `approval_required`), never fired. A mapping that does not work
   does not ship.

Tell the person what adoption gives them: it is **operate-only** — agents reach
the app through the mapped operations (`a2app <dir>`, then a module, then an
operation), with no entities and no `data` verbs — and **the app's own UI stays
at its own address**; the sidecar's port serves only the protocol and the
account page. Changes apply live: edit the declarations, stop, serve.

## Export — to share

`agent-app <dir> export [--out <file.zip>]` writes the app as a package: one
folder named after the app, without credentials, data, runtime state,
dependencies or build output, and with `.a2app/toolkit.json` reduced to its id.
It never replaces an existing file. It prints `{ ok, file, sha256, bytes, files }`:
give the person the file and its `sha256`. It installs on another machine with
`agent-app install --from <file.zip>`, where it is untrusted and walk-verified.

## Afterwards

- An installed or imported app is an ordinary Agent App: operate it with the
  `a2app` CLI (the walk: `a2app <dir>`, then the module, the entity, the
  operation; records through `a2app <dir> data <entity> …`), and change it with
  the **modify** skill. An adopted app has operations only.
- Never edit an app's system-owned files: the gate hashes them.
- `agent-app <dir> toolkit-sync` re-vendors from the toolkit the app *itself*
  records, path included, so it is for an app that is already yours, after its
  toolkit was updated. Never use it to bring in an app you were given: install
  and import re-vendor from a toolkit installed here, chosen by id.
- In a harness with the framework plugin, the same commands are the tools
  `agent_app_catalogue`, `agent_app_inspect`, `agent_app_install` and
  `agent_app_export`, and a manager tab's Marketplace and Import panels run
  them for the person; what is owed afterwards is the same.
