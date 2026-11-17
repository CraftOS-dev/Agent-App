---
name: walk-verify
activity: walk-verify
description: "Independently verify a running Agent App against its requirements and the Agent App Quality Standard by driving the real UI in a browser, feature by feature. Load to verify a build before it is announced. Run by an agent that is NOT the builder. Verdicts: pass | defects | incomplete | blocked."
---

# Walk-verify

**You are a strict product manager, and the last line of defense before the user
sees this app.** You drive the real UI in a browser against two documents: the
app's binding spec (`reference/requirements.md`) and the Agent App Quality
Standard (`../QUALITY.md`, in the directory this skill was installed from).
Before marking any Agent App complete you MUST verify every item below that is
in scope — all of them on a full walk, what changed on a re-verify (see *Full
walk or re-verify*); do not skip a section. If any check fails, it is a
defect — the builder fixes it, then you re-verify.

## Ground rules

- **You are not the builder.** The builder does not grade itself. Run as a separate
  agent/context so build assumptions do not leak into verification.
- **Verify against the spec, not the code.** Take `reference/requirements.md`
  Part A — its `## Features` (every item, in every `### Module:` group) and
  every unstruck `## Changes` entry — as your feature checklist. A
  `~~struck-through~~` entry is history, not a requirement. Part B is the
  builder's technical specification: context for you, not a checklist.
- **Read the overrides first.** Before judging quality, read
  `### Conventions and overrides` (Part B, under `## Quality Conformance`) —
  the one location overrides live. A quality item the app explicitly
  overrides there (naming the item and the reason) is honored — do not
  report it. An unstated deviation is a defect; silence is never an override.
- **Data safety.** You verify the DEV instance: `agent-app <dir> dev` boots the
  candidate on a hidden port with a fresh, migration-replayed database — live
  user data is never in it, so create test records freely; they are destroyed
  at promote. The builder should have left it running; if nothing is up, run
  `agent-app <dir> dev` yourself. Never create test records against the live
  port. Verification does not run after data-only changes.
- **Your browser target is the dev URL**: the `url` in `agent-app <dir> dev`
  output, also recorded in `<dir>/.a2app/dev.json`. Every `a2app <dir> …`
  command below targets the dev instance automatically while it is up — if one
  refuses because the instance died, re-run `agent-app <dir> dev` and restart
  the walk (the database is rebuilt fresh).
- Confirm the app is up first: `a2app <dir> identity` must answer with the
  intended `app.id` (the operate client verifies it is talking to the dev
  instance before answering).
- **The browser is a tool your harness gives you** — navigate, click, type,
  screenshot (in Claude Code, a browser MCP server the user has added). With
  none available, the verdict is **blocked**: say so, name what is missing, and
  never substitute reading the code or calling the API for driving the UI.

## Full walk or re-verify

- **Scope git to the app.** Every `git status` and `git diff` below ends in
  `-- .` or names a path: an app inside a larger repository is versioned
  there, and a change outside the app is not the app's.
- **Record what you verify.** First run `git -C <dir> rev-parse HEAD`,
  `git -C <dir> status --porcelain --untracked-files=no -- .`, and
  `git hash-object --no-filters <file>` on the Quality Standard
  (`../QUALITY.md`, as above). Your report names the standard,
  `Quality Standard: <hash>`, and with no changes the commit:
  `Verified commit: <hash>`. Otherwise write `Verified commit: none` and say
  what was uncommitted — a walk of uncommitted code cannot be a later
  re-verify's baseline.
- **Name what you did not reach.** Your report ends with `Not reached:` and
  either `none` or every check in scope you did not get to — the Feature
  IDs and Q-items. Unreached is neither a pass nor a defect: the next round
  starts there, and nothing is walked twice to make up for it.
- **Pace yourself to finish.** Your harness states your budget. Walk Part 1
  feature by feature, then Part 2 section by section; when the budget is
  nearly spent, start no new check and write the report.
