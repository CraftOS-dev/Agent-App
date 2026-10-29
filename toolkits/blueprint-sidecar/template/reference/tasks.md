# Tasks: Adopted App

Created only after ### Approval carries a real date. Every task cites what it
implements; tick on completion; never delete or batch-tick; ## Changes work
appends here citing the entry date.

## Build
- [ ] T-1 (F-APP-1): The adopted source is in `upstream/`, unchanged from its origin.
- [ ] T-2 (F-APP-1): `sidecar.json` declares how it starts — argv, port, environment, health path — and `agent-app serve` brings it up.
- [ ] T-3 (Q1): Modules declared in `manifest.json` from the app's own grouping, resealed with `toolkit-sync`.
- [ ] T-4 (<REPLACE: F-ID>): <REPLACE: one task per operation — declared in operations.json with typed params, mapped in sidecar.json>

## Verification
- [ ] All build tasks ticked.
- [ ] Every non-destructive operation invoked through the adapter and confirmed against the app; every destructive one shape-checked (it asks for approval), never fired.
- [ ] Quality Conformance sweep: every Q-entry true in the running app (Q10–Q15 at A-1 volume; Q16–Q18 by inspection).
- [ ] walk-verify pass — <REPLACE: verdict, defects found, fixes — written when verification ran>
