# Tasks: Lead Distribution Platform

**Input**: Design documents from `/specs/001-lead-distribution-platform/`

**Prerequisites**: plan.md ✅ | spec.md ✅ | research.md ✅ | data-model.md ✅ |
contracts/api.md ✅ | quickstart.md ✅

**Tests**: INCLUDED — the specification and constitution explicitly require
them (domain test-first, real-concurrency suites, budget assertions, cache
parity). Test tasks precede implementation within each story.

**Organization**: Tasks grouped by user story (US1–US6 from spec.md) so each
story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Owning user story (US1…US6); omitted in Setup/Foundational/Polish
- Every description names exact file paths

## Path Conventions

Two-application layout per plan.md: `backend/src/**`, `backend/tests/**`,
`frontend/app/**`, `frontend/lib/**`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Two-repo scaffolding, tooling, process topology

- [X] T001 Scaffold `backend/` Node 20 TypeScript package: package.json, tsconfig, ESLint with import-boundary rules failing the build on upward imports, .gitignore committed FIRST, .env.example placeholders only (per research D5/D15)
- [X] T002 [P] Scaffold `frontend/` Next.js App Router TypeScript app: package.json, tsconfig, next.config.js with `staleTimes.dynamic = 0`, .env.example placeholders only (per research D13)
- [X] T003 [P] Configure Vitest in `backend/tests/` with workspace dirs `unit/domain`, `unit/application`, `integration`, `concurrency`, `budgets`; disable file parallelism for MySQL-touching suites
- [X] T004 [P] Create `ecosystem.config.js` at repo root defining lead-api (instances 1, 300M), lead-worker (instances 1 LOAD-BEARING, 200M, exp_backoff_restart_delay 200), lead-web (400M, public port) per plan.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, observability, middleware, outbox — MUST complete before ANY user story

**⚠️ CRITICAL**: No user story work until this phase is done.

- [X] T005 Write complete `backend/prisma/schema.prisma` implementing ALL entities, indexes, and invariants from data-model.md (User, Form, Distribution, Broker, DistributionBroker, Lead, AssignedEmail PK-on-email, BrokerDailyCounter unique [brokerId,localDate], Outbox, WorkerHeartbeat, ConfigVersion single row)
- [X] T006 Create initial Prisma migration and `backend/prisma/seed.ts` seeding the single admin from SEED_ADMIN_EMAIL/PASSWORD env (bcrypt cost 12)
- [X] T007 [P] Implement typed pino logger with closed event-taxonomy string-literal union, serializer-level redact paths, child loggers in `backend/src/infrastructure/observability/logger.ts`
- [X] T008 [P] Implement correlation module generating 16-byte-hex traceId/requestId with AsyncLocalStorage request context in `backend/src/infrastructure/observability/correlation.ts`
- [X] T009 [P] Implement Clock port with Luxon and memoized IANAZone map (`zoneFor`) returning ZonedInstant in `backend/src/infrastructure/time/luxon-clock.ts` and matching port interface in `backend/src/application/ports/clock.port.ts`
- [X] T010 [P] Implement in-process metrics registry (counters, gauges, histograms over rolling 1000-sample windows with p50/p95/p99) in `backend/src/infrastructure/observability/metrics.ts`
- [X] T011 Implement Zod-parsed env loader exiting fast on invalid config in `backend/src/config/env.ts` covering all variables from plan.md including PUBLIC_RATE_LIMIT_PER_MIN (default 30) and CONFIG_CACHE/INLINE_WORKER flags
- [X] T012 Build Express app factory with EXACT middleware order requestId/logger → helmet → cache-headers per class → internal-token guard (constant-time) → rate limiter (public routes only, env default ≥30/min) → body parser 64kb → JWT verify NO database lookup → router → terminal error handler mapping AppError taxonomy in `backend/src/interfaces/http/middleware/`
- [X] T013 Implement explicit composition root `buildContainer(env)` constructing logger/metrics/clock/prisma/repos/use-cases with cache decorators swappable by CONFIG_CACHE in `backend/src/infrastructure/container.ts`
- [X] T014 Implement transactional outbox: OutboxMessage Zod schema, publish-inside-caller-transaction port, SKIP LOCKED batch claim, consumer loop (500ms poll, exponential backoff 1s→256s with jitter, DEAD at 5 attempts, stale-claim reaper >5min), worker entrypoint writing heartbeat rows in `backend/src/infrastructure/messaging/` and `backend/src/main-worker.ts`
- [X] T015 Add liveness/readiness endpoints (readiness = DB reachable ∧ migrations applied ∧ heartbeat <60s else 503 with reasons) in `backend/src/interfaces/http/routes/health.routes.ts`
- [X] T016 Create frontend server-side API client with named fetch functions (stable for React request memoization) and cookie-forwarding session helper in `frontend/lib/api-client.ts` and `frontend/lib/auth.ts`
- [X] T017 Establish contract pipeline: `backend/src/contracts/index.ts` envelope + shared schemas, `npm run contracts:build` (tsc --emitDeclarationOnly) and `contracts:sync` scripts, drift-hash check script wired to CI config and pre-push hook (per research D2)

