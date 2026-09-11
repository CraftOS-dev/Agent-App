# The Agent App Quality Standard

Every Agent App is built and judged against this standard before it is announced to its
user. An Agent App is built by an agent with no human reviewer in the loop, so
this document is the substitute for the judgment a design-led product team
supplies. The bar, in one sentence: **an Agent App must be indistinguishable in
craft from a commercial product a design-led team would ship**.

Builders read this before the first screen (the creator and modify skills say
when). Verifiers judge against it item by item (the walk-verify skill says how).

## How this standard binds

1. **Judged, not linted.** The verifier (walk-verify skill) grades the running
   app against every applicable item here, in addition to the app's own
   `reference/requirements.md`. A feature that works but ships below this
   standard is a **defect**. A defect report names the item violated by number
   (e.g. Q5.4) and the observed evidence, so the builder fixes a stated
   failure, not an impression.
2. **Keywords.** MUST items are requirements: violating one is a defect unless
   the app has overridden it (rule 4). SHOULD items are strong defaults:
   deviation is permitted, but a deviation with no stated reason is a defect.
3. **The principle binds, not its examples.** Every item states a verifiable
   principle. Illustrations ("e.g., …", "illustrative: …") are informative,
   never exhaustive, and carry no force of their own. A defect no example
   names is still a defect if it violates the item; matching an example's
   surface while violating its principle is not compliance.
4. **Every item is overridable per app — explicitly, never silently.** Real
   apps have legitimate reasons to break individual rules. An app overrides an
   item by naming it and the reason in its own `reference/requirements.md`,
   under `### Conventions and overrides` (Part B, `## Quality Conformance`) — the one
   location the verifier reads; it honors a stated override and ignores an
   unstated one. Silence is not an override.
5. **Precedence.** The app's own `requirements.md` overrides the user's
   cross-app conventions (`agent-app global`), which override this standard.
   What no layer overrides, this standard decides.
6. **Not applicable is recorded, never assumed.** An item that genuinely does
   not apply (illustrative: multi-user auth rules on a single-user app) is
   recorded as N/A with the reason — not silently passed.
7. Where an item names an external standard, the version pinned in the
   reference table at the end of this document is the one that applies.

---

## Part I — Experience

### Q1. Product completeness and information architecture

Principle: **the app fully serves its stated purpose, and its structure mirrors
how its users think about the domain.**

1. Every feature in `reference/requirements.md` MUST be reachable through the
   UI by a user who has never seen the code — discoverable by navigation, not
   by knowing a URL.
2. The app MUST be content-complete for its purpose: every screen carries the
   fields, columns, and actions its job implies. A screen technically present
   but too thin to do the job it names is a scope defect, not a style choice.
3. Navigation MUST be persistent and orienting: from any screen the user can
   tell where they are, reach any module, and return — without the browser's
   back button being the only way.
4. The visible structure SHOULD mirror the modules declared in
   `manifest.json`: the navigation a human sees and the walk an agent takes
   are the same map, so neither audience learns a second geography.
5. Naming MUST be consistent: one concept, one name, everywhere it appears —
   navigation, headings, buttons, messages, and the adapter's declarations.
6. Working sets MUST scale: any list a user works in offers search, filter, or
   sort once it exceeds a screenful; no feature depends on scanning an
   unbounded list by eye.

### Q2. Visual design system

Principle: **one deliberate design system, defined before the first screen and
applied by every screen.**

1. The app MUST define its visual decisions once, as tokens — palette, type
   scale, spacing scale, radii, elevation, borders — and draw every screen
   from them. Hardcoded one-off values where a token exists are defects.
2. Typography MUST be chosen and hierarchical: a deliberate font stack; a type
   scale in which size, weight, and colour distinguish display, heading, body,
   and caption; readable line-height and line length. Browser defaults are not
   a design.
3. The palette MUST be limited and semantic: colours mean things (illustrative:
   primary action, destructive action, success, warning, neutral surfaces) and
   mean them consistently; decoration never outranks meaning. Colour is never
   the only channel carrying information (pairs with Q8.5).
4. Iconography MUST be one consistent set, sized and weighted uniformly.
   Pictographs outside the set standing in for icons (illustrative: emoji in
   headings, buttons, navigation) violate this item. The app's logo appears
   where products place logos, not as recurring interface decoration.
