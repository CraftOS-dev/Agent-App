---
name: modify
activity: modify
description: Modify an existing Agent App — add features, change design, fix bugs — then re-validate, verify, and relaunch it. Load for a code change to an app that already exists. The creator skill's rules still apply.
---

# Modify

You are changing an EXISTING app. Everything in the **creator** skill applies
(ownership rule, modules-before-entities, schema/operations/UI order, the Agent
App Quality Standard, honesty rule) — this skill covers only what differs.

The Quality Standard (`../QUALITY.md`) applies to every change: a modification
that leaves a screen below the standard — or drags one below it — comes back
from the verifier as a defect. Changed screens use the app's existing design
tokens and components; a change that introduces a second visual system is a
defect, not a refresh. If the change must break a specific item, record the
item number and reason in `### Conventions and overrides` (Part B,
`## Quality Conformance`) in `reference/requirements.md`, exactly as at
creation. A change that alters a Quality Conformance decision updates that
Q-entry in the same edit — the entries describe the app as it IS.

## First, route the request

Decide per request — nothing is routed in advance. A **data change**
(create/update/delete records, invoke an operation) is *operation*, not
modification: use the **operator** skill directly, no rebuild. A **code change**
(new feature, entity, operation, or UI change) continues below.

## Step 0: Locate and understand

