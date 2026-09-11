---
name: creator
activity: creator
description: Create a new Agent App. Scaffolds, develops, validates, and launches a local web app with persistent state and an agent-operable surface. Load when the user wants custom software built. This is the stack-agnostic method; load your blueprint's stack creator skill for the migration/hook/UI-kit specifics.
---

# Creator

An Agent App is a self-contained web app: a backend (data, auth, realtime,
custom operations) serving a frontend, with an **A2App adapter** as the ONLY
agent surface. You declare schema, compose UI, wire operations — the framework
and the adapter own the rest. A human uses the View; an agent operates the same
data through the adapter; both converge on one Model.

This skill is the method. If you scaffolded from a blueprint, ALSO load that
blueprint's **stack creator skill** — it carries the migration API, hook rules,
and UI-kit specifics you cannot get right from general knowledge. Where this
skill says "per your stack", that is where the stack skill applies.

## Step 0: Have a project

1. **You were given a project directory** → it is already scaffolded; use it,
   skip scaffolding.
2. **No project yet** → `agent-app <dir> scaffold --blueprint <id>` scaffolds the
   framework files, the adapter, and the ownership canon. Pick `authMode` from
   requirements: `none` (personal local tool — default) or `multi-user`
   (accounts).

## The ownership rule (the gate enforces this)

Edit ONLY agent-accessible paths: your app/View code, your schema migrations,
your operation implementations, the non-system entries of `operations.json`, and
`AGENT_APP.md` (your plan/context/index — keep it current). Exact paths are per
your blueprint.

NEVER edit system-owned files — the A2App adapter, `manifest.json`, vendored kit
files, build config. The validation gate hashes them (the ownership canon) and
**fails the build** if they changed, naming the file. Need a variant of a kit
component? Wrap it in your own app code; never edit the locked original.

## The spec comes first

`reference/requirements.md` is the app's binding spec, in two parts: **Part A
(SRS)** — what must exist; the verifier drives every statement in it — and
**Part B (Technical Specification)** — how it is built. The gate checks its
structure; walk-verify checks the running app against it.

1. **Read `AGENT_APP.md` and `reference/requirements.md`.** If the spec is
   already filled (the requirement was interviewed and synthesized upstream),
   it is binding: implement it exactly, skip to step 5. If it holds only the
   scaffold skeleton, YOU author it — steps 2–4.
2. **Gather before writing.** Ask the user ONE batch of clarifying questions —
   only what you genuinely cannot decide (audience, must-have features, data
   that must survive, what is explicitly out). Read the user's cross-app
   conventions (`agent-app global`): design preferences, their own
   always-rules, and ticked optional rules (ticked = requirement, unticked =
   not). Read the Agent App Quality Standard (`../QUALITY.md`, in the
   directory this skill was installed from) — reading it before writing
   Part B is MANDATORY: it is the bar the verifier judges every app against,
   and building to it the first time is the only path that does not loop.
3. **Author the spec — replace every `<REPLACE: …>` marker.** Each marker's
   text is its fill instruction; the gate refuses a spec that still carries
   one, so template text can never reach verification.
   - **Part A** from the user's answers. Features are the contract: grouped
     under `### Module: <name>`, stable IDs (`F-<MOD>-n`, never renumbered,
     never reused), every statement binary and observable by a stranger
     driving the app — "The user can <verb> …" / "The agent can <verb> …",
     `WHEN … SHALL` where behavior is conditional; states the user must see
     (empty, loading, error) are features too; one check per item — no
     compound sentences, no aspirations ("fast", "intuitive"), no
     implementation ("uses a modal"). Constraints enumerate their fixed
     vocabularies COMPLETELY; A-1 is always the judged data volume, as a
     number. **Out of Scope is exhaustive**: write what a reasonable builder
     would otherwise add, because scope nobody bounded is scope you will
     invent. Non-Functional Requirements carry only this app's measurable
     bars — quality decisions belong in Quality Conformance.
   - **Part B** from the Quality Standard and the global conventions. UI
     Design: adopt the blueprint's design system and extend its tokens
     (never fork a second one); one Screen entry PER SCREEN — primary
     object, primary action, all five states, and narrow-width behavior
     (decided here, not improvised in code; every device named in User
     Characteristics must have matching decisions). **Quality Conformance
     is where your QUALITY.md reading becomes visible: all 18 entries,
     Q1–Q18, each answered with THIS app's concrete decisions** — "standard
     defaults" is not an answer for Q1–Q11; N/A only with the reason; the
     gate fails a missing entry, and the verifier fails an entry that is not
     true in the running app. Mirrored global rules and any item overrides
     (number + factual reason + revisit condition) go in `### Conventions
     and overrides` — the ONE location the verifier reads. Process Flows
     only where a lifecycle exists; Operations Design must match
     `operations.json` exactly.
