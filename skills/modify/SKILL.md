---
name: modify
activity: modify
description: Modify an existing Agent App — add features, change design, fix bugs — then re-validate, verify, and relaunch it. Load for a code change to an app that already exists. The creator skill's rules still apply.
---

# Modify

You are changing an EXISTING app. Everything in the **creator** skill applies
(ownership rule, schema/operations/UI order, honesty rule) — this skill covers
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
- Record the delta in `AGENT_APP.md` (what changed, new entities/operations).

## Finish

```
agent-app <dir> dev        # boot a disposable dev copy (fresh, migration-replayed DB)
agent-app <dir> validate   # the gate, against the dev copy
# then the walk-verify skill against the dev URL
agent-app <dir> promote    # pre-promote backup, then apply new migrations to live
```

`agent-app dev` boots a disposable copy of your new CODE on a hidden port with a
**FRESH, EMPTY database** — migrations replay at boot, so only data your migrations
seed exists. The user's live app keeps running the previous version, untouched, and
its data is NEVER cloned into dev. Test freely against the dev URL (create whatever
test records you need — they are thrown away). walk-verify drives the dev instance
in a real browser; a clean verdict is what lets `agent-app promote` apply your change to
the live app (new migrations apply to the real data at its boot). `agent-app promote`
takes a mandatory pre-promote backup and aborts if the backup fails; `agent-app restore`
rolls back.

- **The dev DB starts empty every time.** If a feature needs data to be visible,
  either seed it in a migration (survives promote) or create test records after
  `agent-app dev` (dev-only, disposable).
- **Never run `agent-app validate` or `agent-app dev` in a way that rebuilds the live
  project dir in place** — it overwrites the served frontend and blanks the user's
  live UI. `agent-app dev` gates the dev copy for you.
- **Never write test data to the live app** (its DB is the user's real data; agent
  test writes outside the dev env are refused). Do all testing against the dev URL.
  Identity (`a2app <dir> identity`) answers `env: "dev"` or `"live"` if you need to
  confirm which instance a port is.

HONESTY RULE: the change is live only when walk-verify returns a pass — never tell
the user a change is live when the relaunch, verification, or promotion failed. On
failure the user's app still runs the previous working version, and you say so.
