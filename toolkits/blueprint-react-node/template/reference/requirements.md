# Requirements: React-Node Agent App

PART A — REQUIREMENTS (SRS). User-approved before build; frozen after; changes via ## Changes.

## Introduction

### Purpose
A personal to-do app: one user manages a list of tasks in the browser, and an
agent operates the same list on the user's behalf through A2App.

### Scope
**Goals**
1. Capture and track tasks with a status lifecycle (todo → doing → done).
2. Give the agent full operational control of the same data.
3. Stay instantly responsive on a personal machine.

**Core functionalities:** add/edit/delete tasks · status cycling · status
filtering · agent operations over the list.

### Approval
Approved: 2026-09-11 — the starter ships as specified; re-approve Part A when
this app's requirements are replaced with the user's own.

## Product Description

### Product Perspective
Self-contained Agent App (`authMode: none`); browser View for the human, the
A2App adapter as the only agent surface; no integrations; no external services.

### User Characteristics
One person, desktop-first, phone for glancing at the list and quick additions.

### Constraints
- C-1: A task's title is required and at most 200 characters.
- C-2: The server assigns `created`; the client never supplies it.

### Assumptions
- A-1: Volume ceiling: 1,000 tasks. Performance is judged at this volume.

## Features

### Module: planning
- F-PLA-1: The user can add a task with a title and an initial status.
- F-PLA-2: The user can see all tasks, most recent first.
- F-PLA-3: The user can filter the list by status (all / to do / doing / done).
- F-PLA-4: The user can advance a task's status by clicking its status pill
  (todo → doing → done → todo).
- F-PLA-5: The user can delete a task, after an in-app confirmation that names it.
- F-PLA-6: The user sees a designed empty state with an add action when no
  tasks exist, loading skeletons while the list loads, and an error state with
  a retry action when the app cannot be reached.
- F-PLA-7: WHEN a submitted title is empty THE SYSTEM SHALL show an inline
  error next to the field and preserve the user's input.

### Agent (via A2App)
- F-AGT-1: The agent can list, create, update, and delete tasks through A2App.
- F-AGT-2: The agent can clear all done tasks in one operation, with approval,
  since it is destructive.
- F-AGT-3: The agent can mark one task done while it is not already done.

## Non-Functional Requirements
- N-1: The list stays interactive at A-1 volume (bounded pages, no unbounded render).

## Data Requirements
- **tasks** (module: planning): title (string, required, ≤200), status
  (enum: todo/doing/done), due (day key YYYY-MM-DD, optional), notes (string,
  ≤2000, optional), created (datetime, server-set). Deleting a task is
  permanent (F-PLA-5).

## External Interfaces
- **Human (browser):** a single planning screen — add form, filter toolbar,
  task list, count footer.
- **Agent (A2App):** module `planning`, entity `tasks`, operations exactly as
  declared in `## Operations Design`. No other machine interface exists.

## Out of Scope
- Multiple lists, projects, or tags
- Reminders, notifications, recurring tasks
- Multi-user, sharing, accounts
- Calendar or email integrations

## Quality of Life
- Keyboard submit on the add form; `/` focuses the add box.
- SPA fallback so deep links still load.
- The list keeps stale data visible with an error toast when a refresh fails,
  instead of blanking.

PART B — TECHNICAL SPECIFICATION. QUALITY.md read is mandatory before writing it. Evolves during build; never silently contradicts Part A.

## System Overview
Blueprint: react-node — Node built-in `http` + vanilla SPA + JSON store, the
adapter mounted as embedded middleware. One module — `planning` — mirrored by
the single screen; the human's navigation and the agent's walk share one map.

## UI Design
- **Design system:** the blueprint token set (`public/tokens.css`, two-tier:
  primitives → semantic) used as shipped, no extensions. Components in
  `public/ui.css` + `public/ui.js`: buttons, fields, status pills, toasts,
  confirm dialog, inline SVG icon set.
- **Layout:** single centered column, max 640 px: header, add form in a card,
  filter toolbar, task list in a card, count footer. Calm density — one list,
  no data tables.
- **Screen — planning:** primary object: the task list · primary action: add
  a task · states: loading skeletons sized to real rows, designed empty state
  per filter, error banner with retry, in-flight disabled controls, success
  read back from the stored record · narrow width: the add form wraps to
  full-width fields, the due badge hides, controls grow to 44 px targets.
- **Formatting:** dates as "12 Sep" (year added when it differs); status
  always a labelled pill; empty optional fields render nothing, never "null".

## Quality Conformance

This app's decisions per Quality Standard section — never the rules restated.

