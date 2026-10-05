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
Before marking any Agent App complete you MUST verify every item below; do not
skip a section. If any check fails, it is a defect — the builder fixes it, then
you re-verify.

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

**6c. Agent work (app→agent features)** — any control that queues work for an
agent (an operation whose runner calls `trigger(…, capability)`; `validate`
names each one) gets this walk, in the browser, without reloading the page
between steps. You play the agent from a terminal, so nothing depends on a
harness being installed:

1. **Nobody listening.** With no bridge running, use the control. Within ~1 s
   the screen shows the work as waiting, with an elapsed time that ticks.
   Wait ~25 s: it now says that no agent is listening and how to start one
   (`agent-app <dir> bridge start`). "Waiting…" with no end is a defect.
2. **In progress.** `a2app <dir> tasks claim <id>`, then
   `a2app <dir> tasks progress <id> --step "Reading the record"`. The screen
   shows the agent working, the step text, and how long it has been running,
   with no reload.
3. **Done, with a readable result.** Complete it with a long, realistic
   summary: several sentences, a line break and a URL
   (`a2app <dir> tasks complete <id> --result '{"summary":"…"}'`). The result
   appears in its own full-width block that reads like prose. Line breaks are
   kept, the link is a link, and long text is clamped behind a "Show more"
   (or similar). A result squeezed into an existing narrow column or appended
   to a title cell, so it wraps a word or two per line or stretches the row, is
   a defect. Any data the agent wrote is shown without a reload.
4. **Failed.** Queue it again and fail it
   (`a2app <dir> tasks complete <id> --reason "…"`). The reason shows in
   words, and there is a way to ask again. Asking again must queue NEW work:
   if the screen jumps straight back to the old failure, the retry is a no-op
   (identical triggers dedupe to one task).
5. **Come back later.** Leave the screen (or reload) mid-run. Wherever the
   record appears in a list, a badge still says an agent is on it.

Every state must be visible as it happens. One that is missing, frozen, or
only appears after a refresh is a defect against Q5.7. Cite the step above
and what the screen showed instead.

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
  spec). Only a pass announces the app to the user (and promotes a code change
  to live).
- **defects** — one or more checks fail. Return a concrete report: for
  functional defects, which feature, what you did, what you expected, what
  happened; for quality defects, the Q-item number and the evidence. The
  builder fixes, relaunches, and you re-verify.
- **incomplete** — some requested features are not implemented yet; list which.
- **blocked** — the environment is unavailable (no browser, app will not boot). Not
  a failure of the app; say so and stop. Never report blocked as pass.

## Do not

Do not fix the app yourself (you are the verifier). Do not soften a defect into a
pass. Do not wave a quality violation through because the app is "good enough
overall". Do not treat "it probably works" as verification — if you did not
observe it in the running app and confirm the stored state, it is not verified.
Be thorough. Be critical. Ship quality.