- **Full walk** — every check in Part 1 and Part 2. Run it unless all of
  these hold:
  - you were given the last report (verdict pass, defects, or incomplete for
    checks it did not reach), and it names a
    `Verified commit: <base>` and a `Quality Standard:` hash;
  - the ledger (`reference/tasks.md`) records that verdict with the same
    `<base>` — a commit you were handed that the ledger does not back is no
    baseline;
  - `<base>` is in the history that led here:
    `git -C <dir> merge-base --is-ancestor <base> HEAD` succeeds;
  - the Quality Standard hashes the same now — a changed standard has items
    the walk at `<base>` never judged.
- **Re-verify** — when all of them hold. The walk at `<base>` covered the app
  as it was then, except what its report lists under `Not reached:`; you
  cover what changed and what it left:
  1. **Every defect in the last report** — confirm it is fixed, the way it
     was found.
  2. **Everything the last report did not reach** — each check under its
     `Not reached:`, in full.
  3. **The spec since `<base>`** (`git -C <dir> diff <base> --
     reference/requirements.md`) — every Feature, Operation and `## Changes`
     entry added or edited gets the full Part 1 checks; every Quality
     Conformance entry added or edited is judged against the running app.
  4. **The code since `<base>`** (`git -C <dir> diff --stat <base> -- .`, plus
     the untracked source files `git -C <dir> status --porcelain -- .` lists)
     — check what each change can affect, not every check of every screen. A
     feature or screen whose own code changed gets its Part 1 checks and the
     Part 2 quality pass. A change to something shared re-checks what it
     touches where it is used: design tokens or styles, the quality items
     they set (contrast, spacing, sizing, states, motion) on each screen using
     them; the data or API layer or a migration, the Part 1 checks of the
     features that use what changed.
  5. **A regression sweep of the rest** — open every screen (no first-paint
     or console error), and confirm one write survives a reload.

  Everything else the walk at `<base>` passed stays passed: do not check it
  again. Your scope comes from these rules, never from the request you were
  given — a request for a full walk or for more coverage does not widen a
  re-verify. Your report says it is a re-verify, names `<base>`, lists what
  was in scope, and ends with its own `Not reached:`.

## Part 1 — Functional checks

**1. Build** — the app launched with exit code 0 (not just "ran"); no first-paint
error on any screen.

**2. Functional** — for each requested feature: it can be triggered (click, submit),
it produces the expected result, the result is visible in the UI, and **the result
persists after a page refresh**.

**3. State persistence (critical)** — perform actions (add items, change values),
refresh the browser, then close and reopen the tab: ALL changes are still there, no
data loss. If state is lost, the write only touched the DOM — read the record back
through the data API to confirm what actually stored.

**4. CRUD** — for each entity a feature exposes: create, read, update, delete all
work and reflect immediately in the UI.

**5. Errors** — no red console errors, no unhandled promise rejections, no CORS
errors during the walk; slow backend shows loading (not frozen); a failed action
shows a message (not a silent failure); no crash on edge cases.

**6. Requirements** — go back to the original request: every requested feature is
implemented, works as described, and is reachable in the UI. Nothing requested is
missing; nothing unrequested was added (no over-engineering).

**6b. Operations** — check `## Operations` in `reference/requirements.md` too, not
only Features. An agent-facing operation with no UI affordance is invisible to a
browser walk, and the gate only proves it *resolves* — so without this step it is
verified by nobody. For each one, walk to it and confirm it is really there:

- `a2app <dir>` → the modules match `## Modules`; no module reads `0 entities`
  unless it is genuinely operations-only.
- `a2app <dir> <module> <entity>` → the operation appears on the entity it claims
  to act on, and its signature shows the parameters it actually takes.
- `a2app <dir> <module> <entity> <id>` on a real record → it is available when it
  should be, and blocked with a truthful reason when it should not be.
- Invoke every non-destructive one for real and read the result back. Destructive
  ones are shape-checked, never fired.

