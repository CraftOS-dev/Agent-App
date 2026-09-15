# Tasks: FastAPI Agent App

Created only after ### Approval carries a real date. Every task cites what it
implements; tick on completion; never delete or batch-tick; ## Changes work
appends here citing the entry date.

## Build
- [x] T-1 (F-PLA-1): tasks entity declared in `schema.py` with protocol types, so describe derives the model rather than restating it
- [x] T-2 (F-PLA-2, C-1, C-3): shared guard wired on the raw body — required title, ≤200, closed status vocabulary
- [x] T-3 (F-PLA-3): read-back after write, reporting any field the store did not keep
- [x] T-4 (C-2): `created` assigned server-side in the store layer, refused as a client-supplied field
- [x] T-5 (F-AGT-1): records CRUD served through the adapter's catch-all `/api` route
- [x] T-6 (F-AGT-2): count-tasks declared readOnly + idempotent, with a runner
- [x] T-7 (F-AGT-3): complete-task attached to tasks with `appliesWhen: status ≠ done`, so a done task does not offer it
- [x] T-8 (F-AGT-4, N-1): describe walks root → module → entity → record within the per-response budget
- [x] T-9 (Q16): loopback binding, host allowlist, runtime-only agent credential
- [x] T-10 (Q11): schemaVersion derived from the model; dataVersion moves on record writes

## Verification
- [x] All build tasks ticked.
- [x] Adapter self-test passes (`python a2app_adapter.py --selftest`) — guard,
      predicates, fingerprint, referential deletes.
- [x] Every declared operation resolves to a runner (toolkit gate).
- [x] Quality Conformance sweep: Q10–Q18 true in the running app; Q1–Q9 recorded
      n/a, since this starter ships no View.
- [ ] walk-verify pass — run it after replacing this spec with the user's own,
      and again after adding a View.