- **Q1 Completeness & IA:** one screen, so orientation is the header + count
  footer; one name per concept — "task" and the three status labels (To do /
  Doing / Done) everywhere, UI and adapter alike; past a screenful the status
  filter plus "Show more" paging is the scaling path.
- **Q2 Design system:** blueprint tokens as shipped; semantic roles used:
  accent (primary action), danger (delete), neutral/info/success (the three
  statuses); icons from the ui.js inline SVG set only; light and dark both
  fully resolved, following the system scheme.
- **Q3 Layout & composition:** 4 px spacing grid via tokens; single calm
  column; list rows one-line with title truncated by ellipsis (full title in
  the row's tooltip), due badge right-aligned; pagination at 100 rows.
- **Q4 Interaction:** affordance states from ui.css (cursor, hover, focus
  ring, active, disabled with reduced opacity); one destructive action —
  delete — whose dialog names the task title; confirm (no undo: the store
  keeps no tombstones, C-2 record is gone); keyboard map: Enter submits,
  Escape closes the dialog, `/` focuses the add box; status is constrained to
  the enum by the pill control, title validated inline.
- **Q5 State & feedback:** all five states designed for the one screen (see
  UI Design); double submit blocked by the pending button state; every action
  acknowledges instantly via disabled/pending controls; success reads back
  from the stored record and surfaces as a toast plus the updated row.
- **Q6 Motion:** blueprint motion tokens only — 120/200/300 ms, eased;
  transitions: toast enter/leave, dialog enter, row hover; reduced-motion
  collapses all of it via the tokens.css kill switch.
- **Q7 Content:** plain, second-person-free microcopy; error pattern: what
  happened + what to do ("Could not add the task. The app took too long to
  answer."); terminology fixed to task/status/due.
- **Q8 Accessibility:** contrast from the token pairs (AA in both schemes,
  no app-added colours); focus flow: dialog traps between its two actions and
  returns focus to the opener, toasts announce via a polite live region;
  targets ≥24 px everywhere, 40–44 px at touch widths; status buttons carry
  aria-labels naming current and next state.
- **Q9 Responsiveness:** usable 320 px–desktop; one breakpoint at 480 px —
  form fields go full-width, due badge hides, touch targets grow; no
  horizontal page scroll at any width.
- **Q10 Performance:** list renders bounded pages (100 rows + "Show more")
  against the A-1 ceiling; skeletons reserve layout so content arrival shifts
  nothing; no images or fonts to budget — system font stack, inline SVG.
- **Q11 Caching & freshness:** static assets ETag-revalidated (`no-cache` +
  304s); data responses adapter-governed; one in-flight load at a time with a
  stale-response guard; writes update the view from the stored response — no
  refetch of what the app just had.
- **Q12 Data integrity:** title required/≤200 and status enum enforced by the
  adapter's guard at the API boundary (C-1); `created` server-assigned in the
  store layer (C-2); the UI's inline validation (F-PLA-7) is UX, never the
  defense.
- **Q13 API:** adapter surface only — the View talks to the same records API
  the agent uses; no app-specific endpoints exist.
- **Q14 Architecture:** View in `public/` (app.js composes ui.js widgets on
  tokens.css), Model in `a2app.schema.mjs`, serving/persistence in the
  system-owned `server.mjs`; every widget and formatting helper exists once
  in ui.js.
- **Q15 Resilience:** every fetch has a 10 s timeout; idempotent GETs retry
  once with jitter, writes never auto-retry (the pending control makes retry
  the user's call); mid-session failure keeps stale data visible with an
  error toast, initial failure shows the banner with retry.
- **Q16 Security & privacy:** `authMode: none` — single local user; the
  agent credential is runtime-only (`.agent-token`, never committed); logs
  carry paths and status codes, never record contents; same-origin writes
  only, per the adapter's origin rule.
- **Q17 Observability:** one JSON line per event (`evt: boot | http | crash`)
  with ts/level and, for http, id/method/path/status/ms — to the log
  `agent-app serve` captures; error lines carry message + stack; health is
  the adapter identity endpoint: the app answers as itself or not at all.
- **Q18 Version control:** one commit per feature or fix; `data/`,
  credentials, and runtime state are gitignored by the scaffold.

### Conventions and overrides
None.

## Process Flows
None — the status cycle (F-PLA-4) is a single-step transition, not a lifecycle
needing a diagram.

## Operations Design
| Operation | Module | Entity | appliesWhen | Params | Flags |
| --- | --- | --- | --- | --- | --- |
| clear-done | planning | — | — | {} | destructive |
| count-tasks | planning | — | — | {} | readOnly, idempotent |
| complete-task | planning | tasks | status ≠ done | task (ref, required) | — |