5. Spacing MUST follow the scale: one base unit governs padding, gaps, and
   margins, so density is a decision, not an accident.
6. Elevation, borders, and radii MUST be consistent: the same kind of surface
   is raised, outlined, and rounded the same way everywhere.
7. If the app offers a colour scheme (light/dark), each scheme MUST satisfy
   every other item of this section on its own — contrast, semantics, and
   tokens re-resolved, not merely inverted.

### Q3. Layout and composition

Principle: **every screen is composed — aligned, weighted, and paced so the
user's eye is led, not abandoned.**

1. Screens MUST align to a grid: edges line up, gutters are regular, nothing
   sits at an unexplained offset.
2. Visual hierarchy MUST be explicit: the screen's primary object and primary
   action are unmistakable at a glance; secondary content is visibly secondary.
3. Density MUST match the task (illustrative: data-dense for working tables,
   calm for forms and reading); whitespace groups and separates deliberately.
4. Related controls and information MUST sit together: proximity implies
   relation, separation implies difference.
5. Data tables and lists MUST be designed artifacts: aligned columns (numeric
   data right-aligned), formatted values, controlled truncation with full
   values reachable, and pagination or virtualization past a screenful —
   never a raw dump of rows.
6. A screen MUST NOT require horizontal page scrolling; wide content (tables,
   charts, code) scrolls within its own container (pairs with Q9.2).

### Q4. Interaction design

Principle: **every interactive element communicates its affordance, its state,
and the consequence of acting — before, during, and after the interaction.**

1. Interactive elements MUST look and feel interactive through every applicable
   channel: cursor, hover, focus, and active states; disabled elements look
   disabled and, where not obvious, say why.
2. The cost of an action MUST be visible before it is taken: destructive or
   irreversible actions are visually distinct, and their confirmation names
   the specific target and consequence — never a generic "Are you sure?".
   Confirmation, like all interface chrome, is rendered by the app in its own
   design system; the app's interface is its own, not the platform's built-in
   dialog surface (illustrative: `alert`/`confirm`/`prompt`).
3. Users MUST have control and freedom: dialogs and panels dismiss predictably,
   multi-step flows go back without loss, and destructive outcomes offer undo
   where the data model permits it, confirmation where it does not.
4. Keyboard interaction MUST work where users expect it: forms submit from the
   keyboard, dismissal works from the keyboard, tab order follows visual
   order; high-frequency actions SHOULD have shortcuts consistent with
   platform convention.
5. Forms MUST minimize and respect effort: every field labelled, sensible
   defaults pre-filled, validation inline and adjacent to the field it
   concerns, submitted input preserved on error, and nothing asks for what the
   app already knows.
6. Interaction patterns MUST be internally consistent: the same control,
   gesture, or shortcut does the same thing everywhere in the app.
7. The app SHOULD prevent errors over handling them: constrain inputs to valid
   shapes, disable what cannot legally be clicked, and design flows so the
   wrong action is hard to take.

### Q5. State and feedback

Principle: **every screen and every action is designed in all of its reachable
states, and every action receives feedback at the tempo human perception
demands** — ~100 ms to feel instantaneous, ~1 s before flow breaks, ~10 s
before attention is lost.

1. Every asynchronous action MUST acknowledge within ~100 ms: the control
   responds (disables, shows progress, or applies the change optimistically)
   even when the work takes longer, and double submission is impossible by
   construction.
2. Loading MUST be designed: skeletons or progress indication for content
   areas, determinate progress where duration is knowable, and arriving
   content MUST NOT shift the layout it lands in.
3. Empty MUST be designed: a first-run or emptied screen says what belongs
   there and offers the action that fills it — never a blank region or a bare
   "no data".
4. Error MUST be designed: what happened in the user's language, what to do
   next, and a recovery path; raw stack traces, bare error codes, and dead
   ends are defects (error copy is judged under Q7.4).
5. Success MUST be visible: every write is acknowledged where the user is
   looking, and its effect appears in the UI without a manual refresh.
6. Partial and degraded states MUST be handled: partially failed batches,
   unreachable backends, and permission-denied views render designed screens,
   not broken ones (pairs with Q15).
7. Work running beyond ~10 s MUST free the user: progress observable,
   navigation away possible, completion surfaced when it arrives.

### Q6. Motion

Principle: **motion exists to make change legible — where things came from,
where they went — never for its own sake.**