**Checkpoint**: Foundation ready — `pm2 start` boots api+worker green; `/api/health/ready` returns 200; user stories can proceed.

---

## Phase 3: Domain Ring — US3 Core (Constitution Workflow Gate)

**Goal**: Pure routing logic written test-first with ZERO infrastructure —
constitution mandate satisfied before any HTTP code exists.

**Independent Test**: `npm test` green on domain/application suites with no
database running; Day-1 gate provable in isolation.

- [X] T018 [P] [US3] (was T034) Domain unit suite for selectBroker: worked 50/30/20 example, all-ineligible, tie by fewer-sent then lower-id, all-negative-deficit least-over-wins, zero-percentage exclusion, overnight window, DST boundary, three timezones with injected clocks — zero database in `backend/tests/unit/domain/select-broker.test.ts`
- [X] T019 [P] [US3] (was T035) Application unit tests with in-memory port fakes: idempotent redelivery ack, duplicate collision path, cap exhaustion mid-selection re-select ≤3 attempts, no-distribution leaves UNSENT with reason in `backend/tests/unit/application/route-lead.use-case.test.ts`
- [X] T020 [US3] (was T037) Implement value objects TimeWindow (overnight wrap), WorkingDays, Percentage (targetFor), ZonedInstant in `backend/src/domain/value-objects/` and Broker.canReceiveAt returning Eligibility|Ineligible(reason) in `backend/src/domain/entities/broker.entity.ts`
- [X] T021 [US3] (was T038) Implement pure selectBroker(candidates, totalSentToday, now) returning Selected(brokerId, trace)|NoEligibleBroker(reason, trace) with trace recording each exclusion rule inactive|closed|off_day|capped|zero_pct and winner arithmetic in `backend/src/domain/services/select-broker.ts`

**Checkpoint**: domain suite green with zero database — Day-1 gate satisfied;
HTTP implementation may begin.

---

## Phase 4: User Story 1 — Administrator Onboarding & Configuration (Priority: P1) 🎯 MVP

**Goal**: Admin signs in; creates brokers, the single form (slug), and the single bound distribution; singleton guards hold via any channel.

**Independent Test**: quickstart S1–S3 (auth gate, singleton 409s through UI and direct unauthenticated/tokenless calls, brokers across timezones with correct isOpenNow).

### Tests for User Story 1

> Write FIRST, confirm FAIL before implementation.

- [X] T022 [P] [US1] Integration tests for auth endpoints (login success/generic-failure/me/logout, cookie flags) in `backend/tests/integration/auth.test.ts`
- [X] T023 [P] [US1] Integration tests proving singleton invariants via direct API without internal token AND with it: second form 409 FORM_ALREADY_EXISTS, second distribution 409, premature distribution exact message `Oops, please create a form first.` (400 FORM_REQUIRED), broker delete-with-leads 409 in `backend/tests/integration/singletons.test.ts`

### Implementation for User Story 1

