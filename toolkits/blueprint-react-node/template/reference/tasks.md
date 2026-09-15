# Tasks: React-Node Agent App

Created only after ### Approval carries a real date. Every task cites what it
implements; tick on completion; never delete or batch-tick; ## Changes work
appends here citing the entry date.

## Build
- [x] T-1 (F-PLA-1, F-PLA-7): tasks entity, add form with inline validation preserving input
- [x] T-2 (F-PLA-2, F-PLA-3): list newest-first with status filter toolbar and bounded pages
- [x] T-3 (F-PLA-4): status pill cycling with in-flight row state
- [x] T-4 (F-PLA-5, Q4): delete behind the app's confirm dialog, naming the task
- [x] T-5 (F-PLA-6, Q5): loading skeletons, per-filter empty states, error banner with retry
- [x] T-6 (F-AGT-1..3): operations clear-done / count-tasks / complete-task declared and implemented
- [x] T-7 (Q2, Q6, Q8): token system, ui.css/ui.js widgets, motion presets, dialog focus flow, live-region toasts
- [x] T-8 (Q9): 480 px breakpoint — form wrap, due-badge hide, 44 px touch targets
- [x] T-9 (Q11, Q15): stored-response updates, stale-response guard, fetch timeouts + GET retry, ETag revalidation
- [x] T-10 (Q17): JSON-line logging (boot/http/crash) with request ids

## Verification
- [x] All build tasks ticked.
- [x] Quality Conformance sweep: every Q-entry true in the running app (Q1–Q9
      walked incl. narrow width + keyboard-only; Q10–Q15 at A-1 volume;
      Q16–Q18 by inspection).
- [x] Self-review against QUALITY.md.
- [x] walk-verify pass — the starter as shipped; verify again after replacing
      this spec with the user's own.