1. State changes that rearrange, reveal, or remove content SHOULD transition
   briefly rather than teleport, preserving continuity (illustrative: panel
   and dialog entrances, reordering, expansion).
2. Durations and easing MUST be consistent app-wide and fast: utility
   transitions in the tens-to-~200 ms range, larger traversals ~250–400 ms,
   longer only at screen scale; spatial motion is eased, never linear.
3. The app MUST respect `prefers-reduced-motion`: with it set, non-essential
   motion is removed or reduced to opacity, and nothing conveys meaning
   through motion alone.
4. Motion MUST NOT cost attention: transitions never make the user wait beyond
   their purpose, never replay on every visit to the same screen, and any
   autoplaying or looping movement can be paused.

### Q7. Content and language

Principle: **every string in the interface was written for the user —
deliberately, consistently, completely.**

1. Shipped screens MUST be free of developer debris: no placeholder text,
   lorem ipsum, TODO/FIXME strings, debug output, or raw message keys visible
   anywhere a user can reach.
2. Labels MUST name the action or the thing (e.g., a button says what it does —
   "Create invoice", not "Submit"); one concept keeps one name app-wide
   (pairs with Q1.5).
3. Voice and tone MUST be consistent: one register chosen for the audience,
   held across screens, states, and messages; terminology, capitalization,
   and punctuation follow one convention.
4. Error and system messages MUST be human-readable, precise about what
   happened, constructive about what to do next, and never blame the user.
5. Data MUST be formatted for reading: dates, numbers, and currency consistent
   and appropriate to the audience; identifiers a user must read or
   transcribe are legible; units shown where ambiguity is possible.
6. Microcopy SHOULD carry the interface: helper text where a field's shape is
   not obvious, confirmations that echo what changed, counts and summaries
   where they orient.

### Q8. Accessibility

Principle: **the app is perceivable, operable, and understandable regardless of
ability or assistive technology.** The floor is WCAG 2.2 Level AA.
Accessibility lives in the design system so it holds by construction, not
per-screen patching.

1. Contrast MUST meet AA: 4.5:1 for text (3:1 for large text), 3:1 for
   interactive components and meaningful graphics.
2. The app MUST be fully keyboard-operable with no traps, in an order
   following visual flow, with a visible focus indicator never fully obscured.
3. Markup MUST be semantic: real buttons and links, labels programmatically
   bound to inputs, headings in hierarchical order, text alternatives on
   meaning-bearing images, and dynamic updates announced to assistive
   technology where they matter.
4. Pointer targets MUST measure at least 24×24 CSS px; touch-first surfaces
   SHOULD meet the platform norms above that floor (Apple 44 pt, Material
   48 dp). Drag-only interactions have single-pointer alternatives.
5. Information MUST NOT be conveyed by colour, motion, or sound alone; each
   has a redundant channel (pairs with Q2.3, Q6.3).
6. Text MUST remain usable resized to 200% and reflow at narrow widths without
   loss (pairs with Q9.2).
7. Authentication and repeated entry MUST NOT impose cognitive tests: nothing
   re-asks what the app already has, and no auth step depends on memorization
   or transcription without an alternative.

### Q9. Responsiveness and adaptation

Principle: **the app is usable across the viewport range and input modalities
its audience implies — layouts reflow; they do not merely shrink.**

1. Unless `requirements.md` narrows the audience, the app MUST be usable at
   common desktop, tablet, and phone widths: layouts restructure
   (illustrative: columns collapse, navigation adapts, tables linearize or
   scroll in-container) rather than scaling to illegibility.
2. Content MUST reflow to narrow viewports without horizontal page scrolling
   (320 CSS px is the floor); wide artifacts scroll within their own
   containers.
3. Interactive density MUST adapt to input: touch-driven layouts honor Q8.4's
   target sizes and spacing; pointer-driven layouts may be denser but never
   below the accessibility floor.
4. The app SHOULD honor the context signals it can serve cheaply
   (illustrative: `prefers-reduced-motion`, `prefers-color-scheme` where a
   scheme exists) rather than ignoring them.

---

## Part II — Engineering

### Q10. Performance

Principle: **speed is a feature the user can feel, and the app is judged at
realistic data volume, not demo scale.** The reference thresholds are the Core
Web Vitals, assessed at the 75th percentile: LCP ≤ 2.5 s, INP ≤ 200 ms,
CLS ≤ 0.1.

