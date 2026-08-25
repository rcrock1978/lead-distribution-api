# Feature Specification: Lead Distribution Platform

**Feature Branch**: `001-lead-distribution-platform`

**Created**: 2026-08-25

**Status**: Draft

**Input**: User description: "PRD-Lead-Distribution-Platform-v5.md — the complete
Lead Distribution Platform defined by this Product Requirements Document"

## Clarifications

### Session 2026-08-25

- Q: What rate limit should apply to public form submissions from one source
  address? → A: Configurable ceiling defaulting to at least 30 submissions per
  minute per source IP — generous enough that the mandated concurrency
  acceptance tests never trip it, tunable per deployment without code change.
- Q: How long should captured lead data be retained? → A: Automatic purge of
  lead records older than 90 days; the assignment-registry record for an email
  is retained permanently so the duplicate guard can never be bypassed by a
  purge.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Administrator Onboarding and Configuration (Priority: P1)

A single administrator signs in with credentials established at deployment and
configures the commercial machinery: brokers (each with a share percentage,
daily cap, IANA timezone, daily opening/closing hours, working days, active
flag), exactly one public intake form (name plus an auto-derived public URL
slug), and exactly one distribution agreement that binds that form to the
selected brokers. Attempting to create a second form or second distribution —
through the interface or through any direct system-to-system channel — is
impossible. Creating a distribution before a form is rejected with the exact
message "Oops, please create a form first."

**Why this priority**: Nothing else can operate until the business is
configured; the singleton guarantees are automatic-fail conditions.

**Independent Test**: Sign in, create two brokers in different timezones,
create the form (public URL becomes live), bind both brokers at 50/30/20-style
shares. Delivers a configured, ready-to-receive business.

**Acceptance Scenarios**:

1. **Given** valid seeded credentials, **When** the administrator signs in,
   **Then** access to all administrative areas is granted; a wrong password
   returns a generic failure that does not reveal whether the account exists.
2. **Given** no session, **When** any administrative area is requested,
   **Then** access is denied and the visitor is directed to sign in.
3. **Given** a broker form, **When** the administrator saves a broker with a
   valid timezone, hours, working days, cap, and percentage, **Then** the
   broker persists and appears in lists with its live open/closed state.
4. **Given** one form already exists, **When** a second creation is attempted
   through any channel, **Then** it fails identically and the original form is
   unchanged; the existing form cannot be deleted.
5. **Given** no form exists yet, **When** a distribution creation is attempted,
   **Then** the exact message "Oops, please create a form first." is shown and
   nothing is created.
6. **Given** a form exists, **When** a distribution is created, **Then** it is
   automatically bound to that form; a second distribution is impossible via
   any channel.

---

### User Story 2 - Public Lead Capture With Duplicate Prevention (Priority: P1)

An anonymous visitor opens the public form at its slug address (no login), and
submits name, email, and phone. The lead is always recorded together with the
visitor's IP address, and the confirmation shown is identical whether the lead
routed, did not route, or was a duplicate — so the visitor can never infer
whether their email was seen before. An email that has previously been
*assigned to a broker* can never be assigned again, even when many submissions
of the same email arrive simultaneously; only one wins. Email input is
normalized (trimmed, lowercased) before storage and comparison.

**Why this priority**: Capturing leads without selling the same person twice
is the platform's reason to exist; duplicate prevention under concurrency is
an automatic-fail condition.

**Independent Test**: Publish the form, submit from an unauthenticated
browser, verify the stored lead shows a non-null IP; then submit the same
email repeatedly and concurrently and observe exactly one assignment ever.

**Acceptance Scenarios**:

1. **Given** the published form, **When** an anonymous visitor submits valid
   details, **Then** the submission succeeds within about a second and shows
   the standard confirmation.
2. **Given** any recorded lead regardless of outcome, **When** the
   administrator inspects it later, **Then** a non-null IP address is present
   and displayed.
3. **Given** an email previously assigned to any broker, **When** it is
   submitted again in any letter case or surrounding whitespace, **Then** the
   result is a duplicate: no new assignment occurs.
