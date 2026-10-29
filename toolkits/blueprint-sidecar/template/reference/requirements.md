# Requirements: Adopted App

PART A — REQUIREMENTS (SRS). User-approved before build; frozen after; changes via ## Changes.

An adopted app runs UNCHANGED. This spec covers what adoption adds — the app
launching behind the sidecar, and the operations agents may run — never the
adopted app's own features, which ship as they are, quirks included.

## Introduction

### Purpose
<REPLACE: one paragraph — what the adopted app is, its one job, who uses it, and that agents operate it over A2App through the sidecar>

### Scope
**Goals**
1. <REPLACE: 2–5 numbered falsifiable outcomes — e.g. "the app runs unchanged from upstream/ behind the sidecar"; "an agent can <do X> with operation <name>">

**Core functionalities:** <REPLACE: the operations agents get, as capability nouns separated by ·>

### Approval
Approved by the user: <REPLACE: date — written only when the user actually approved Part A>

## Product Description

### Product Perspective
<REPLACE: where the app came from and its stack; that it runs unchanged behind the sidecar; authMode and why>

### User Characteristics
<REPLACE: who uses the app's own UI and who sends agents to it>

### Constraints
- C-1: `upstream/` is never edited: the app runs as adopted, and what it needs to run here is declared in `sidecar.json`.
- C-2: <REPLACE: anything the app requires to run here — a runtime version, an environment variable, a port it cannot change>

### Assumptions
- A-1: Volume ceiling: <REPLACE: a number — the calls per minute agents will make>

## Features

### Launch
- F-APP-1: <REPLACE: "The app starts from upstream/ behind the sidecar, and `agent-app serve` reports it up only once it answers <health path>">

### Module: <REPLACE: module name from manifest.json>
- F-<REPLACE: MOD>-1: <REPLACE: one per operation — "The agent can <verb> with <operation>, which reaches <METHOD /route>"; destructive ones ask a person to approve>

## Non-Functional Requirements
- N-1: <REPLACE: app-specific measurable bars only — e.g. a slow operation's own timeout>

## Data Requirements
- The adopted app keeps its own data model; it is not mapped, and agents reach it only through the declared operations.
- <REPLACE: where the app keeps its data — inside {dataDir} (inside the framework's data directory, so backups and a dev instance cover it) or elsewhere, and what that means>

## External Interfaces
- **Human (browser):** <REPLACE: the app's own UI, unchanged, at its own address; the framework's account page at /_a2app/account for sign-in and connected agents>
- **Agent (A2App):** <REPLACE: modules, and "operations exactly as declared in ## Operations Design"; no entities>

## Out of Scope
- Changing the adopted app's code or features.
- Mapping its data model as A2App entities (the `data` verbs do not apply).
- <REPLACE: anything else a reasonable adopter would otherwise add, or nothing more>

## Quality of Life
- <REPLACE: non-binding niceties, or "None.">

PART B — TECHNICAL SPECIFICATION. QUALITY.md read is mandatory before writing it. Evolves during build; never silently contradicts Part A.

## System Overview
<REPLACE: the app's stack in one line; how it starts (sidecar.json upstream.command); modules → operations>

## UI Design
- N/A — the adopted app's own UI runs unchanged at its own address, and adoption adds no screen; the only page the sidecar serves is the framework's account page.

## Quality Conformance

This app's decisions per Quality Standard section — never the rules restated. "Standard defaults" is not an answer for Q1–Q11. N/A only with reason. Breaking an item → ### Conventions and overrides.

- **Q1 Completeness & IA:** <REPLACE: how the app's routes are grouped into modules (its tags or route prefixes), and that every module fits its describe screen>
- **Q2 Design system:** N/A — the adopted UI runs unchanged; adoption adds no screen.
- **Q3 Layout & composition:** N/A — the adopted UI runs unchanged; adoption adds no screen.
- **Q4 Interaction:** <REPLACE: each destructive operation, and that the adapter asks a person to approve each call>
- **Q5 State & feedback:** N/A for screens (none added); an agent gets each operation's result, or an error envelope naming what failed.
- **Q6 Motion:** N/A — adoption adds no screen.
- **Q7 Content:** <REPLACE: how operation descriptions are worded; the app's own refusals are relayed as upstream_error with what it answered>
- **Q8 Accessibility:** N/A — the adopted UI runs unchanged; the account page is the framework's.
- **Q9 Responsiveness:** N/A — the adopted UI runs unchanged; adoption adds no screen.
- **Q10 Performance:** <REPLACE: the app's own speed is as adopted; any operation slower than the sidecar's 30 s default and the timeoutMs set for it>
- **Q11 Caching & freshness:** No caching: every operation is forwarded to the app when it is called, so an answer is always the app's current one.
- **Q12 Data integrity:** <REPLACE: what the app itself enforces; what the operations add — typed params checked before forwarding, path segments required>
- **Q13 API:** <REPLACE: "adapter surface only: the declared operations, forwarded per sidecar.json" — and whether anyone uses the app's own API directly>
- **Q14 Architecture:** `upstream/` is the adopted app, unchanged; `sidecar.json` says how it starts and which route each operation reaches; the sidecar adapter (`@a2app/reverse-proxy`) is installed by the pipeline and started by `pipeline.start`.
- **Q15 Resilience:** <REPLACE: the health path and start deadline; per-call timeout; an app that is down answers 503 upstream_unavailable, and one that exits takes the sidecar down with it>
- **Q16 Security & privacy:** <REPLACE: authMode posture; the app's own auth, if any; the app binds loopback; no secret is written into sidecar.json>
- **Q17 Observability:** The sidecar logs one JSON line per event (boot, upstream, http, upstream-exit, crash) to `.a2app/serve.log`, and the adopted app's own output lands in the same log unchanged. Health: `/api/_a2app` answers once the app answers its own health path.
- **Q18 Version control:** <REPLACE: commit-unit convention, and how upstream/ is updated (replaced from its origin, never edited)>

### Conventions and overrides
<REPLACE: overrides — item number + factual reason + revisit condition — and mirrored global rules, or "None.">

## Process Flows
None — the adopted app's flows are its own, and adoption adds none.

## Operations Design
| Operation | Module | Route | Params | Flags |
| --- | --- | --- | --- | --- |
| <REPLACE: one row per operation, matching operations.json and sidecar.json exactly> | | | | |