4. **Get the user's approval on Part A before building.** Present a short
   summary — the goals, the Features list, and Out of Scope — and ask once.
   Corrections go into the spec first. On approval, record the date in
   `### Approval`; Part A is frozen from that moment (changes go through
   `## Changes`), while Part B keeps evolving with the build — additions
   yes, silent contradictions of Part A never.
5. **Derive `reference/tasks.md` from the approved spec.** One task per
   feature (or coherent feature group), and quality work as tasks of its own
   — motion, focus flow, narrow-width behavior, resilience — each citing the
   Feature ID or Q-entry it implements (`- [ ] T-1 (F-COR-1): …`), ending
   with the Verification tasks. Tick tasks as you complete them, never in a
   batch at the end; never delete a completed task — the ledger is the build
   record, and evolution appends to it.
6. **Any feature need data from outside the app? Check, then research.** FIRST
   check whether a connected integration already covers the feature — if so, use
   it; nothing to research. Only for THIRD-PARTY public APIs: research like an
   engineer — endpoint, auth, response shape, limits — before writing a line;
   never write an integration from memory. If it needs a key/tenant/account you
   cannot find online, ask the user and build the rest while waiting. If the user
   named no API, research candidates and pick a keyless public one yourself.
   Nothing usable exists → build the honest empty/offline state and REPORT the
   blocker. **Mock or generated data is forbidden** unless requirements explicitly
   ask for demo data — a mock that renders is a lie that passes review.

## Before any feature: name the modules

**Modules are decided first, and they are decided once.** Every entity and every
operation belongs to exactly one, they are declared in `manifest.json`, and they
are what an agent sees when it opens the app — the root screen of `describe`
lists them and nothing else.

Read the `## Features` and `## Operations Design` sections of
`reference/requirements.md` and group them into 3–8 areas a person would
recognise as tabs: `sales`, `inventory`, `support`. Write them into
`manifest.json` and into `## Modules` in `AGENT_APP.md` (the spec's Features
are already grouped by module) BEFORE declaring an entity or an operation,
because each of those has to name one.

Two rules that keep this honest as the app grows:

- **A module must fit its screen.** Every describe level is capped at 2,000
  characters and the gate walks the running app to check it. A module whose
  screen would overflow gets split — that is how an app grows. Lengthening a
  flat list is not.
- **Never use a reserved name**: `data`, `identity`, `whoami`, `context`,
  `tasks`, `events`. The operate CLI resolves those first, so a module with one
  of those names is unreachable and the gate rejects it.

## Per feature: schema → operations → UI

**Schema** — add a NEW migration. **Never edit AND never rename or delete a
migration that has been applied** (after any successful launch): the filename is
its identity in the live database; renaming one makes every boot re-run its
"new" replacement into the existing schema and the app cannot start. Fixing a
migration's mistake = writing a NEW migration that alters the collection. Match
the app's `authMode`: open data rules for `none`; owner-scoped for `multi-user`.
(Migration API, seeding, relation fields: **per your stack**.)

**Schema** — every entity also names the `module` it lives in, and may carry a
one-line `summary` shown beside it on that module's screen.

**Custom operations** — anything beyond plain CRUD is a declared operation:
implement it behind the adapter PLUS a matching entry in `operations.json`. The
gate fails an operation with no implementation (a toolkit "operations resolve"
step), and fails the app part if a declaration is inconsistent. Plain CRUD needs
no operation — the data API covers it.

Each declaration carries four things beyond its name:

- `module` — which screen it appears on. Required.
- `params` — **typed**, using the same vocabulary as entity fields. Required; use
  `{}` when it takes no arguments. The record screen renders this as the
  operation's signature, so arguments described in prose inside `description`
  can be neither shown nor checked. Writing `"Args: { category? }"` in the
  description does NOT satisfy this.
- `entity` — the entity it acts on, when it acts on one record. This is what puts
  it on that entity's and that record's screens instead of only the module's.
- `appliesWhen` — an optional condition over the record's own fields deciding
  whether it is available on a given record, e.g.
  `{ "field": "status", "ne": "done" }`. The adapter evaluates it and derives the
  "blocked" reason from it. Comparisons only (`eq`, `ne`, `in`, `notIn`,
  `isBlank`, composed with `all`/`any`/`not`) — never a natural-language rule.

**Flags:** mark data-deleting operations `"destructive": true` (they require
human approval). Also set `"readOnly": true` when an operation has no side
effects, and `"idempotent": true` when repeating it is safe — an agent uses both
to plan and to retry, and neither is assumed when absent.

**Naming: kebab-case, and every place the name appears must agree** — the
`operations.json` name, the route, and every frontend call. Pick the names once,
before writing any of them.

**Load-time calls must survive an EMPTY database.** A fresh app has no records:
never call an operation or a filtered query at page load that fails without data
— gate them behind existence checks. The verifier fails the app on any
first-paint error.

**External data (third-party APIs)** — call the internet from the **backend
only** (never the frontend: browser CORS breaks and keys would be visible).
(HTTP-from-backend API: per your stack.)