- [X] T024 [US1] Implement bcrypt (cost 12) and JWT sign/verify services (24h expiry) in `backend/src/infrastructure/security/bcrypt.service.ts` and `jwt.service.ts`
- [X] T025 [US1] Implement auth controller/routes login/logout/me with Zod schemas and audit events auth.login.succeeded/.failed (email masked) in `backend/src/interfaces/http/controllers/auth.controller.ts` and `routes/auth.routes.ts`
- [X] T026 [US1] Implement broker CRUD as thin service (controller + Zod schema + Prisma call, no CA layers): list with sentToday/isOpenNow/isCapped computed per broker timezone, create/update/get/delete-with-leads-409 in `backend/src/interfaces/http/controllers/broker.controller.ts`, `backend/src/services/broker.service.ts`
- [X] T027 [US1] Implement CreateFormUseCase (slug auto-derivation + reserved-word block + SLUG_TAKEN retry, ConfigVersion bump in same tx) and form routes GET/POST `/api/form` in `backend/src/application/use-cases/create-form.use-case.ts` and `backend/src/interfaces/http/controllers/form.controller.ts`
- [X] T028 [US1] Implement CreateDistributionUseCase (FORM_REQUIRED exact message, auto-bind formId, DISTRIBUTION_ALREADY_EXISTS 409) plus member replacement PUT and PATCH with ConfigVersion bump in-tx in `backend/src/application/use-cases/create-distribution.use-case.ts` and `backend/src/interfaces/http/controllers/distribution.controller.ts`
- [X] T029 [US1] Build admin UI: `(admin)/layout.tsx` with force-dynamic + fetchCache 'only-no-store', login page, brokers page (timezone search default Asia/Manila, day chips, cap modal), read-only form page with URL preview, distribution page with percentage inputs + ≠100% warning in `frontend/app/(admin)/` and Server Actions in `frontend/actions/` calling revalidatePath
- [X] T030 [US1] Implement bounded negative-slug cache (LRU max 500, 30s TTL, cleared on form creation) behind GET `/api/public/form/:slug` in `backend/src/infrastructure/persistence/cache/negative-slug-cache.ts` and `backend/src/interfaces/http/controllers/public-form.controller.ts`

**Checkpoint**: US1 independently passes quickstart S1–S3.

---

## Phase 5: User Story 2 — Public Lead Capture With Duplicate Prevention (Priority: P1)

**Goal**: Anonymous visitors submit at /{slug}; every lead stored with IP; duplicates impossible under concurrency; uniform confirmation.

**Independent Test**: quickstart S4 (capture <2s, non-null IP, normalized email) and S6 (10 parallel same email → exactly 1 assignment ever).

### Tests for User Story 2

- [X] T031 [P] [US2] Domain unit tests for Email value object (trim/lowercase/≤255/RFC shape rejection cases) in `backend/tests/unit/domain/email.vo.test.ts`
- [X] T032 [P] [US2] Concurrency test firing 10 parallel submissions of one new email against real HTTP asserting exactly 1 sent + 9 duplicate in `backend/tests/concurrency/duplicate-race.test.ts`

### Implementation for User Story 2

- [X] T033 [US2] Implement Email value object (static create normalizing trim+lowercase, equals) with zero external imports in `backend/src/domain/value-objects/email.vo.ts`
- [X] T034 [US2] Implement CaptureLeadUseCase: Zod validate→422 nothing persisted, Email.normalize, persist Lead(status UNSENT, ipAddress NOT NULL) and Outbox LeadRoutingRequested with SAME traceId in ONE transaction, emit lead.captured metric+event in `backend/src/application/use-cases/capture-lead.use-case.ts`
- [X] T035 [US2] Implement the ONE edge Route Handler POST `/api/public/leads`: resolve client IP (leftmost x-forwarded-for → x-real-ip → cf-connecting-ip → socket, normalize ::1/::ffff:127.0.0.1), honeypot `website` must be empty, generate X-Trace-Id, forward X-Client-IP + X-Internal-Token + payload to backend, return IDENTICAL 202 body for all outcomes in `frontend/app/(public)/api/public/leads/route.ts`
- [X] T036 [US2] Verify rate-limit middleware binds ONLY to `/api/public/*` with PUBLIC_RATE_LIMIT_PER_MIN default 30 returning 429 + Retry-After (wire in existing chain from T012) in `backend/src/interfaces/http/middleware/rate-limit.ts`
- [X] T037 [US2] Build public intake page `frontend/app/(public)/[slug]/page.tsx` with force-static + revalidate=3600 fallback + generateStaticParams from the single form, and add revalidatePath calls for /[slug] in form Server Actions from T029