1. Initial meaningful render MUST be fast (LCP ≤ 2.5 s under lab conditions at
   realistic volume) and interactions MUST answer within INP's 200 ms budget;
   perceived acknowledgment is governed by Q5.1.
2. Layout MUST be stable: content, images, and fonts reserve their space
   (CLS ≤ 0.1; pairs with Q5.2).
3. Rendering MUST be bounded: the client paginates or virtualizes what the
   server already paginates (Q13.4); no screen renders an unbounded
   collection.
4. Assets MUST be sized to use: images at appropriate resolution and format,
   fonts subset where the stack allows, bundles free of dependencies nothing
   uses.
5. The app MUST NOT visibly refetch what it just had: navigation within a
   session reuses known-fresh data (the discipline of Q11).
6. Performance MUST hold at the data volume `requirements.md` implies: a
   screen instant with 10 records and unusable with 10,000 is a defect.

### Q11. Caching and data freshness

Principle: **the app has a deliberate freshness policy at every layer — what
may be cached, for how long, and how staleness resolves — rather than caching
by accident or defeating caches by default.**

1. Static assets MUST be cacheable and busted by content (illustrative:
   fingerprinted names with long lifetimes, or validator-based revalidation),
   so repeat visits pay nothing for the unchanged.
2. Data responses MUST declare their policy: explicitly cacheable with a
   lifetime and validator (`ETag` / `Last-Modified`), or explicitly not
   (`no-store` where privacy or correctness demands). Absence of any policy is
   a decision nobody made.
3. The client MUST NOT duplicate identical in-flight requests, and SHOULD
   serve known-fresh data instantly while revalidating in the background
   rather than blanking the screen to refetch.
4. Writes MUST invalidate what they change: after a mutation, affected views
   reflect the new state without a forced refresh (Q5.5), and caches holding
   the old state are invalidated or updated.
5. Where a shared cache or CDN applies to the deployment, the app SHOULD use
   it correctly — shared-cache directives deliberate, per-user responses
   never cached shared.

### Q12. Data modeling and integrity

Principle: **the schema is modeled, not accreted, and the store — not
application hope — holds the invariants.**

1. Fields MUST be typed to their meaning; relations are real references, not
   string conventions; required, unique, and referential rules live in the
   schema where the stack supports them.
2. Invariants whose violation corrupts data MUST be enforced at the storage or
   transaction boundary — UI validation is UX (Q4.7), never the defense.
3. Multi-step writes whose partial completion corrupts state MUST be atomic:
   transactions where the stack provides them, compensation where it does not.
4. Access patterns MUST stay sound at volume: frequently queried fields
   indexed once scans are felt (pairs with Q10.6), and pathological patterns
   avoided (illustrative: N+1 query loops, unbounded scans).
5. Migrations MUST be additive and replayable: they rebuild the schema on a
   fresh database, applied migrations are never edited, and collections
   holding data are never dropped while evolving (`agent-app validate`
   enforces this discipline where the stack declares it).
6. Time, money, and identity MUST be stored unambiguously (illustrative:
   timezone-aware instants, exact decimals for money, stable identifiers
   users may quote).

### Q13. API design

Principle: **the app's own HTTP surface is a contract — validated at the
boundary, consistent in shape, bounded in size, honest in status.** (The A2App
adapter's protocol surface has its own contract and is not judged here; this
section governs any additional API the app itself exposes.)

1. Every input MUST be validated server-side at the boundary — type, range,
   shape — regardless of what the UI already checked.
2. Errors MUST share one machine-readable shape across the API, carrying what
   failed and why (RFC 9457 `application/problem+json` is the citable form),
   with HTTP status codes matching semantics.
3. Naming, casing, and resource conventions MUST be consistent across all
   endpoints — one API, one dialect.
4. List endpoints MUST paginate, with a client-suggestable limit and a
   server-enforced maximum; no endpoint returns an unbounded collection.
5. Writes exposed to retry SHOULD be idempotent or idempotency-keyed, so a
   network retry cannot double-apply (pairs with Q15.2).
6. The API MUST NOT leak internals: stack traces, raw database errors,
   secrets, or other users' data never appear in responses.

### Q14. Architecture and code quality

Principle: **the app is structured so the next agent can change it safely —
concerns separated, decisions made once, configuration external.**

