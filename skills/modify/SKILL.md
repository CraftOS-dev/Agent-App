---
name: modify
activity: modify
description: Modify an existing Agent App — add features, change design, fix bugs — then re-validate, verify, and relaunch it. Load for a code change to an app that already exists. The creator skill's rules still apply.
---

# Modify

You are changing an EXISTING app. Everything in the **creator** skill applies
(ownership rule, modules-before-entities, schema/operations/UI order, honesty rule) — this skill covers
only what differs.

## First, route the request

Decide per request — nothing is routed in advance. A **data change**
(create/update/delete records, invoke an operation) is *operation*, not
modification: use the **operator** skill directly, no rebuild. A **code change**
(new feature, entity, operation, or UI change) continues below.

## Step 0: Locate and understand

1. Use the project directory you were given; read `AGENT_APP.md` (current
   plan/entities/operations) and `reference/requirements.md`. Read `manifest.json`
   for `authMode` and port. Not given a directory? `agent-app list` shows every known
   app with its path, port, and status, and commands accept a registered app id
   or name wherever they accept a directory.
   Also read `agent-app global` — the user's cross-app conventions apply to changes
   too, with this app's `reference/requirements.md` winning any conflict.
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

## Rules for changing a live app

- **Ownership is unchanged**: edit only your app/View code, schema migrations (NEW
  files only — never edit, rename, or delete an applied migration: the filename is
  its identity in the live DB, and a renamed one makes the app unable to boot),
  operation implementations, non-system `operations.json`, the trigger manifest,
  and `AGENT_APP.md`. Adding/changing an agent trigger: declare it in the trigger
  manifest first; fires of undeclared names are refused in-app.
- **Schema changes are additive migrations.** The user's data is live — never
  delete it, never drop-and-recreate collections that hold data. To alter a
  collection, write a new migration that loads and updates it. (Migration API and
  relation-field rules: **per your stack**.)
- Record the delta in `AGENT_APP.md` (what changed, new modules/entities/operations).
- **Adding an entity or operation? Name its module first.** Every one belongs to
  exactly one declared module (`manifest.json`), and an operation also needs
  typed `params` — plus `entity` and optionally `appliesWhen` when it acts on a
  record. The gate rejects a declaration that names no module or an undeclared one.
- **When a module outgrows its screen, split it.** Every describe level is capped
  at 2,000 characters and the gate walks the running app to check it. Growth means
  adding and splitting modules; lengthening a flat list is not an option the gate
  will accept. Record the split in `## Modules` in both `AGENT_APP.md` and
  `reference/requirements.md`.

## Finish

```
agent-app <dir> dev        # prepare a fresh, migration-replayed dev DB (starts NO server)
agent-app <dir> validate   # the gate
# then the walk-verify skill
agent-app <dir> stop       # promote refuses to run while the app is serving
agent-app <dir> promote    # pre-promote backup, then apply new migrations to live
agent-app <dir> serve      # bring the changed app back up
agent-app <dir> open       # and show it to the user (see below)
```

`promote` applies migrations and launches NOTHING, so a change is not in front of
the user until you serve again. Do not end a modify at `promote`.

**`dev` does not start a server, and there is no dev URL.** It runs the toolkit's
`lifecycle.dev`, which builds a fresh database and exits — no shipped toolkit boots
a second instance. Do not go looking for a hidden port; verify against the app you
serve after promoting, which is why the pre-promote backup is mandatory and
`agent-app <dir> restore` is the way back.

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
open, and no flag makes it. A loaded page can only be replaced from inside itself.
That is what the View's update watcher (`/_a2app/update.js` — see the blueprint's
README) is for: it notices identity's `appVersion` move and offers the person a
reload. It never takes one, because reloading a half-filled form destroys work.
Keep that script tag when you rewrite a View.

Either way, give the user the URL in your reply. `"opened": false` in the result
is NOT a failure — it means the environment has no browser to spawn (SSH, CI,
headless) and the printed URL is how the user gets there. `agent-app <dir> serve
--open` does the serve and the open in one step where you do not need the URL
first.

`agent-app dev` builds a **FRESH, EMPTY database** in an isolated dev directory by
replaying migrations, and proves your edited code loads. The user's live app is
untouched and its data is NEVER cloned into dev — the framework fingerprints the
live data directory before and after and aborts if the toolkit's dev command went
near it. What `dev` does NOT do is start a server: there is no dev instance and no
dev URL to point walk-verify at. Verification therefore happens against the app you
`serve` after promoting, which is why `agent-app promote` takes a mandatory
pre-promote backup, aborts if that backup fails, and `agent-app restore` rolls back.

- **The dev DB starts empty every time.** If a feature needs data to be visible,
  seed it in a migration (which survives promote).
- **Never run `agent-app validate` or `agent-app dev` in a way that rebuilds the live
  project dir in place** — it overwrites the served frontend and blanks the user's
  live UI.
- **Never write test data to the live app** (its DB is the user's real data; agent
  test writes outside the dev env are refused). Identity (`a2app <dir> identity`)
  answers `env: "dev"` or `"live"` if you need to confirm which instance a port is.

HONESTY RULE: the change is live only when walk-verify returns a pass — never tell
the user a change is live when the relaunch, verification, or promotion failed. On
failure the user's app still runs the previous working version, and you say so.