4. **Given** an email whose earlier submission has *not yet* been assigned,
   **When** it is submitted again, **Then** it is accepted as a fresh attempt
   (an unsold lead is still sellable).
5. **Given** ten simultaneous submissions of the same never-seen email,
   **When** all are processed, **Then** exactly one is assigned and the rest
   are marked duplicates.
6. **Given** malformed input (too-short name, invalid email or phone),
   **When** submitted, **Then** field-level validation errors are returned and
   nothing is persisted.

---

### User Story 3 - Automatic Fair-Share Routing (Priority: P1)

Every captured lead is routed automatically to an eligible broker using the
deficit formula against each broker's contracted share of the day's total:
the broker whose remaining deficit is largest receives the next lead. Eligibility
requires all of: broker active, linked to the distribution and active within
it, percentage greater than zero, today within the broker's working days (in
the broker's own timezone), current time within the broker's opening window
(overnight windows supported), and under the broker's daily cap. Caps are
never exceeded even under concurrent load. The stored decision trace proves
every choice: which brokers were excluded and by which rule, and the deficit
mathematics for the winner. If no broker is eligible, the lead remains unsent
with the reason recorded rather than being dropped or mis-routed.

**Why this priority**: This is the commercial heart — even distribution per
agreement is what the customer pays for; mis-routing or cap overruns are
automatic failures.

**Independent Test**: Configure three brokers at 50/30/20 with mixed
timezones, hours, and caps; submit a known sequence of leads; verify each
assignment matches hand-computed deficits and every exclusion names its rule.

**Acceptance Scenarios**:

1. **Given** brokers at 50/30/20 shares, **When** leads arrive through a day,
   **Then** assignments track the highest-deficit broker at each step and the
   stored traces show the arithmetic.
2. **Given** a broker whose local time is outside opening hours (including an
   overnight window), on a non-working day, inactive, capped, or at zero
   percentage, **When** routing runs, **Then** that broker is excluded and the
   exclusion rule is named in the decision trace.
3. **Given** a broker's daily cap of 2, **When** three leads would otherwise
   select that broker, **Then** at most two are ever assigned to it —
   including when all three submissions are simultaneous.
4. **Given** ties in deficit, **When** routing selects, **Then** the broker
   with fewer sent today wins; if still tied, the lower-numbered broker wins.
5. **Given** every eligible broker above target (negative deficit), **When**
   routing selects, **Then** the least-over broker still receives the lead;
   leads are never dropped for this reason.
6. **Given** the day boundary, **When** counting "sent today", **Then** totals
   use the distribution's reference timezone while individual caps reset on
   each broker's own local calendar day.
7. **Given** no eligible broker exists, **When** routing completes, **Then**
   the lead stays visibly unsent with the recorded reason, available for
   manual handling.

---

### User Story 4 - Lead Oversight and Manual Rescue (Priority: P2)

The administrator monitors outcomes across purpose-built views: a leads list
with status/broker/date/search filters and paging that stays fast as volume
grows; a distribution detail audit view showing every lead with date, contact
details, IP, status, broker attribution, failure reason, and expandable
decision mathematics; and a per-broker view listing that broker's leads with
name, email, phone, IP, form name, date received, and status. Unsent leads can
be manually assigned to a chosen eligible broker — the same hard rules apply:
caps cannot be exceeded and duplicates are blocked, while closed/out-of-hours
status may be overridden deliberately. Failed routings can be retried.

**Why this priority**: The administrator must be able to answer "why did this
lead go where it went?" and rescue stuck leads without touching data directly.

**Independent Test**: With a mix of sent/duplicate/unsent/failed leads, filter
and inspect each view, manually assign an unsent lead, attempt to exceed a cap
manually, and retry a failed lead.

**Acceptance Scenarios**:

1. **Given** leads in all four states, **When** the administrator opens the
   audit views, **Then** every lead displays its status, IP, broker (if any),
   and failure reason; routed rows expand to show the recorded maths.
2. **Given** an unsent lead, **When** the administrator manually assigns it to
   an eligible broker, **Then** the lead becomes sent, attributed as manual,
   with the assignment time recorded.