1. UI, application logic, and data access MUST be separated; a change to one
   does not ripple through the others.
2. The frontend MUST be componentized on the design system: screens compose
   reusable components that consume tokens (Q2.1); the same widget is one
   implementation, not per-screen copies.
3. State MUST be managed intentionally: server data, UI state, and derived
   state distinguished; every piece of state has one source of truth; nothing
   is duplicated into places that can disagree.
4. Rules MUST NOT be duplicated where they can diverge: one implementation per
   rule (illustrative: validation, formatting, permissions), shared by every
   consumer.
5. Configuration MUST be external to code — environment and manifest, not
   literals; nothing environment-specific is hardcoded.
6. Dependencies MUST be deliberate: needed, maintained, and current enough to
   hold their security patches; nothing unused is carried.
7. Code SHOULD read as if one author wrote it: the stack's idioms and naming
   held throughout, comments only where the code cannot say it.

### Q15. Resilience and error handling

Principle: **failure is a designed state — anticipated, contained, and
recovered or honestly reported.**

1. Every outbound call (backend, integration, third party) MUST have a
   timeout; nothing waits forever.
2. Retries MUST be disciplined: transient failures only, idempotent (or
   idempotency-keyed, Q13.5) operations only, with backoff, jitter, and a
   bounded attempt count — never a hot loop.
3. Repeated failure MUST degrade gracefully: the failing capability is
   contained — stop hammering, surface the outage, recover when it heals —
   while the rest of the app keeps working.
4. Failures MUST surface as designed states (Q5.4), and unsaved work survives
   the failure wherever the data model permits.
5. Exceptions MUST be handled deliberately: caught where recovery is possible,
   logged with context (Q17.2), never silently swallowed, never leaked to the
   user or the API (Q13.6).
6. Security-relevant paths MUST fail closed: an error inside an authorization
   or validation check denies, never allows.

---

## Part III — Stewardship

### Q16. Security and privacy practice

Principle: **secure by construction, private by default.** The framework's
gates enforce what machines can check; this section is the practice standard
the verifier judges the built app against.

1. Authorization MUST be least-privilege and server-enforced: every data
   access scoped to its owner or role on the server; client-side checks are
   UX affordances, never the control.
2. All input MUST be treated as untrusted at every boundary: parameterized
   queries, encoded output, no interpolation of user input into queries,
   commands, or markup.
3. Authentication MUST follow the stack's vetted practice: credentials hashed
   by the platform mechanism, sessions that expire, and access rules
   consistent with the app's declared `authMode`.
4. Secrets MUST exist only at runtime: never in source, logs, error messages,
   or client-delivered code.
5. The app MUST collect and retain the minimum personal data its purpose
   requires, and personal data MUST NOT leak into logs, URLs, or error
   reports.
6. Defaults MUST be closed: new entities, rules, and endpoints start
   restricted and are opened deliberately.

### Q17. Observability and operations

Principle: **when the app misbehaves, the evidence already exists — diagnosis
reads it, never guesses.** The log captured by `agent-app serve` is the primary
artifact.

1. Logs MUST be structured — consistent fields, one schema — rather than free
   prose, so they can be filtered and correlated.
2. Errors MUST be logged with diagnostic context: the operation, the shape of
   its inputs (never secrets or personal data, Q16.5), and a structured stack
   trace, at severity levels used consistently.
3. Request-scoped work SHOULD carry a correlation identifier through its logs,
   so one user action traces end to end.
4. The health endpoint declared in the manifest MUST reflect real readiness —
   the app can serve its purpose, not merely that a port answers; degraded
   SHOULD be distinguishable from healthy.
5. The user surface and the log divide cleanly: the user sees designed states
   (Q5.4); the log sees the details. Neither substitutes for the other.

### Q18. Version control and maintainability

Principle: **the repository's history is an instrument of evolution — every
state reachable, every change explicable.**

1. Work MUST be committed in coherent units — one feature, fix, or refactor
   per commit, with a message saying what and why — so evolution, review, and
   rollback have real units to operate on.
2. The main line SHOULD stay deployable: integration at least daily, few
   concurrent branches, incomplete work behind flags rather than long-lived
   branches.
3. Generated artifacts, dependencies, credentials, and user data MUST NOT be
   committed.
4. The app MUST build from a clean checkout by its declared pipeline alone
   (`install`, `build`, `start`) — no undocumented manual steps.