**Checkpoint**: US2 passes quickstart S4 + S6 independently.

---

## Phase 6: User Story 3 — Routing Integration (Priority: P1)

**Goal**: Captured leads routed by highest deficit honoring all gates; caps unbreakable under concurrency; decision traces prove every choice.

**Independent Test**: quickstart S5 (deficit arithmetic matches hand-computed values, exclusions name rules) and S7 (20-way race vs cap 2 → exactly ≤2).

### Tests for User Story 3

- [X] T038 [P] [US3] Concurrency test 20 parallel submissions against cap 5 asserting exactly 5 assignments and zero overage in `backend/tests/concurrency/cap-race.test.ts`

### Implementation for User Story 3

- [X] T039 [US3] Define application ports: LeadRepository, BrokerRepository, DistributionConfigRepository, DailyCounterRepository.tryIncrement(brokerId, localDate, cap), AssignedEmailRegistry.claim(email, brokerId, leadId), UnitOfWork in `backend/src/application/ports/`
- [X] T040 [US3] Implement RouteLeadUseCase: restore traceId → re-read lead ack unless UNSENT → registry.claim (collision ⇒ DUPLICATE ack) → load config via port → ONE groupBy live count in distribution timezone → selectBroker → tryIncrement false ⇒ drop broker retry ≤3 → mark SENT(AUTO, assignedAt) → ack; emits lead.routed/lead.unsent/broker.excluded events in `backend/src/application/use-cases/route-lead.use-case.ts`
- [X] T041 [US3] Implement Prisma port implementations: repositories, PrismaUnitOfWork, conditional counter UPDATE `WHERE (capAtTime=0 OR sentCount<capAtTime)` checking affectedRows, insert-only AssignedEmail claim in `backend/src/infrastructure/persistence/prisma/`
- [X] T042 [US3] Wire worker message handler to RouteLeadUseCase with failure→PENDING backoff and success→DONE, heartbeat increment, lead_capture_to_assign_ms histogram in `backend/src/interfaces/worker/handlers/route-lead.handler.ts`
- [X] T043 [US3] Implement version-gated CachedDistributionConfigRepository decorator (per-read ConfigVersion check, hit/miss counters, refreshed log event) selected by CONFIG_CACHE at container level in `backend/src/infrastructure/persistence/cache/cached-distribution-config.repository.ts`
- [X] T044 [P] [US3] (Tier 2 — cuttable) Implement POST /api/distribution/simulate dry-run selection: load candidates + live counts, run selectBroker, return result + trace with ZERO writes, in `backend/src/interfaces/http/controllers/distribution.controller.ts`

**Checkpoint**: US3 passes quickstart S5 + S7; full P1 slice (capture→route→assign ~1s) demonstrable end-to-end.

---

## Phase 7: User Story 4 — Lead Oversight & Manual Rescue (Priority: P2)

**Goal**: Filterable fast lists, audit views with traces, manual assign under full invariants, retry.

**Independent Test**: quickstart S8 (manual assign sets MANUAL+broker-local assignedAt; capped broker blocked; duplicate blocked) plus S12 round-trip counting.

### Tests for User Story 4

- [X] T045 [P] [US4] Integration tests for keyset pagination consistency at depth, all filters (status/brokerId/date/search), and decisionTrace absence from list payloads in `backend/tests/integration/leads-list.test.ts`

### Implementation for User Story 4

- [X] T046 [US4] Implement GET `/api/leads` keyset cursor ((createdAt,id) DESC, LIMIT n+1 hasMore) with explicit selects excluding decisionTrace and filters q/status/brokerId/from/to in `backend/src/interfaces/http/controllers/leads.controller.ts`
- [X] T047 [US4] Implement GET `/api/leads/:id` (full decisionTrace), POST `/api/leads/:id/assign` backed by ManuallyAssignLeadUseCase performing identical registry claim + conditional counter increment, marking MANUAL with broker-local assignedAt, and POST `/api/leads/:id/retry` re-enqueueing FAILED/UNSENT in `backend/src/application/use-cases/manually-assign-lead.use-case.ts` and `leads.controller.ts`
- [X] T048 [US4] Implement GetDashboardSummaryUseCase composing setup state, countByStatus, broker today-stats, heartbeat via Promise.all (single round-trip contract) in `backend/src/application/use-cases/get-dashboard-summary.use-case.ts` with route in `backend/src/interfaces/http/routes/dashboard.routes.ts`
- [X] T049 [US4] Implement composite reads GET `/api/brokers/:id/detail` (broker+todayStats+first lead page) and GET `/api/distribution/detail` (distribution+members+history+statusCounts) in `backend/src/interfaces/http/controllers/` reusing repositories
- [X] T050 [US4] Build admin views: dashboard (setup checklist incl. worker health, last 10 leads, unsent link), leads list (filter chips, keyset Load more), distribution/[id] audit table (expandable deficit maths, inline assign/retry on unsent), brokers/[id] seven-column table (name, email, phone, IP, form, date received, status) in `frontend/app/(admin)/`

