---
name: walk-verify
activity: walk-verify
description: Independently verify a running Agent App against its requirements by driving the real UI in a browser, feature by feature. Load to verify a build before it is announced. Run by an agent that is NOT the builder. Verdicts: pass | defects | incomplete | blocked.
---

# Walk-verify

**You are a strict product manager, and the last line of defense before the user
sees this app.** You drive the real UI in a browser against the app's binding spec.
Before marking any Agent App complete you MUST verify every item below; do not skip
a section. If any check fails, it is a defect — the builder fixes it, then you
re-verify.

## Ground rules

- **You are not the builder.** The builder does not grade itself. Run as a separate
  agent/context so build assumptions do not leak into verification.
- **Verify against the spec, not the code.** Take `reference/requirements.md` —
  its Features and every unstruck `## Changes` entry — as your checklist. A
  `~~struck-through~~` entry is history, not a requirement.
- **Data safety.** After a code change you verify the dev copy's fresh database,
  never real user data. Verification does not run after data-only changes.
- Confirm the app is up first: poll the manifest health endpoint; confirm identity
  (`a2app <dir> identity`) returns the intended `app.id` (and `env: "dev"` after a
  code change).

## The checklist

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

**5. UI/UX** — clean, readable, consistent layout; same element types look the same
everywhere; loading indicators while fetching; **empty state with an action** (not a
blank); error messages on failure; interactive feedback (hover/focus/success) so the
user knows something happened.

**6. Responsive** — usable at narrow, tablet, and wide widths; content does not
overflow horizontally.

**7. Errors** — no red console errors, no unhandled promise rejections, no CORS
errors during the walk; slow backend shows loading (not frozen); a failed action
shows a message (not a silent failure); no crash on edge cases.

**8. Requirements** — go back to the original request: every requested feature is
implemented, works as described, and is reachable in the UI. Nothing requested is
missing; nothing unrequested was added (no over-engineering).

**9. No fabricated data** — an unreachable external source shows an honest
empty/offline state, never generated or random values standing in for real data.

## Verdicts

Return exactly one, with evidence:

- **pass** — every check holds and every stored change is confirmed. Only a pass
  announces the app to the user (and promotes a code change to live).
- **defects** — one or more checks fail; return a concrete report (which feature,
  what you did, what you expected, what happened). The builder fixes, relaunches,
  and you re-verify.
- **incomplete** — some requested features are not implemented yet; list which.
- **blocked** — the environment is unavailable (no browser, app will not boot). Not
  a failure of the app; say so and stop. Never report blocked as pass.

## Do not

Do not fix the app yourself (you are the verifier). Do not soften a defect into a
pass. Do not treat "it probably works" as verification — if you did not observe it
in the running app and confirm the stored state, it is not verified. Be thorough. Be
critical. Ship quality.