1. Use the project directory you were given; read `reference/blueprint.md` (your
   stack's map — files, schema/migration API, operations, UI, gate), `AGENT_APP.md`
   (current plan/entities/operations) and `reference/requirements.md`. Read `manifest.json`
   for `authMode` and port. Not given a directory? `agent-app list` shows every known
   app with its path, port, and status, and commands accept a registered app id
   or name wherever they accept a directory.
   Also read `agent-app global` — the user's cross-app conventions apply to changes
   too, with this app's `reference/requirements.md` winning any conflict. A global
   rule (ticked or user-written) that touches what you are changing gets mirrored
   into `### Conventions and overrides` (Part B, `## Quality Conformance`) if it is not
   there yet — the verifier reads only the app's spec and the Quality Standard.
2. If something broke, **read the logs FIRST** before changing anything — the real
   cause is in them, not in your guess.
3. If the request is ambiguous, ask one batch of clarifying questions, then wait.
4. **Record the request in the spec BEFORE editing code**: append a dated entry to
   `reference/requirements.md` under a `## Changes` section (create it if absent),
   stated as a checkable capability:
   `- 2026-01-15: the user can archive a board`.
   NEVER rewrite the existing sections — they are the delivered contract; `## Changes`
   is append-only. The verifier checks every entry there, so an unrecorded change is
   an unverified change (and a recorded one can never be silently dropped by a later
   modify).
   - **Supersession — the one permitted edit to old entries**: when the new request
     REVERSES or REPLACES an earlier `## Changes` entry (the user changed their mind,
     or the old entry demanded an approach the platform now rejects), wrap the stale
     entry in `~~strikethrough~~` — do not delete it (it stays as history) and do not
     leave it live (the verifier enforces every unstruck line, and contradictory live
     entries make the spec unsatisfiable: an app once went STUCK three times because
     old entries demanded a handler the gate forbids while the new entry forbade it —
     no code could satisfy both). Strike ONLY entries the new request genuinely
     contradicts, never entries you merely failed to build.
5. **Append the work to `reference/tasks.md`** before coding it: one task per
   `## Changes` entry (or coherent group), citing the entry —
   `- [ ] T-n (Changes 2026-01-15): …`. Tick on completion; completed tasks are
   never deleted. The gate requires the ledger; the recorded-then-built order is
   what keeps the spec, the tasks, and the code telling one story.

## Rules for changing a live app

- **Ownership is unchanged**: edit only your app/View code, schema migrations (NEW
  files only — never edit, rename, or delete an applied migration: the filename is
  its identity in the live DB, and a renamed one makes the app unable to boot),
  operation implementations, non-system `operations.json`, your app's declared
  event types, and `AGENT_APP.md`. Adding an app→agent trigger: declare the event
  type first, where your blueprint declares them — an undeclared type is refused
  at the moment of firing, inside the operation, in front of a user. Removing one
  is a breaking change for anything polling that capability.
- **Schema changes are additive migrations.** The user's data is live — never
  delete it, never drop-and-recreate collections that hold data. To alter a
  collection, write a new migration that loads and updates it. (Migration API and
  relation-field rules: see `reference/blueprint.md`.)
- Record the delta in `AGENT_APP.md` (what changed, new modules/entities/operations).
- **Adding an entity or operation? Name its module first.** Every one belongs to
  exactly one declared module (`manifest.json`), and an operation also needs
  typed `params` — plus `entity` and optionally `appliesWhen` when it acts on a
  record. The gate rejects a declaration that names no module or an undeclared one.
- **When a module outgrows its screen, split it.** Every describe level is capped
  at 2,000 characters and the gate walks the running app to check it. Growth means
  adding and splitting modules; lengthening a flat list is not an option the gate
  will accept. Record the split in `## Modules` in `AGENT_APP.md`, in the spec's
  `## System Overview` map, and regroup the affected Features under the new
  `### Module:` headings.

## Finish

```
agent-app <dir> dev        # boot the CANDIDATE on a hidden port with a fresh DB
agent-app <dir> validate   # the gate — measures the dev instance, records the gate pass
# then the walk-verify skill — the verifier drives the dev URL
agent-app <dir> stop       # stop the LIVE app (promote refuses while it serves; dev stays up)
agent-app <dir> promote    # requires the gate pass; backup, apply migrations, destroy dev
agent-app <dir> serve      # bring the changed app back up
agent-app <dir> open       # and show it to the user (see below)
```

**How the dev environment works — read this once, it removes all guesswork:**

- **Nothing is copied. Your edits ARE the running candidate.** `dev` boots the
  project's own tree a second time on a hidden port with a fresh database and
  `A2APP_ENV=dev`. The live app (if serving) keeps running the code and View it
  loaded at its own boot, untouched — edit freely while the user works.
- **The dev database is disposable and rebuilt from your migrations on every
  `dev`.** Only data your migrations seed exists; live data is NEVER cloned in.
  Reference data the app needs must be seeded in a migration (it survives
  promote); test records you create through the dev app are thrown away with
  the instance. Each `dev` re-proves the whole migration chain from empty.
- **While the dev instance is up, every operate command targets IT
  automatically** — `a2app <dir> …`, `data`, and `validate`'s budget walk. You
  never pass the hidden port yourself (it is in `dev` output and
  `.a2app/dev.json` when a browser needs it). If the instance died, operate
  commands refuse loudly with the remedy — they never silently fall back to
  live, so test writes cannot leak into user data.
- **View edits are hot on dev** (refresh the page); **backend/hook edits need
  `agent-app <dir> dev` again** (a fresh boot is cheap and re-proves the
  chain). The live app serves a boot-time snapshot of the View, so nothing you
  edit reaches users until promote + serve.
- **`promote` refuses without a fresh gate pass.** `validate` records a pass
  bound to the exact tree it gated, and only counts as promotable when the
  budget walk ran against the dev instance. Any edit after `validate`
  invalidates the pass — the order is always: edit → `dev` (if backend
  changed) → `validate` → promote. On success promote destroys the dev
  instance; on failure it keeps it (and the pass) for the retry.
- Abandoning a change? `agent-app <dir> stop --dev` tears the candidate down
  and routes operate commands back to live.

`promote` applies migrations and launches NOTHING, so a change is not in front of
the user until you serve again. Do not end a modify at `promote`.

**Showing the app to the user.** A running app is not a delivered app until the
person can see it. The framework cannot know what your harness can do, so YOU
decide which of these you are:

- **You have a browser tool** (a built-in browser pane, a Chrome extension):
  run `agent-app <dir> open --print-only` and open the returned `url` with your
  own tool, so the app appears in context. `--print-only` is what stops the CLI
  also spawning a separate window — without it the user gets two.
- **You do not**: run `agent-app <dir> open`. It uses the opener the harness
  declared (`AGENT_APP_OPEN_CMD`), else the OS browser.

`open` hands a URL to the browser; it CANNOT reload a tab the user already had
open. A loaded page can only be replaced from inside itself, which is what the
View's update watcher (`/_a2app/update.js` — see `reference/blueprint.md`) is for.
After a code change it reloads the tab itself when the page holds no unsaved
input, and falls back to offering a reload when it does — a half-filled form is
never discarded without asking. **Use `agent-app <dir> open --if-needed`** after a
promote: it opens a browser only when nobody already has the app on screen, so a
tab that is about to reload itself does not also get a duplicate opened over it.
Keep that script tag when you rewrite a View.

A DATA change is different and must not reload: the watcher announces it as a
`a2app:datachange` event on `window` (identity's `dataVersion` moved) and the
View re-reads. If you rewrite a View, keep a listener for it, and guard the
re-render the same way — re-rendering over a form someone is filling in loses
their work exactly as a reload would.

Either way, give the user the URL in your reply. `"opened": false` in the result
is NOT a failure — it means the environment has no browser to spawn (SSH, CI,
headless) and the printed URL is how the user gets there. `agent-app <dir> serve
--open` does the serve and the open in one step where you do not need the URL
first.

- **The dev DB starts empty every time.** If a feature needs data to be visible,
  seed it in a migration (which survives promote).
- **Never write test data to the live app** (its DB is the user's real data). You
  should never need to try: while the dev instance is up, every `a2app` command
  targets it, and the live View is a boot-time snapshot your edits cannot reach.
  Which instance you are talking to is a structural fact — the operate client
  verifies the dev route before answering — not something you infer from a port
  number.
- **If promote or the promoted app goes wrong**, the mandatory pre-promote backup
  is the way back: `agent-app <dir> restore` captures current state first and
  rolls back automatically on failure.

HONESTY RULE: the change is live only when walk-verify returns a pass — never tell
the user a change is live when the relaunch, verification, or promotion failed. On
failure the user's app still runs the previous working version, and you say so.