**UI** — build the View from your blueprint's kit; the adapter is the only agent
surface, so never make the agent drive the DOM to operate the app. Build every
screen to the Quality Standard (`../QUALITY.md`) — in particular, design every
reachable state, not only the happy path: loading (skeletons, no layout jump),
empty (says what belongs here, offers the action that fills it), error (what
happened + what to do next), in-flight (control disabled, no double submit),
success (visible where the user is looking, read back from what was STORED).
Destructive actions confirm in the app's own dialog, naming the target. All
colours, spacing, and type come from your tokens — never hardcode a value where
a token exists. (Kit components and data hooks: per your stack.)

After each feature: update `AGENT_APP.md` (entities, operations) and tick the
completed tasks in `reference/tasks.md`.

**App→agent triggers** — when a feature needs the AGENT to react to something in
the app, declare it in the trigger manifest and fire it by **name + validated
params only**; the instruction the agent runs is read from the declared manifest,
never from the fire payload (so a compromised app cannot steer the agent beyond
what its author declared). Make instructions idempotent; set generous cooldowns.
Declare a trigger only where agent judgment adds value — plain code handles plain
events. (Manifest format and fire API: per your stack.)

## Finish: gate, launch, then verify

1. **`agent-app <dir> validate`** runs the gate (app-part consistency → build →
   migrations-on-a-fresh-db → operations resolve → ownership canon → describe
   budget). On errors: read ALL of them, fix ALL of them, run it again. Then
   `agent-app <dir> dev` boots your code in a DEV copy on a hidden port with a
   fresh post-migration DB. Test and read logs THERE; keep editing in the real
   project dir. Never start servers by hand.
   A step the gate reports **UNCHECKED** did not pass — it could not run. The
   budget step needs the app running, so re-run `validate` after `serve`/`dev`
   rather than treating the warning as a pass.
2. **REALITY CHECK — look at what actually exists, not at what you wrote.** Success
   messages lie by omission; stored state does not. While the app runs:
   - `a2app <dir>` → does the root show the modules you declared, with the entity
     counts you expect? A module reading `0 entities` means nothing was filed
     under it.
   - `a2app <dir> <module> <entity>` → does the entity show the FIELDS you
     migrated? An entity showing only `id` means your migration silently did
     nothing.
   - `a2app <dir> <module> <entity> <id>` on a real record → is each operation
     available when it should be, and blocked with a sensible reason when it
     should not? A wrong `appliesWhen` shows up here and nowhere else.
   - Trigger one real data flow, then read a record back and LOOK at the values.
     Missing fields, empty strings, all-zero numbers = the write silently failed,
     whatever status it returned.
   - Any path you CANNOT trigger for real (a scheduled send, a post to the user's
     accounts): **dry-run it** — validate grant, params, and confirmation without
     executing. A path never run NOR dry-run is not done.
   Reason about ANY mismatch between what you intended and what is stored; fix it
   before verifying. This catches the failure classes no error message reports.
3. **Quality self-review — before handing off, not instead of it.** Every
   Build task in `reference/tasks.md` is ticked first — an unticked task is
   unfinished work, not a verification candidate. Then walk your own app once
   against `../QUALITY.md`, section by section: resize to a phone width,
   drive one flow keyboard-only, look at the empty state on a fresh database,
   trigger one error, read every visible string. Fix what you find NOW — the
   verifier will find it otherwise, and every defect it reports costs a full
   fix-and-re-verify loop. This review does not replace verification: you are
   the builder, and the builder does not grade itself.
4. **walk-verify** — run the walk-verify skill: an independent run (NOT you) walks
   the running app in a real browser against `reference/requirements.md` AND the
   Quality Standard. A pass is what promotes and announces the app. Failures come
   back as a report (features and Q-numbered quality items): fix them, then
   repeat step 1 and step 4.

Test data is fine during the build — the dev DB is disposable; at delivery the
LIVE app boots with a fresh database built purely from your migrations, so records
you or the verifier created never reach the user. Data your migrations SEED
survives. Externally-fetched data does not carry over: an app that syncs from an
API must self-populate on an empty DB (fetch at boot or when the collection is
empty).

## HONESTY RULE

The app is ready ONLY when walk-verify returns a pass. If you cannot make it pass,
tell the user the build **failed** and exactly what's blocking. Never claim a
broken app is ready, and never present generated data as live — "live" means the
app fetched it from the real source.

## FORBIDDEN

- Editing any system-owned file (the gate fails on canon drift).
- Editing an already-applied migration — add a new one.
- Making the agent drive the DOM to operate the app — the adapter is the surface.
- Custom fetch layers, polling, or page reloads where the kit's realtime hooks
  exist — use them.
- Mock/random data standing in for external data — unreachable source means an
  honest empty state plus a report, not a simulation.
- Printing or committing credentials (`.agent-token` and equivalents).
- Starting servers by hand.
- Announcing completion before walk-verify returns a pass.