**Checkpoint**: US4 passes quickstart S8; admin answers "why did this lead go here" without shell access.

---

## Phase 8: User Story 5 — Operational Health & Decision Transparency (Priority: P2)

**Goal**: In-product observability: readiness semantics, queue depth/dead letters + replay, latency stats, filterable structured-log tail.

**Independent Test**: quickstart S9 (restart survival + drain) and S11 (one grep by traceId returns full life across processes).

### Tests for User Story 5

- [X] T051 [P] [US5] Integration test stopping the worker: readiness flips 503 with reason, queued items accumulate as UNSENT then route in order on resume; DEAD-after-5-attempts path reachable and replay returns it to PENDING in `backend/tests/integration/readiness-and-outbox.test.ts`

### Implementation for User Story 5

- [X] T052 [US5] Implement ops endpoints GET `/api/ops/outbox` (depth by status, oldestPendingAgeMs, dead list with lastError) and POST `/api/ops/outbox/:id/replay` in `backend/src/interfaces/http/routes/ops.routes.ts`
- [X] T053 [US5] Implement GET `/api/ops/metrics` (admin-only registry snapshot incl. middleware_duration_ms percentiles, config_cache hits/misses, broker_exclusions_total by rule, lead_capture_to_assign_ms) in `backend/src/interfaces/http/routes/ops.routes.ts`
- [X] T054 [US5] Implement nightly maintenance inside worker: batched purge of Outbox DONE >7 days, batched purge of Leads older than 90 days NEVER touching AssignedEmail, emitting outbox.reaped events in `backend/src/interfaces/worker/purge-tasks.ts`
- [X] T055 [US5] Implement GET /api/ops/logs/tail (admin) returning last N structured JSON events filterable by level/event/traceId/n from configured log file paths, in `backend/src/interfaces/http/routes/ops.routes.ts` (contracts/api.md §Health & Ops)

**Checkpoint**: US5 passes quickstart S9 + S11.

---

## Phase 9: User Story 6 — Operations Console (Priority: P3)

**Goal**: Single auto-refreshing console visualizing already-produced operational data.

**Independent Test**: quickstart S10/S11 evidence visible at a glance: panels agree with `/api/ops/*` responses during live traffic.

### Implementation for User Story 6

- [X] T056 [P] [US6] Build `/ops` page (Tier 2): auto-refresh 10s panels for System (uptime, heartbeat age red >60s, version, DB/migration state), Queue (pending/processing/dead, oldest age, replay buttons), Routing (24h statuses, capture→assign p50/p95/p99, exclusions by rule) in `frontend/app/ops/page.tsx`
- [X] T057 [US6] Extend `/ops` with Brokers panel (live open/closed, sentToday/cap bars, next-open time computed from timezone/hours) and Recent errors panel (last 20 level≥error with traceId links to filtered log tail) in `frontend/app/ops/page.tsx`

**Checkpoint**: All six stories independently functional; console agrees with underlying records.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Gates, hardening, documentation, rehearsal