3. **Given** a capped broker, **When** manual assignment to it is attempted,
   **Then** it is blocked; given a duplicate email, manual assignment is also
   blocked; given a currently-closed broker, the administrator may override
   deliberately.
4. **Given** a failed lead, **When** retry is invoked, **Then** routing runs
   again under the same rules.
5. **Given** hundreds of accumulated leads, **When** the list is browsed and
   filtered, **Then** pages return promptly with consistent response times.

---

### User Story 5 - Operational Health and Decision Transparency (Priority: P2)

The platform continuously exposes its own operational state inside the product,
without server shell access: liveness and readiness indicators (readiness turns
unhealthy if message processing stalls), queue depth including stuck and dead
items, processing heartbeat age, end-to-end routing latency statistics, and a
correlated machine-readable event trail — every request and every routing
decision emits an auditable record sharing one correlation identifier, so the
complete life of a single lead can be retrieved with one search. Recent errors
surface alongside their correlation identifiers.

**Why this priority**: A silently dead processor reads as a broken product;
transparent operations are Tier-0-grade trust infrastructure for review.

**Independent Test**: Stop and restart processing; verify readiness flags the
gap and recovers; submit one lead and retrieve its full cross-process event
trail via its single identifier.

**Acceptance Scenarios**:

1. **Given** normal operation, **When** readiness is checked, **Then** it
   reports healthy with database reachability, applied migrations, and a fresh
   processing heartbeat.
2. **Given** message processing stopped, **When** readiness is checked,
   **Then** it reports unhealthy; queued leads accumulate visibly as unsent
   and route automatically once processing resumes, none lost.
3. **Given** any submitted lead, **When** its correlation identifier is
   searched, **Then** the captured, queued, claimed, processed, and routed
   events are all retrievable in order across services.
4. **Given** a permanently failing item, **When** attempts exhaust, **Then**
   it is marked dead with its last error visible and can be replayed by the
   administrator.

---

### User Story 6 - Operations Console (Priority: P3)

A single auto-refreshing administrative console presents live panels: system
health (uptime, heartbeat age highlighted when stale, version, database and
migration state), queue depth by state with oldest-item age and throughput,
routing statistics over the last 24 hours with exclusions grouped by rule,
per-broker live availability and cap usage, and recent errors linking to their
full trails. All underlying data is already produced by the platform; this
console makes it visible at a glance.

**Why this priority**: High-value demonstration and debugging surface, but the
same facts remain reachable through the health endpoints and event trail if it
is deferred.

**Independent Test**: Open the console during live traffic; each panel updates
within its refresh interval and agrees with the underlying records.

**Acceptance Scenarios**:

1. **Given** live traffic, **When** the console auto-refreshes, **Then** queue
   depth, latency figures, and exclusion counts match the event trail.
2. **Given** a broker past closing, **When** the console renders, **Then** the
   broker panel shows closed with the next opening time.
3. **Given** a stale heartbeat beyond sixty seconds, **When** the console
   renders, **Then** the health panel highlights it prominently.

---

### Edge Cases

- What happens when a broker's opening window crosses midnight (e.g., 22:00–06:00)? The window wraps correctly; minutes-since-midnight comparisons handle the span.
- How does eligibility behave on a daylight-saving transition day? Local wall-clock evaluation uses the zone's rules for that instant; tested across at least three timezones including one DST boundary.
- What happens when simultaneous submissions race for a broker's final cap slot? Exactly one wins; the loser re-selects among remaining brokers, bounded retries.
- What happens when percentages total less or more than 100? The interface warns but permits; routing proceeds proportionally.
- What happens when a scanner probes unknown slugs repeatedly? Unknown slugs return not-found; protection bounds repeated misses without affecting legitimate traffic.
- What happens when the same email arrives while its previous lead is still unsent? Accepted as fresh; duplication authority is prior assignment, not prior submission.
- What happens when the processor crashes mid-item? In-progress work is recovered automatically after a short grace period; nothing is lost or double-assigned.
- What happens when the whole service restarts under traffic? Data is intact; pending work drains in order; no lead requires re-submission.
- What happens when a broker holding leads is deleted? Deletion is refused; deactivation is offered instead, preserving history.
- What happens when a lead's form slug is renamed after publication? The old address stops resolving (not found); the current address serves the form.

