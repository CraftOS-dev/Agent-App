# Requirements: FastAPI Agent App

PART A — REQUIREMENTS (SRS). User-approved before build; frozen after; changes via ## Changes.

## Introduction

### Purpose
A task list an agent operates. The app serves the A2App surface over FastAPI and
ships no browser View: the agent is the interface, and a human reaches the list
through the agent or through the records API directly. It is the starting point
for a Python app whose first consumer is an agent rather than a screen.

### Scope
**Goals**
1. Serve a conforming A2App surface — identity, describe, guarded records,
   declared operations — from a Python process.
2. Track tasks through a status lifecycle (todo → doing → done).
3. Reject a malformed write identically to every other A2App backend, because
   the guard rules are shared verbatim rather than reimplemented.

**Core functionalities:** task records · status lifecycle · agent operations ·
shared-rules guard.

### Approval
Approved: 2026-09-15 — the starter ships as specified; re-approve Part A when
this app's requirements are replaced with the user's own.

## Product Description

### Product Perspective
Self-contained Agent App (`authMode: none`). FastAPI serves one catch-all `/api`
route plus the well-known identity document, both delegated to the adapter; no
View, no integrations, no external services. A human interface is the author's
to add, and adding one does not change this surface.

### User Characteristics
One person, working through an agent rather than a screen: a developer or an
operator who asks for the list rather than opening it.

### Constraints
- C-1: A task's title is required and at most 200 characters.
- C-2: The server assigns `created`; the client never supplies it.
- C-3: `status` is exactly one of todo · doing · done — a closed vocabulary, not
  free text.

### Assumptions
- A-1: Volume ceiling: 1,000 tasks. Performance is judged at this volume.
- A-2: One process, one store file. Concurrency beyond a single writer is out of
  scope for the starter.

## Features

### Module: planning
- F-PLA-1: A task carries a title, a status, an optional due day, and optional
  notes, and is readable through describe as a typed model rather than prose.
- F-PLA-2: WHEN a write omits a required title or carries a status outside the
  declared vocabulary THE SYSTEM SHALL reject it with the field named and the
  expectation stated.
- F-PLA-3: WHEN a write is accepted THE SYSTEM SHALL read the record back and
  report a field the store did not keep, rather than reporting success.

### Agent (via A2App)
- F-AGT-1: The agent can list, create, update, and delete tasks through A2App.
- F-AGT-2: The agent can count the tasks without changing anything, and may
  repeat the call safely.
- F-AGT-3: The agent can mark one task done, and the operation is offered only
  on a task that is not already done.
- F-AGT-4: The agent can walk from the root screen to the module, the entity and
  one record without being told the shape in advance.

## Non-Functional Requirements
- N-1: A describe level stays within the protocol's per-response budget at A-1
  volume, so an agent never pays for the whole model to read part of it.
- N-2: The guard runs on the raw request body, before any coercion, so what is
  rejected is what was sent.

## Data Requirements
- **tasks** (module: planning): title (string, required, ≤200), status
  (enum: todo/doing/done), due (day key YYYY-MM-DD, optional), notes (string,
  ≤2000, optional), created (datetime, server-set). Deleting a task is
  permanent; the store keeps no tombstones.

## External Interfaces
- **Agent (A2App):** module `planning`, entity `tasks`, operations exactly as
  declared in `## Operations Design`. This is the only interface the starter
  ships.
- **Human:** none. The author adds a View if the app needs one; it talks to the
  same records API the agent uses, and adds no endpoints of its own.

## Out of Scope
- A browser View, templates, or static assets
- Multi-user, accounts, sharing
- Reminders, recurrence, notifications
- Any second machine interface beside the adapter

## Quality of Life
- The adapter answers as itself or not at all: health is the identity document,
  so "up" and "is this the app I meant" are one question.
- The agent credential lives in a runtime file, never in the source tree.

PART B — TECHNICAL SPECIFICATION. QUALITY.md read is mandatory before writing it. Evolves during build; never silently contradicts Part A.

## System Overview
Blueprint: python-fastapi — FastAPI over a JSON-file store, with the A2App
adapter mounted as a catch-all `/api/{path}` route plus `/.well-known/a2app.json`.
One module — `planning` — so the agent's walk has a single root row. The model
lives in `schema.py`; `a2app_adapter.py` is system-owned and carries the shared
rules verbatim.

## UI Design
None shipped — this starter has no View, and a spec that described one would be
describing something that does not exist. An author adding a View owns this
section then, and the Quality Standard's Q1–Q9 apply to it at that point rather
than now.

## Quality Conformance

This app's decisions per Quality Standard section — never the rules restated.
Q1–Q9 concern a View this starter does not ship and are recorded as not
applicable rather than silently skipped.

- **Q1 Completeness & IA:** n/a — no View. The agent's orientation is describe's
  root screen: one module, its entity counts, and the caller's access.
- **Q2 Design system:** n/a — no View.
- **Q3 Layout & composition:** n/a — no View.
- **Q4 Interaction:** n/a for a screen; for the agent, the one destructive
  action is a record delete, and the adapter demands approval for any operation
  declared destructive.
- **Q5 State & feedback:** n/a for a screen; every write answers with the stored
  record, so the agent's confirmation is the data rather than an acknowledgement.
- **Q6 Motion:** n/a — no View.
- **Q7 Content:** error envelopes carry a machine `code` and a sentence naming
  the field and the expectation; terminology fixed to task/status/due.
- **Q8 Accessibility:** n/a — no View.
- **Q9 Responsiveness:** n/a — no View.
- **Q10 Performance:** describe levels are bounded by the protocol budget;
  records paginate; the store is read once per process and held in memory at
  A-1 volume.
- **Q11 Caching & freshness:** `schemaVersion` moves with the model and
  `dataVersion` with record writes, so a client caching describe re-fetches on
  exactly the change that invalidates it.
- **Q12 Data integrity:** C-1 and C-3 enforced by the shared guard at the API
  boundary; C-2 assigned in the store layer; a write is read back and a lost
  field is reported rather than swallowed (F-PLA-3).
- **Q13 API:** adapter surface only — the catch-all route delegates every `/api`
  path to the adapter, and the app declares no endpoints of its own.
- **Q14 Architecture:** model in `schema.py`, serving and persistence in the
  system-owned `a2app_adapter.py`, process wiring in `main.py`. The pure rules
  are shared verbatim, never reimplemented per stack.
- **Q15 Resilience:** a rejection is a normal outcome and is returned, never
  raised as a transport error; an unreachable store fails the health check
  rather than answering with a partial model.
- **Q16 Security & privacy:** `authMode: none` — single local user; the agent
  credential is runtime-only and never committed; the adapter binds loopback and
  answers only on hosts it is configured for.
- **Q17 Observability:** health is the identity endpoint; a failed write is
  visible as a coded rejection rather than a stack trace.
- **Q18 Version control:** one commit per feature or fix; the store file and the
  credential are gitignored by the scaffold.

### Conventions and overrides
Q1–Q9 are recorded n/a because the starter ships no View. An author who adds one
replaces those entries with real decisions before claiming conformance.

## Process Flows
None — the status change (F-AGT-3) is a single-step transition, not a lifecycle
needing a diagram.

## Operations Design
| Operation | Module | Entity | appliesWhen | Params | Flags |
| --- | --- | --- | --- | --- | --- |
| count-tasks | planning | — | — | {} | readOnly, idempotent |
| complete-task | planning | tasks | status ≠ done | task (ref, required) | — |