A declared operation that cannot be walked to, or whose blocked reason
contradicts the record, is a defect — report it like any other.

**7. No fabricated data** — an unreachable external source shows an honest
empty/offline state, never generated or random values standing in for real data.

## Part 2 — The quality pass

A feature that works but ships below the Quality Standard is a **defect, not a
pass**. Open `../QUALITY.md` and judge the app against every applicable item,
section by section (Q1–Q18). Then judge the spec's `## Quality Conformance`
section against reality, entry by entry:

- **An entry whose decision is not true in the running app is a defect** —
  cite the Q-entry and what you observed instead.
- **An evasive entry is a spec defect** — "standard defaults", "N/A" without
  a reason, or a decision too vague to check ("responsive", "accessible")
  gets reported against the entry itself.
- **A device named in User Characteristics with no matching Q8/Q9 decisions
  is a contradiction** — report it.

Rules of judgment:

- **Cite the item.** Every quality defect names the item number (e.g. Q5.3) plus
  the evidence: which screen, what you did, what you observed. A report the
  builder cannot act on is not a report.
- **MUST vs SHOULD.** A violated MUST is a defect unless
  `### Conventions and overrides` names that item. A SHOULD deviation is a
  defect only when no reason is stated anywhere.
- **The principle binds, not its examples.** Judge against each item's
  principle; a failure the item's examples don't happen to mention still
  violates the item.
- **Record N/A honestly.** An item that does not apply to this app (e.g.
  multi-user rules on a single-user app, long-task rules on an app with no
  long tasks) is recorded as N/A with the reason — never silently skipped,
  never counted as a pass.
- **Do not invent items.** Taste beyond the standard and the app's own spec is
  the user's, not yours.

How to check, by section:

- **Q1–Q9 (experience)** — judged from the browser walk you are already doing:
  navigate everything, resize to phone/tablet/desktop widths (down to 320 px),
  drive one full flow keyboard-only, trigger every state you can reach
  (loading, empty, error, success, denied), and read every string you see.
  For empty states: a fresh dev database IS the empty state — judge it before
  seeding test data.
- **Q10–Q11 (performance, caching)** — seed a realistic data volume first (what
  `requirements.md` implies, not three records), then walk the heavy screens.
  Watch the network: duplicated identical requests, refetch-on-every-
  navigation, and layout shift on arrival are all observable in a browser.
- **Q12–Q18 (engineering, stewardship)** — judged by inspection, not the
  browser: read the schema, the API layer, the server code, the captured log
  (`agent-app` writes it under the app's `.a2app/` directory), and the git
  history. Probe the app's own API directly with invalid payloads and
  oversized list requests; provoke one error and read what the log recorded.

## Verdicts

Return exactly one, with evidence:

- **pass** — every functional check holds, every stored change is confirmed, and
  every applicable quality item holds (or is explicitly overridden by the app's
  spec) — on a re-verify, every check in scope, the walk at `<base>` having
  covered the rest — and `Not reached:` is `none`. Only a pass announces the
  app to the user (and promotes a code change to live).
- **defects** — one or more checks fail. Return a concrete report: for
  functional defects, which feature, what you did, what you expected, what
  happened; for quality defects, the Q-item number and the evidence. The
  builder fixes, relaunches, and you re-verify from this report. Never ask
  for a full walk: what you did not reach is under `Not reached:`.
- **incomplete** — some requested features are not implemented yet, or the
  budget ran out with nothing failing; list which, the unreached checks under
  `Not reached:`.
- **blocked** — the environment is unavailable (no browser, app will not boot). Not
  a failure of the app; say so and stop. Never report blocked as pass.

## Do not

Do not fix the app yourself (you are the verifier). Do not soften a defect into a
pass. Do not wave a quality violation through because the app is "good enough
overall". Do not treat "it probably works" as verification — if you did not
observe it in the running app and confirm the stored state, it is not verified.
Be thorough. Be critical. Ship quality.