## Requirements *(mandatory)*

### Functional Requirements

**Access and configuration**

- **FR-001**: The system MUST provide a single administrator account provisioned
  at deployment; sessions expire after 24 hours and failed sign-ins MUST return
  a generic error without revealing account existence.
- **FR-002**: All administrative functionality MUST require an authenticated
  session; the public intake form MUST be reachable without one.
- **FR-003**: The system MUST enforce exactly one form and exactly one
  distribution for the lifetime of the installation, via guarantees that hold
  against direct system-to-system calls, not only through the interface.
- **FR-004**: The system MUST reject distribution creation with the exact
  message "Oops, please create a form first." when no form exists.
- **FR-005**: The system MUST prevent deletion of the form once created and
  refuse broker deletion once the broker holds leads OR the broker is a
  distribution member (deactivation offered instead).
- **FR-006**: The system MUST accept brokers with: unique name (2–100 chars),
  active flag, integer daily cap where 0 means unlimited, a valid IANA
  timezone, `HH:MM` opening/closing times, a non-empty set of working days,
  and a percentage 0–100 with up to two decimals.
- **FR-007**: The system MUST derive a unique URL slug for the form
  automatically, restricted to lowercase letters, digits, hyphens (2–50
  chars) and excluding reserved words (`api`, `login`, `dashboard`, `brokers`,
  `leads`, `form`, `distribution`, `ops`); derivation retries collisions
  up to 50 attempts, then fails visibly with `SLUG_TAKEN`.

**Capture**

- **FR-008**: The system MUST let anonymous visitors submit name, email, and
  phone at the form's public address and show one uniform confirmation
  regardless of outcome (routed, unsent, or duplicate), meeting baseline
  accessibility: labelled inputs, full keyboard operability, and announced
  validation errors.
- **FR-009**: The system MUST normalize email addresses (trim, lowercase)
  before storage and any comparison; phone accepts 7–20 characters including
  `+ - ( )` and spaces; names are 2–100 characters.
- **FR-010**: The system MUST capture and store the visitor's public IP
  address on every lead regardless of outcome, normalized (loopback forms
  mapped to 127.0.0.1), never null, and display it in all lead views. Addresses render unmasked in admin-only
  views only and expire with their lead row at the 90-day purge.
- **FR-011**: The system MUST define duplicate strictly as "this email was
  previously assigned to a broker"; a repeat while the earlier lead is still
  unsent MUST be accepted as a fresh attempt.
- **FR-012**: The system MUST rate-limit public submissions per source address
  to a configurable ceiling defaulting to at least 30 submissions per minute
  (so required concurrency tests are unaffected), and include an invisible
  anti-bot field whose fill is dropped silently BEFORE rate-limit
  accounting, returning the identical confirmation.
- **FR-013**: Recording a lead MUST NOT fail because no broker is selectable;
  the lead is stored and its routing intent persisted atomically with it.

**Routing**

- **FR-014**: The system MUST route each captured lead automatically by
  highest deficit, where `targetAfterLead = (totalSentToday + 1) ×
  brokerPercentage / 100` and `deficit = targetAfterLead − brokerSentToday`;
  highest deficit wins.
- **FR-015**: The system MUST count `totalSentToday` across all distribution
  brokers using the distribution's reference timezone (administrator-
  configurable, default Asia/Manila), while caps and working-day/hour checks
  use each broker's own timezone.
- **FR-016**: The system MUST require ALL of the following for eligibility:
  broker active; linked and active within the distribution; percentage > 0;
  today a working day broker-locally; broker-local time within `[open, close)`
  supporting overnight windows; sent-today under cap.
- **FR-017**: The system MUST break deficit ties by fewer sent today, then by
  lower broker number; MUST still assign (to the least-over broker) when all
  eligible deficits are negative; and MUST never drop a lead solely because
  every broker is above target.
- **FR-018**: The system MUST guarantee daily caps are never exceeded under
  any concurrency, treating the cap check-and-increment as one indivisible
  step with bounded re-selection on loss.
