# Blueprint reference — base (stack-agnostic)

This blueprint ships **framework files only — no runtime code**. You pick the
stack (language, server, store, frontend) and wire it yourself, then build the
A2App adapter that makes the app agent-operable. Maximum flexibility, most work.

Where the `creator`/`modify` skill says "per your stack", the answer is here. If
this file and the source disagree, the source wins.

## Read this first

The scaffold gives you the framework files; you supply the whole stack and build
every part of the app yourself:

- **entities** — a data model the adapter derives `describe` from (see **What you
  must add** below);
- **custom operations** — declared in `operations.json`, each reaching an
  implementation you write (see **What you must build**);
- **the View** — a human UI over the records API, when the app is human-facing.

Don't start from scratch: copy the shape from the runnable blueprint closest to
your stack — see **Copy the shape from a real blueprint** below.

## Copy the shape from a real blueprint

The three runnable blueprints are complete, conforming references — read the one
closest to your stack and mirror it (including its `reference/blueprint.md`):

- **`blueprint-react-node`** — Node `http` + JSON store + a full vanilla-SPA kit.
  The most complete worked example, UI included.
- **`blueprint-python-fastapi`** — FastAPI + an in-process Python adapter.
- **`blueprint-pocketbase-react`** — PocketBase + adapter-as-hooks.

The normative contract is `requirement.md` (framework) and `requirement_A2App.md`
(protocol); the machine-checkable schemas are in `spec/v0_1/schema/`. Where prose
and schema disagree, the schema wins.

## What you must build (the adapter contract)

Whatever the stack, the app is conforming only when it presents a complete A2App
adapter as the **single agent surface**:

- **Identity** at `GET /api/_a2app` — `a2app: true`, protocol/adapter versions,
  app id/name, and a `schemaVersion` **derived** from the live model (never
  hand-maintained).
- **Describe** — navigational, one request per place in the app (root → module →
  entity → record → sub-resource). **Every level ≤ 2,000 characters**; trim long
  lists and report what was dropped. The gate walks the running app to enforce
  this.
- **Records API** — CRUD over your entities, with a **guard** that validates the
  raw write body before storage and rejects with the shared rule vocabulary
  (`unknown_field`, `read_only_field`, `invalid_date`, `invalid_enum`, …). Match
  `@a2app/rules` behavior; the conformance suite is the oracle.
- **Operations** — declared in `operations.json` (typed `params`, optional
  `entity` + `appliesWhen`, `destructive`/`readOnly`/`idempotent` flags), each
  reaching a real implementation, destructive ones gated by approval.
- **Availability predicates** — `eq`/`ne`/`in`/`notIn`/`isBlank` composed with
  `all`/`any`/`not`; the same predicate + record must yield the same availability
  and the same blocked reason everywhere. Never a natural-language rule.

**Modules come first.** Declare them in `manifest.json`; every entity and
operation names exactly one; describe's root lists them. Never use a reserved
first segment: `data`, `identity`, `whoami`, `context`, `tasks`, `events`.

## File map — what ships

Only framework files ship — there is **no runtime code**. Every file present on a
fresh scaffold:

| Path | Owner | What it is |
|---|---|---|
| `manifest.json` | SYSTEM (hash-locked) | app identity, `modules[]`, `authMode`, and the `pipeline` (install/build/start/health) you fill in for your stack. |
| `operations.json` | **YOURS** | operation declarations (name, module, typed params, entity, appliesWhen, flags). Starts empty. |
| `AGENT_APP.md` | **YOURS** | this app's index: plan, modules, entities, operations, conventions, checklist. |
| `reference/requirements.md` | **YOURS** | the binding spec — Part A (SRS) + Part B (tech spec + Quality Conformance). |
| `reference/tasks.md` | **YOURS** | the build ledger — one task per feature/quality item, ticked as you complete it. |
| `reference/blueprint.md` | reference | this file — the stack map. |
| `.gitignore` | **YOURS** | credentials, framework state, and the live DB stay out of git. Extend it for your stack. |

## What you must add — and where to put it

Nothing below ships; you create it. You choose the layout, but every Agent App
needs each part. Register any system-owned files you add (adapter, vendored kit)
in the ownership canon so the gate protects them. Mirror a runnable blueprint for
the concrete shape.

| Part | Typical file(s) | What it does |
|---|---|---|
| server / HTTP entry | e.g. `server.js`, `main.py` | reads the port from the `PORT` environment variable that `serve` sets (do NOT rely on the shell to expand `${PORT}` in `pipeline.start` — cmd.exe does not); routes `/api/**` to the adapter; serves the frontend. |
| A2App adapter | e.g. `adapter.*` | the only agent surface: identity, describe, guarded records CRUD, operations. Mark system-owned. |
| data model | e.g. `schema.*` | entities + fields the adapter derives `describe`/`schemaVersion` from. |
| store | a DB or JSON file under `data/` | persists records; must live inside `lifecycle.dataDir`. |
| frontend (View) | e.g. `public/**` | the human UI over the same records API (expected for human-facing apps). |
| build config | e.g. `package.json`, `requirements.txt` | dependencies + the build/start commands the pipeline runs. |

## Wire your own gate steps

This blueprint declares **no toolkit gate steps**, so operation resolution and
migration/schema replay are **UNCHECKED** by default. Add stack-specific steps to
`a2app.toolkit.json`'s `gate[]` (e.g. a syntax check, a fresh-DB migration
replay, and an "operations resolve" step that fails when a declared operation has
no implementation) — mirror how the runnable blueprints define theirs. Until you
do, `agent-app validate` will warn that these went unchecked; treat that as work
remaining, and self-verify in the REALITY CHECK.

## Build, run, gate

Fill in `manifest.json`'s `pipeline` (`install`/`build`/`start`/`health`) for your
stack, then:

```bash
agent-app <dir> validate   # framework files → build → your gate steps → ownership canon → describe budget
agent-app <dir> serve      # launch via the pipeline; prints the URL
```

Never start a server by hand. `lifecycle.dataDir` is `data/` — persist the live
database there and keep it out of version control.
