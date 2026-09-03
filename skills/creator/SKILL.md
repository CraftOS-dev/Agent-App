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
2. **No project yet** → `agent-app scaffold <dir> --blueprint <id>` scaffolds the
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

## Before coding

1. Read `AGENT_APP.md` and `reference/requirements.md`. The requirement was
   interviewed and synthesized before the build — it is the **binding spec**:
   implement it exactly and mirror its checklist into `AGENT_APP.md`. If it is
   absent, build from the description; ask the user only when something is
   genuinely blocking and you cannot reasonably decide it yourself.
2. **Read the user's cross-app conventions: `agent-app global`.** These are the rules
   they want in EVERY app they own (design preferences, always-enforced quality
   rules, ticked optional rules). Apply them as defaults — but this app's own
   `reference/requirements.md` WINS on any conflict: the global file is the
   default, not the law. Ticked optional rules are requirements; unticked ones
   are not.
3. **Any feature need data from outside the app? Check, then research.** FIRST
   check whether a connected integration already covers the feature — if so, use
   it; nothing to research. Only for THIRD-PARTY public APIs: research like an
   engineer — endpoint, auth, response shape, limits — before writing a line;
   never write an integration from memory. If it needs a key/tenant/account you
   cannot find online, ask the user and build the rest while waiting. If the user
   named no API, research candidates and pick a keyless public one yourself.
   Nothing usable exists → build the honest empty/offline state and REPORT the
   blocker. **Mock or generated data is forbidden** unless requirements explicitly
   ask for demo data — a mock that renders is a lie that passes review.

## Per feature: schema → operations → UI

**Schema** — add a NEW migration. **Never edit AND never rename or delete a
migration that has been applied** (after any successful launch): the filename is
its identity in the live database; renaming one makes every boot re-run its
"new" replacement into the existing schema and the app cannot start. Fixing a
migration's mistake = writing a NEW migration that alters the collection. Match
the app's `authMode`: open data rules for `none`; owner-scoped for `multi-user`.
(Migration API, seeding, relation fields: **per your stack**.)

**Custom operations** — anything beyond plain CRUD is a declared operation:
implement it behind the adapter PLUS a matching entry in `operations.json`. The
gate fails operations without an implementation. Mark data-deleting operations
`"destructive": true`. Plain CRUD needs no operation — the data API covers it.
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
surface, so never make the agent drive the DOM to operate the app. Required UX:
empty states with an action, loading states, confirmation dialogs for destructive
actions, feedback on writes, responsive layout. Never hardcode colors — theming
is host-owned. (Kit components and data hooks: per your stack.)

Update `AGENT_APP.md` after each feature (entities, operations, checklist).

**App→agent triggers** — when a feature needs the AGENT to react to something in
the app, declare it in the trigger manifest and fire it by **name + validated
params only**; the instruction the agent runs is read from the declared manifest,
never from the fire payload (so a compromised app cannot steer the agent beyond
what its author declared). Make instructions idempotent; set generous cooldowns.
Declare a trigger only where agent judgment adds value — plain code handles plain
events. (Manifest format and fire API: per your stack.)

## Finish: gate, launch, then verify

1. **`agent-app validate <dir>`** runs the gate (build → migrations-on-a-fresh-db →
   operations resolve → ownership canon). On errors: read ALL of them, fix ALL of
   them, run it again. Then `agent-app dev <dir>` boots your code in a DEV copy on a
   hidden port with a fresh post-migration DB. Test and read logs THERE; keep
   editing in the real project dir. Never start servers by hand.
2. **REALITY CHECK — look at what actually exists, not at what you wrote.** Success
   messages lie by omission; stored state does not. While the app runs:
   - `a2app data <dir> schema` (describe) → does every entity show the FIELDS you
     migrated? An entity showing only `id` means your migration silently did
     nothing.
   - Trigger one real data flow, then read a record back and LOOK at the values.
     Missing fields, empty strings, all-zero numbers = the write silently failed,
     whatever status it returned.
   - Any path you CANNOT trigger for real (a scheduled send, a post to the user's
     accounts): **dry-run it** — validate grant, params, and confirmation without
     executing. A path never run NOR dry-run is not done.
   Reason about ANY mismatch between what you intended and what is stored; fix it
   before verifying. This catches the failure classes no error message reports.
3. **walk-verify** — run the walk-verify skill: an independent run (NOT you) walks
   the running app in a real browser against `reference/requirements.md`. A pass
   is what promotes and announces the app. Failing features come back as a report:
   fix them, then repeat step 1 and step 3.

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