- **FR-019**: The system MUST persist a decision trace on every routed lead:
  each excluded broker with the rule that fired (`inactive`, `closed`,
  `off_day`, `capped`, `zero_pct`) and the winning broker's deficit
  arithmetic; traces are excluded from list views and load only on detail.
- **FR-020**: When no broker is eligible, the system MUST leave the lead
  visibly unsent with the recorded reason and candidate count.
- **FR-021**: Assignment MUST be idempotent: redelivery or replay of the same
  routing intent can never double-assign or double-count against a cap.
- **FR-022**: Routing intent MUST survive service restarts via durable queued
  work with exponential backoff, a bounded attempt count leading to a visible
  dead state, automatic recovery of interrupted work, and administrator
  replay of dead items.

**Manual intervention**

- **FR-023**: Administrators MUST be able to manually assign unsent leads to a
  chosen broker under the same invariants (caps and duplicates hard-blocked;
  closed/out-of-hours may be overridden deliberately), with the assignment
  marked manual and timestamped in the target broker's timezone.
- **FR-024**: Administrators MUST be able to retry failed leads; retries obey
  all routing rules.

**Views and oversight**

- **FR-025**: The administrator dashboard MUST show setup progress (form,
  distribution, brokers, processor health), last ten leads, and the unsent
  count linked to the filtered list.
- **FR-026**: Lead listings MUST support filtering by status, broker, date
  range, and search; large lists MUST page with consistent response times as
  volume grows into the tens of thousands.
- **FR-027**: Every data view MUST handle loading, empty, success, and error
  states explicitly; every error state MUST expose at least one recovery
  affordance (retry control or navigation link).
- **FR-028**: The distribution detail view MUST show every lead with date,
  contact details, IP, status, broker attribution, and failure reason, with
  routed rows expanding to the recorded mathematics and unsent rows exposing
  inline assign/retry.
- **FR-029**: Broker listings MUST display live open/closed state and
  today's count versus cap.

**Operations and integrity**

- **FR-030**: The system MUST expose liveness and readiness indicators where
  readiness reflects database reachability, completed migrations, and a
  processing heartbeat fresher than 60 seconds, reporting unhealthy otherwise.
- **FR-031**: The system MUST make queue depth (pending/in-progress/dead), oldest
  pending age, and end-to-end routing latency observable within the product,
  without command-line access to the server.
- **FR-032**: Every request and every routing decision MUST produce a
  machine-readable audit event carrying a shared correlation identifier that
  spans all services and asynchronous boundaries, enabling full retrieval of a
  lead's life with one search; credentials and request payloads are never
  recorded in audit events; emails appear masked.
- **FR-033**: Administrators MUST always see current data immediately after any
  change — no view may serve pre-change information after a mutation, and no
  value enforcing an invariant may ever be served from a cache.
- **FR-034**: No real credential may ever enter version history; example
  configurations contain placeholders only, and automated secret scanning MUST
  run before every delivery.
- **FR-035**: The deployment MUST run as ordinary processes on a single server
  without elevated privileges, survive restarts with data intact, and come
  with documentation enabling a first-time reviewer to reproduce every
  verification step on a clean machine unaided.
- **FR-036**: The system MUST automatically purge lead records older than 90
  days on a recurring schedule, while permanently retaining every
  assignment-registry record so the duplicate guard is never weakened by a
  purge; purges MUST leave counts, audit views, and cap enforcement consistent.

### Key Entities *(include if feature involves data)*

- **Administrator**: The sole privileged user; seeded credentials; no
  self-registration.
- **Broker**: A lead recipient under contract; attributes: name, active flag,
  share percentage, daily cap (0 = unlimited), IANA timezone, opening/closing
  times, working days; owns a per-local-day assignment count.
- **Form**: The single public intake definition; attributes: name, public URL
  slug; immutable after creation; not deletable.
- **Distribution**: The single routing agreement; binds the form, a reference
  timezone, and member brokers each with a percentage and an in-distribution
  active flag.