- [X] T058 [P] Implement cache-parity harness running the integration suite twice (CONFIG_CACHE=true/false) asserting identical outcomes in `backend/tests/integration/cache-parity.test.ts`
- [X] T059 [P] Implement budget assertions: round-trip counter test (≤2 backend calls per admin page render, dashboard exactly 1), middleware p95 <5ms over 200 requests reading /api/ops/metrics, capture p95 <120ms from http_request_duration_ms on POST /api/public/leads, and capture-to-assignment p95 <3s from lead_capture_to_assign_ms in `backend/tests/budgets/round-trips.test.ts` and `middleware-p95.test.ts`
- [X] T060 Security hardening sweep: helmet/CSP headers active, redact-path audit against sample payloads, request bodies never logged, gitleaks clean run documented in `backend/docs/security-checklist.md`
- [X] T061 [P] Write READMEs for BOTH repos covering clean-machine clone→env→migrate→seed→build→start/restart, reading JSON logs, tracing a lead by traceId, regenerating/syncing contract types, access URLs, review credentials pointer, architecture summary, quickstart checklist links (quickstart content source of truth)
- [X] T062 Execute full quickstart.md S1–S14 against the local PM2 stack; fix all failures found
- [ ] T063 Deployment rehearsal on target VPS: nvm Node 20, pm2 + pm2-logrotate (10MB ×14 gzip), clone/migrate/seed/build, `pm2 start ecosystem.config.js && pm2 save`, verify survives `pm2 restart all`, document VPS-specific values

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (1)** → **Foundational (2)**: scaffolding before infrastructure
- **Foundational (2)** BLOCKS all stories (schema, outbox, middleware, contracts pipeline)
- **US1 → US2**: capture needs the published form (T027/T037) and slug cache (T030)
- **Domain Ring (3) precedes all stories**: the routing brain (T018–T021) lands test-first before ANY HTTP work (constitution gate)
- **US2 → US3**: routing consumes messages produced by capture
- **US4** needs US1 (views/config) + US3 (traces/assignment states); **US5** needs Foundational only but lands best after US3 produces routing traffic; **US6** needs US5 endpoints
- **Polish (10)** last; T062 gates delivery

### Parallel Opportunities
- Setup: T002/T003/T004 alongside T001
- Foundational: T007–T010 fully parallel; T016/T017 parallel with backend infra
- Within stories: every [P] test task runs while sibling implementation files are being written elsewhere; T018–T021 (pure domain) parallelizable across the whole team
- Cross-story: after Foundational, one engineer can take US1→US2 while another starts US3 domain ring

```bash
# Example: Domain Ring burst in Phase 3 (all [P], zero shared files)
Task T018 "selectBroker suite in backend/tests/unit/domain/select-broker.test.ts"
Task T020 "value objects in backend/src/domain/value-objects/"
Task T021 "select-broker.ts in backend/src/domain/services/"
```

## Implementation Strategy

- **MVP First**: Phases 1–4 (Setup+Foundational+Domain Ring+US1) → validate with quickstart S1–S3. Configuration value ships alone.
- **Core Product Slice**: add US2+US3 → S4–S7 prove the commercial engine (this is the exam-critical Tier 0).
- **Incremental**: US4 (oversight) → US5 (operations trust) → US6 (console).
- **Cut policy (PRD §2.4)**: T043 (config cache), T030 partially, T056/T057 are Tier 2 — cut freely under pressure. T012 ordering, T034 atomicity, T038/T032 concurrency tests, T059 budgets are Tier 0 — NEVER cut.
- Map phases to the 3-day plan: Day 1 ≈ Phases 1–4 incl. Domain Ring (+T017 early), Day 2 ≈ Phases 5–6 (+concurrency tests), Day 3 ≈ Phases 7–10.

## Notes

- Commit after each task or logical group; incremental public history is a deliverable (SC in PRD).
- Verify tests FAIL before implementing (red-green enforced in story phases).
- Stop at any story checkpoint and validate independently via the referenced quickstart scenario numbers.

## Phase 11: Convergence

- [X] T064 Wire `http_request_duration_ms` histogram observation around every request in `buildApp` (start timestamp before middleware #1, observe in a finishing listener) so the T059 capture-p95 budget is measurable per plan D10 (partial)
- [X] T065 Increment `leads_captured_total` in the public-leads controller after a CAPTURED outcome completes (metric half of T034's "metric+event" currently missing) per FR-032/T034 (partial)
- [X] T066 Increment `broker_exclusions_total` with `{ rule }` labels at the route-lead handler boundary using the persisted trace's exclusion list so `/api/ops/metrics` and the US6 routing panel show exclusions by rule per T053/T057 (partial)
