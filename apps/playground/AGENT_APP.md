# Playground Contacts

## Plan
A small contacts CRM used as a live example of the embedded-middleware adapter
form (`@a2app/adapter-core`). It boots for real and is meant to be walked: the
point of the example is that describe answers one level at a time, so the app is
shaped to give every level of the walk something to show.

## Modules
- **directory** — people and the companies they belong to.
- **outreach** — every logged contact with a person.

Two modules, not one. A single-module app collapses the root screen into the
module screen, and then the walk cannot be demonstrated at all.

## Entities
- **companies** (directory) — name (string, required), domain, created
  (datetime, read-only).
- **people** (directory) — name (string, required), email, company (ref →
  companies), tier (enum: lead/customer/vip), follow_up (day key), archived
  (boolean), touchpoints (list&lt;ref&gt; → touchpoints), created (datetime,
  read-only).
- **touchpoints** (outreach) — person (ref → people, required), channel (enum:
  email/call/meeting), note, replied (boolean), created (datetime, read-only).

`people.touchpoints` is a `list<ref>`, which is what gives a person record a
sub-resource to open — the relation level of the walk.

## Operations
- **count-by-tier** (directory) — count contacts in a tier. Module-level: it
  declares no `entity`, so it appears on the directory screen and on no record.
  `readOnly`, `idempotent`.
- **promote-to-customer** (directory → people) — move a contact to the customer
  tier. `appliesWhen tier != customer`, so the record screen reports it
  available on a lead and blocked on a customer.
- **archive-person** (directory → people) — archive a contact. `destructive`,
  `appliesWhen archived != true`.
- **mark-replied** (outreach → touchpoints) — record that a touchpoint got a
  reply. `appliesWhen replied != true`.

## Conventions
- The adapter is the only agent surface. The schema is defined in
  `src/server.ts` via a MemoryBinding; describe and schemaVersion derive from it,
  so neither can drift from what the app actually serves.
- A blocked operation is shown with its reason, never hidden. The reason is
  derived from the declared `appliesWhen` predicate and the record's stored
  values — a model never decides availability.

## Checklist
- [x] two modules, so the root screen is a real choice
- [x] three entities across them
- [x] a `list<ref>` relation, so the relation level is reachable
- [x] a module-level operation and three entity-level ones
- [x] state-gated operations, so a record screen shows both available and blocked
- [x] passes `agent-app apps/playground validate`