- **Lead**: One applicant's submission; attributes: name, normalized email,
  phone, source IP, status lifecycle (unsent → sent / duplicate / failed),
  assigned broker, timestamps, assignment type (automatic/manual), decision
  trace, correlation identifier, failure reason.
- **Assignment Registry**: One record per email ever assigned (email →
  broker); the authoritative duplicate guard; retained permanently, never
  purged.
- **Daily Counter**: Per-broker, per-local-day assignment tally used to
  enforce caps atomically.
- **Routing Task**: Durable work item representing pending routing intent;
  carries state (pending/in-progress/completed/dead), attempt count, next
  attempt time, last error, and the lead's correlation identifier.
- **Processor Heartbeat**: Liveness evidence (identity, last beat, cumulative
  processed count) backing readiness and console panels.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An unauthenticated visitor can submit the public form and see
  the uniform confirmation within 2 seconds under normal conditions.
- **SC-002**: At least 99% of capturable leads (eligible broker available) are
  automatically assigned within 3 seconds of submission; capture-to-assignment
  p95 under 3 seconds.
- **SC-003**: Under a 10-way simultaneous submission of one new email, exactly
  1 assignment and 9 duplicates result, 100% of the time across repeated runs.
- **SC-004**: Under a 20-way simultaneous submission against a cap of 5,
  exactly 5 assignments occur — zero cap overages in any run.
- **SC-005**: 100% of stored leads carry a non-null IP address displayed in
  every lead view.
- **SC-006**: Across the full verification suite, brokers failing any
  eligibility gate (inactive, closed, off-day, capped, zero-percentage) are
  selected 0 times, and 100% of routed leads have a decision trace naming
  every exclusion rule plus the winner's arithmetic.
- **SC-007**: Attempts to create a second form or second distribution fail
  100% of the time through both the interface and direct system-to-system
  channels.
- **SC-008**: After any mutation, administrators observe updated data on the
  very next view 100% of the time (no stale reads), verified immediately after
  percentage changes, assignments, and captures.
- **SC-009**: Any lead's complete life (capture → routing → assignment, or
  capture → duplicate/unsent) is retrievable by one search on its correlation
  identifier, covering every service involved.
- **SC-010**: A reviewer following the delivered documentation alone completes
  the full verification checklist on a clean machine without assistance.
- **SC-011**: Restarting the running services mid-traffic loses 0 leads;
  queued work drains in order afterwards.
- **SC-012**: Any administrative page fully renders within 1 second under
  normal load on the reference environment described in Assumptions, and lead lists respond consistently at 10,000+ rows.
- **SC-013**: After the retention schedule runs, 100% of lead records older
  than 90 days are removed while every corresponding assignment-guard record
  persists; re-submitting a purged email still returns duplicate.

## Assumptions

- Out of scope for this feature: broker logins, multiple forms or
  distributions, form builders, notifications, exports and charting,
  multi-tenancy, role hierarchies, and external monitoring services.
- Single-administrator model: one seeded account, no self-registration, no
  role hierarchy; brokers never log in.
- Exactly one form and one distribution exist for the product's life;
  deletion is unsupported by design.
- Percentages need not sum to 100 — the interface warns, routing proceeds
  proportionally (documented default Q1).
- Duplicate means previously *assigned*, not merely previously submitted
  (documented default Q2).
- Asynchronous assignment (~1 second typical) is acceptable; visitors always
  receive the same confirmation regardless of outcome (documented default Q9).
- Reference timezone defaults to Asia/Manila and is administrator-configurable
  (documented default Q7).
- Deployment targets one modest server without elevated privileges; no
  external third-party services are required beyond a reachable relational
  database provisioned at deployment time.
- Expected volume is modest (low hundreds of leads/day); performance targets
  are calibrated to that scale.
- Interface language is English; primary usage is desktop browsers.
- Internal API token is static for this deployment scope; rotation is a
  manual procedure documented in the security checklist.
- Concurrent administrator configuration writes follow last-write-wins;
  the single-admin model makes conflicts unlikely, so no optimistic
  locking is required.
- System clocks are NTP-disciplined; slew corrections are small enough
  that per-day counters and heartbeat ages remain consistent.
