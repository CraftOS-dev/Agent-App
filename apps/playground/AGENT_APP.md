# Playground Contacts

## Plan
A tiny contacts app used as a live example of the embedded-middleware adapter form
(`@a2app/adapter-core`). It boots for real and is exercised by an end-to-end test
that drives the A2App protocol over HTTP.

## Entities
- **contacts** — name (string, required), email, company, tier (enum:
  lead/customer/vip), follow_up (day key), created (datetime, read-only).

## Operations
- **count-by-tier** — count contacts in a tier. `readOnly`, `idempotent`.

## Conventions
- The adapter is the only agent surface. The schema is defined in `src/server.ts`
  via a MemoryBinding; describe and schemaVersion derive from it.

## Checklist
- [x] contacts entity + CRUD
- [x] count-by-tier operation
- [x] boot test over real HTTP
