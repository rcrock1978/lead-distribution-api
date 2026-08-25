# Product Requirements Document
## Lead Distribution Platform

| Field | Value |
|---|---|
| Document version | **5.0** (supersedes 4.0, 3.1, 3.0, 2.0, 1.0) |
| Status | Draft for build |
| Author | Senior Full Stack Developer |
| Build window | 3 days |
| Deliverable | Two public GitHub repos (frontend + backend) + live VPS deployment |
| Stack | Next.js, Express, Prisma, MySQL, PM2, TypeScript. **No additional infrastructure.** |

### Version history

| Version | Change |
|---|---|
| 1.0 | Initial specification |
| 2.0 | Hardened concurrency; DB-level invariants; two-phase capture; per-timezone day boundaries |
| 3.0 | Clean Architecture; transactional outbox messaging; structured JSON logging; observability build |
| 4.0 | Caching strategy merged in as §12; performance budgets |
| **5.0** | **BFF data aggregation + round-trip budget; middleware cost budget and ordering; shared API contract types; three documented rejections** |

### Changelog from 4.0

| # | Change | Reason |
|---|---|---|
| F1 | §9.2 — composite endpoints and parallel fetching; **≤2 backend round trips per admin page** | v4 budgeted page TTFB but never bounded backend calls. Five sequential `await`s in a Server Component is a server-side waterfall, invisible because it never reaches the browser |
| F2 | §9.3 — shared API contract types generated from backend Zod schemas, drift-checked in CI | A schema change could silently break the frontend at runtime. The monorepo answer is precluded by the two-repo deliverable |
| F3 | §17.4 — middleware cost budget and explicit ordering; auth performs **no database lookup** | v4 listed middleware but never bounded its per-request cost or specified whether auth hit the DB |
| F4 | §11.1 — new budget row for backend round trips per page | Makes F1 measurable |
| F5 | §5.7 — Express statefulness stated explicitly | The API is not stateless (config cache, metrics registry). That is fine at `instances: 1` and must be written down before someone scales it |
| F6 | §12.4.2 — expanded rationale for rejecting the Next Data Cache on admin routes | The recommendation is correct for public high-traffic content and wrong here; the distinction deserves to be recorded |
| F7 | §19.4 — test cases 22–23 (round-trip count, contract drift) | F1 and F2 are otherwise unverifiable |
| F8 | §21 — two risk rows | Contract drift and middleware creep |

---

## 1. Purpose and Principles

### 1.1 Problem
One public form produces a continuous stream of leads. Each must be handed to a broker according to a commercial percentage agreement, respecting that broker's timezone, opening hours, working days, and daily capacity. Manual routing does not scale, distributes unevenly, and risks selling the same person twice.

### 1.2 Architectural principles

These six govern every decision below. Where they conflict, the earlier one wins.

**P1 — Invariants belong to the database.** Anything on the automatic-fail list is enforced by a constraint or an atomic write, never by a read-then-check in application code. Service guards produce friendly errors; constraints make the invariant true regardless of races, direct API calls, or bugs.

**P2 — The domain does not know it is on a server.** Business rules are pure functions over plain types. No Prisma, no Express, no ambient clock, no logger. Testable in milliseconds without a database.

**P3 — Capture and routing are separate concerns with separate failure modes.** A lead being recorded must never depend on a broker being selectable. Decoupled by a durable message, not a try/catch.

**P4 — Every process emits machine-readable events.** One JSON line per meaningful occurrence, correlated end to end. A system that cannot be inspected on a VPS with no APM cannot be debugged at 2am.

**P5 — Nothing that participates in an invariant is ever cached.** Correctness outranks latency everywhere here. Where the two conflict, the cache is removed, not the check.

**P6 — Every layer boundary has a cost budget.** Decoupling is only free if the seams are measured. Backend round trips per page, middleware overhead per request, and query count per route each have a stated ceiling and a test that asserts it.

---

## 2. Scope

### 2.1 In scope
Admin auth; dashboard; broker CRUD; one lead form; one distribution auto-bound to it; per-broker percentage and active flag; public unauthenticated form at `/{slug}`; the routing domain; duplicate blocking; leads list; distribution detail; broker leads view; manual assignment; MySQL persistence via Prisma; outbox worker; ops dashboard; VPS deployment under PM2 without sudo.

### 2.2 Out of scope
Broker logins. Outbound webhooks. Multiple forms or distributions. Form builders. Notifications. Exports and charting. Multi-tenancy or role hierarchies. External APM, Prometheus, Grafana, alerting, Redis, CDN, or a monorepo build system — see §2.5 for the last three.

### 2.3 Cardinality
| Entity | Cardinality | Enforcement |
|---|---|---|
| Form | 0 or 1 | Unique index |
| Distribution | 0 or 1 | Unique index |
| Brokers | 0..N | — |
| Assigned email | 0 or 1 broker, permanently | Unique primary key |

### 2.4 Scope tiering and honest effort assessment

Built in full this is roughly four to five days of work, not three. The cut order is fixed now rather than discovered on the final evening.

| Tier | Contents | Rule |
|---|---|---|
| **Tier 0 — must ship** | Everything on the automatic-fail list: auth, singletons, duplicate prevention, IP capture, timezone/hours/cap gating, deployment, README. The pure domain layer and its unit tests. The three 20-minute cache-correctness items (§12.8). Middleware ordering (§17.4). | Never cut. |
| **Tier 1 — should ship** | Outbox + worker, structured logging with correlation, health and readiness endpoints, keyset pagination, decision traces, public-form static generation, timezone memoization, composite endpoints (§9.2), API contract types (§9.3). | Cut only if Tier 0 is at risk. If the outbox is cut, routing reverts to the v2.0 inline two-phase flow with an advisory lock — a documented fallback, not a scramble. |
| **Tier 2 — cuttable** | `/ops` dashboard UI, log-tail endpoint, latency histograms, simulate panel, trace expansion, version-gated config cache, negative slug cache, cache metrics panel. | Cut freely. The underlying data still exists and is reachable via API. |

Tier 2 is presentation over data Tier 1 already produces, so cutting it costs visibility, never correctness. Tier 1's outbox has a pre-built fallback. Tier 0 has none, which is the point.

### 2.5 Three recommendations deliberately rejected

Standard Next.js + Express guidance recommends these. Each is correct for the workload it assumes and wrong for this one. Recorded so the omissions read as decisions.

| Recommendation | Why rejected here |
|---|---|
| **Next.js Data Cache on API responses** (`{ next: { revalidate: 60 } }`) | The usual justification is "1,000 users in a minute produce one origin hit." That assumes public, read-heavy, shared content. This app has **one authenticated admin** viewing **PII that must be current**. Caching admin data produces a visible bug (§12.4.3) and a privacy exposure (§12.3). Applied where it *does* fit — the one public page — v5 goes further than the recommendation: full static generation with on-demand revalidation, which is strictly stronger than a 60-second TTL. |
| **Redis cache in Express** | No sudo on the VPS; no external services. The version-gated in-process cache (§12.2.2) delivers cross-process invalidation with zero staleness and no infrastructure. See §12.7. |
| **Monorepo (Turborepo / Nx) for shared types** | This is the correct answer to the problem and it is precluded: the deliverable requires **two separate public GitHub repositories**. §9.3 captures the type-safety benefit — the actual goal — without the tooling. |

---

## 3. Users

**Admin** — onboards brokers, publishes the form, sets shares, monitors outcomes, rescues unsent leads. Needs to know *why* each lead went where it went.

**Visitor** — anonymous, fills the public form. Needs speed, clear validation, a confirmation. Must never learn broker names, routing outcomes, or whether their email was seen before.

**Reviewer** — runs §19 against the live deployment. Needs a README that works first time on a clean machine.

---

## 4. Success Criteria

| # | Criterion |
|---|---|
| S1 | Public repos, incremental commit history |
| S2 | Reachable on the assigned public port; survives `pm2 restart all` |
| S3 | Admin area unreachable without a session; public form reachable without one |
| S4 | Second form impossible via UI **and** direct API |
| S5 | Second distribution impossible via UI **and** direct API |
| S6 | Distribution before form → `Oops, please create a form first.` |
| S7 | Repeat email → `duplicate`, no broker, **under concurrency** |
| S8 | Every lead stores and displays an IP |
| S9 | Inactive, closed, out-of-days, capped brokers never selected |
| S10 | Selection matches the deficit formula; the stored trace proves it |
| S11 | Daily cap never exceeded, **under concurrency** |
| S12 | No real secret in either repository's history |
| S13 | Every request and every routing decision emits a correlated JSON log line |
| S14 | Outbox depth, worker heartbeat, and routing latency observable without SSH |
| S15 | No authenticated response is storable by the browser cache; no admin view serves stale data after a mutation |
| S16 | **(new)** No admin page issues more than 2 backend round trips; the frontend fails to compile against a drifted API contract |

---

## 5. Clean Architecture

### 5.1 The dependency rule

Dependencies point inward only. Nothing in an inner ring may import from an outer ring.

```
┌───────────────────────────────────────────────────────────┐
│  INTERFACE            Express controllers, DTOs, mappers, │
│                       route wiring, worker entrypoint      │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  INFRASTRUCTURE   Prisma repos, outbox publisher,   │  │
│  │                   Luxon clock, pino logger, caches,  │  │
│  │                   metrics registry, bcrypt, JWT      │  │
│  │  ┌───────────────────────────────────────────────┐  │  │
│  │  │  APPLICATION   Use cases + PORTS (interfaces)  │  │  │
│  │  │  ┌─────────────────────────────────────────┐  │  │  │
│  │  │  │  DOMAIN                                  │  │  │  │
│  │  │  │  Entities, value objects, domain         │  │  │  │
│  │  │  │  services, domain errors.                │  │  │  │
│  │  │  │  ZERO imports outside this ring.         │  │  │  │
│  │  │  └─────────────────────────────────────────┘  │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

Enforced mechanically by `eslint-plugin-boundaries`, which fails the build on an upward import. A rule nobody can violate accidentally is worth more than a rule everybody agrees with.

Caching lives in **infrastructure**, wrapping a port implementation (§12.2.2). The domain and application rings have no idea a cache exists, which is what makes `CONFIG_CACHE=false` a safe one-line disable.

### 5.2 Domain ring

Pure TypeScript. No `import` outside `src/domain`. No `Date.now()`, no `process.env`, no I/O.

```ts
// domain/value-objects/
class Email        { private constructor(readonly value: string)
                     static create(raw: string): Result<Email>      // trims, lowercases, validates
                     equals(other: Email): boolean }
class TimeWindow   { constructor(open: string, close: string)
                     containsMinute(m: number): boolean             // handles overnight windows
                     get isOvernight(): boolean }
class Percentage   { private constructor(readonly value: number)    // Decimal-safe, 0–100
                     targetFor(total: number): number }
class WorkingDays  { constructor(days: number[])                    // ISO 1..7
                     includes(isoWeekday: number): boolean }

// domain/entities/
class Broker  { canReceiveAt(localNow, sentToday): Eligibility }     // Eligible | Ineligible(reason)
class Lead    { markSent(brokerId, trace) / markDuplicate() / markUnsent(reason) }

// domain/services/
function selectBroker(
  candidates: BrokerCandidate[],
  totalSentToday: number,
  now: ZonedInstant,          // value object, injected — never ambient
): SelectionResult            // Selected(brokerId, trace) | NoEligibleBroker(reason, trace)
```

`selectBroker` is the commercial heart of the product and is a pure function of three arguments. It runs in microseconds, needs no fixtures, and its entire test suite executes without MySQL. That is the concrete return on the layering, and why P2 is a principle rather than a preference.

### 5.3 Application ring — use cases and ports

Each use case is one class with one public `execute`. Ports are interfaces owned by this ring; infrastructure implements them.

```ts
// application/ports/
interface LeadRepository              { create(lead); findById(id); updateStatus(…); … }
interface BrokerRepository            { findCandidatesForDistribution(distId); … }
interface DistributionConfigRepository{ load(): Promise<DistributionConfig>; }   // cached in infra
interface DailyCounterRepository      { tryIncrement(brokerId, localDate, cap): Promise<boolean>; }
interface AssignedEmailRegistry       { claim(email, brokerId, leadId): Promise<boolean>; }
interface OutboxPublisher             { publish(msg: OutboxMessage, tx?): Promise<void>; }
interface UnitOfWork                  { run<T>(fn: (ctx) => Promise<T>): Promise<T>; }
interface Clock                       { now(): Instant; nowIn(tz: string): ZonedInstant; }
interface Logger                      { child(bindings): Logger; info/warn/error(event, fields): void; }
interface Metrics                     { counter(name, labels?); histogram(name, ms, labels?); gauge(…); }

// application/use-cases/
CaptureLeadUseCase        // validate → persist → publish. Never routes.
RouteLeadUseCase          // consumed from outbox: claim email → candidates → select → increment → mark sent
ManuallyAssignLeadUseCase // same invariants, admin-initiated
GetDashboardSummaryUseCase// composite read for §9.2
CreateFormUseCase / CreateDistributionUseCase  // singleton guards
```

`RouteLeadUseCase` depends on interfaces and the pure domain service. Its unit tests use in-memory fakes for every port and assert real routing behaviour — cap exhaustion, duplicate collision — with no database. Integration tests then verify the *Prisma implementations* honour the same contracts.

### 5.4 Where Clean Architecture is deliberately not applied

Broker, form, and distribution CRUD do not get entities, mappers, repository interfaces, and use case classes. They get a controller, a Zod schema, and a service calling Prisma directly.

Those operations have no business rules beyond validation and a uniqueness guard. Wrapping a six-field insert in four layers produces five files and one indirection per field, buys no testability the integration test doesn't already provide, and consumes hours Tier 0 needs. Clean Architecture isolates *complex domain logic from volatile infrastructure*; where there is no complex domain logic, applying it is cargo cult.

The boundary: **anything touching lead routing is fully layered; everything else is a thin service.**

### 5.5 Composition root

```ts
// infrastructure/container.ts
export function buildContainer(env: Env) {
  const logger  = createLogger(env);
  const metrics = createMetricsRegistry();
  const clock   = new LuxonClock();                    // memoizes zones internally (§12.2.3)
  const prisma  = createPrismaClient(env);

  const leadRepo   = new PrismaLeadRepository(prisma);
  const brokerRepo = new PrismaBrokerRepository(prisma);
  const counters   = new PrismaDailyCounterRepository(prisma);
  const emails     = new PrismaAssignedEmailRegistry(prisma);
  const outbox     = new MySqlOutboxPublisher(prisma);
  const uow        = new PrismaUnitOfWork(prisma);

  // Cache is a decorator in infrastructure — the rings inside never see it.
  const configRepo = env.CONFIG_CACHE
    ? new CachedDistributionConfigRepository(new PrismaDistributionConfigRepository(prisma), prisma, logger, metrics)
    : new PrismaDistributionConfigRepository(prisma);

  return {
    captureLead: new CaptureLeadUseCase(leadRepo, outbox, clock, logger, metrics),
    routeLead:   new RouteLeadUseCase(leadRepo, brokerRepo, configRepo, counters, emails, uow, clock, logger, metrics),
    // …
  };
}
```

No DI framework — a container this size is fifty lines of explicit construction and far easier to follow than decorator magic. The API process and the worker each call `buildContainer` and use the subset they need.

### 5.6 Folder structure

```
backend/src/
  domain/        entities/ value-objects/ services/ errors/    # zero external imports
  application/   ports/ use-cases/ dto/
  infrastructure/
    persistence/prisma/{client,repositories,unit-of-work}
    persistence/cache/{cached-distribution-config,negative-slug-cache}
    messaging/{outbox-publisher,outbox-consumer,message-schemas}
    observability/{logger,metrics,correlation}
    time/luxon-clock.ts   security/{bcrypt,jwt}
    container.ts
  interfaces/    http/{controllers,routes,middleware,schemas,mappers}  worker/{entrypoint,handlers}
  contracts/     index.ts                                       # ← §9.3, the published API surface
  main-api.ts  main-worker.ts  config/env.ts
tests/  unit/domain/  unit/application/  integration/  concurrency/
```

### 5.7 The API is stateful — stated deliberately

Standard guidance describes the Express layer as a stateless API. This one is not, and pretending otherwise would hide a real scaling constraint:

| State | Scope | Consequence |
|---|---|---|
| Config cache (§12.2.2) | Per process | Safe at any instance count — the version gate revalidates per read |
| Negative slug cache | Per process | Safe — 30s TTL, worst case is a redundant query |
| Metrics registry (§14.2) | Per process | **Not** safe at >1 instance: each would report only its own slice |
| Outbox consumer | Single worker | `instances: 1` is load-bearing (§6.2) |

At `instances: 1` per process — the deployed topology — none of this matters. It is recorded because "just bump `instances`" is the obvious first move under load, and two of these four rows would break quietly. Anyone scaling this must first move the metrics registry to a shared store and re-read §6.2 before touching the worker.

---

## 6. Messaging: Transactional Outbox

### 6.1 Why messaging, and why this form

Capture and routing have genuinely different requirements. Capture must be fast, must always succeed, and is owned by the visitor's request. Routing is slower, can legitimately fail, benefits from retries, and nobody is waiting on it. Coupling them synchronously means a routing failure surfaces as a visitor-facing problem, and a transient failure is lost.

**Rejected: Redis/BullMQ, RabbitMQ, SQS.** Correct at scale, unavailable here.
**Rejected: in-process `EventEmitter`.** Decouples the code but not the failure mode — a crash between emit and handle loses the message with no record it existed.
**Chosen: transactional outbox in MySQL, consumed by a single worker under PM2.** The message is written *in the same transaction* as the lead, so the lead and its routing intent commit or fail together — the dual-write problem disappears. At-least-once delivery, retries and backoff as table rows, dead-lettering as a status value, and a queue inspectable with a `SELECT`.

### 6.2 The unexpected benefit: locking disappears

v2.0 serialized assignment with a MySQL advisory lock because concurrent submissions could race on caps. A **single worker consuming a queue processes messages one at a time by construction** — assignment is serialized because there is exactly one thing doing it.

The advisory lock is therefore removed from the automatic path. The database-level invariants in §10 remain — they now defend the manual-assignment path and guard against the worker ever being scaled to two instances, rather than carrying the whole load.

Adding a messaging pattern removed a lock rather than adding a broker. That is usually the sign the pattern fits.

### 6.3 Message schema

```ts
type OutboxMessage = {
  id: string;              // UUID, the idempotency key
  type: 'LeadCaptured' | 'LeadRoutingRequested';
  aggregateType: 'Lead';
  aggregateId: string;
  payload: { leadId: number; formId: number; email: string };
  traceId: string;         // ← correlation, carried from the visitor's HTTP request
  occurredAt: string;      // ISO 8601
};
```

`traceId` is load-bearing for §13: it originates in the browser request, is written onto the outbox row, is restored by the worker into its logging context, and ties `lead.captured` in the API process to `lead.routed` in the worker minutes later, in one grep.

### 6.4 Claim protocol

```sql
-- Claim a batch. SKIP LOCKED means concurrent workers never collide,
-- so the design stays correct if a second instance is ever added.
SELECT id FROM Outbox
 WHERE status = 'PENDING' AND availableAt <= NOW()
 ORDER BY availableAt ASC
 LIMIT 10
 FOR UPDATE SKIP LOCKED;

UPDATE Outbox SET status='PROCESSING', claimedAt=NOW(), attempts=attempts+1 WHERE id IN (...);

-- success  : status='DONE', processedAt=NOW()
-- failure  : status='PENDING', availableAt=NOW()+backoff, lastError=<message>
-- attempts >= 5 : status='DEAD', surfaced on /ops
```

Poll interval 500ms when empty, immediate re-poll while draining. Backoff exponential with jitter: 1s, 4s, 16s, 64s, 256s. A stale-claim reaper returns `PROCESSING` rows older than 5 minutes to `PENDING`, so a worker crash mid-message self-heals rather than stranding the lead.

### 6.5 Idempotency

At-least-once delivery means a handler can run twice — the reaper alone guarantees it eventually will. `RouteLeadUseCase` is idempotent by three independent mechanisms, any one sufficient:

1. It re-reads the lead and returns immediately unless `status = UNSENT`.
2. `AssignedEmail.claim()` is a unique-key insert; the second attempt collides.
3. The counter increment is conditional; a redelivery cannot double-count against a cap.

### 6.6 Failure and degraded modes

| Failure | Behaviour |
|---|---|
| Worker crashes | PM2 restarts it; `PROCESSING` rows reaped to `PENDING`; nothing lost |
| Worker down for minutes | Leads accumulate as `UNSENT`; outbox depth and heartbeat age alarm on `/ops`; they route on recovery in order |
| Worker permanently dead | `INLINE_WORKER=true` on the API process consumes the same outbox in-process — degraded, documented, one env var |
| Message fails 5× | `DEAD`, listed on `/ops` with `lastError`, replayable by one button |
| MySQL down | Capture fails at the HTTP boundary; the visitor gets a real error rather than a false confirmation |

---

## 7. Data Model

### 7.1 Tables

```prisma
model Outbox {
  id            String       @id @db.Char(36)
  type          String       @db.VarChar(64)
  aggregateType String       @db.VarChar(32)
  aggregateId   String       @db.VarChar(64)
  payload       Json
  traceId       String       @db.Char(32)
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  availableAt   DateTime     @default(now())
  claimedAt     DateTime?
  processedAt   DateTime?
  lastError     String?      @db.Text
  createdAt     DateTime     @default(now())

  @@index([status, availableAt])          // the claim query's covering index
  @@index([aggregateType, aggregateId])
  @@index([traceId])
}
enum OutboxStatus { PENDING PROCESSING DONE DEAD }

model WorkerHeartbeat {
  workerId       String   @id @db.VarChar(64)
  lastBeatAt     DateTime
  processedTotal Int      @default(0)
  version        String   @db.VarChar(32)
}

model ConfigVersion {
  id        Int      @id @default(1)      // exactly one row
  version   Int      @default(1)
  updatedAt DateTime @updatedAt
}
```

Retained from earlier versions: `User`; `Form` and `Distribution` (each with `singleton Boolean @unique`); `Broker`; `DistributionBroker`; `BrokerDailyCounter` (`@@unique([brokerId, localDate])`); `AssignedEmail` (email as primary key); `Lead` (with `ipAddress`, `decisionTrace`, `failureReason`, `assignedAt`, `assignmentType`, `traceId`).

### 7.2 Retention

`Outbox` rows with `status = DONE` older than 7 days are deleted by a nightly task inside the worker; otherwise the table grows unbounded and the claim index degrades. `DEAD` rows are never auto-deleted — they are the ones a human needs.

---

## 8. Routing Workflow

```
POST /api/public/leads
        │
  ┌─── CAPTURE — one transaction, in the API process ──────────┐
  │ 1. Zod validate → 422, nothing persisted                    │
  │ 2. Email.create() normalizes: trim + lowercase              │
  │ 3. Capture IP (§8.2), user agent, traceId                   │
  │ 4. INSERT Lead   { status: UNSENT, reason: 'queued' }       │
  │ 5. INSERT Outbox { type: 'LeadRoutingRequested', traceId }  │◄── same tx: no dual-write
  │ 6. COMMIT                                                    │
  └─────────────────────────────────────────────────────────────┘
        │
        ▼ 202 to the visitor.  p95 target < 120ms.
        ▼ Routing latency is entirely off the visitor's path.

  ┌─── ROUTE — worker process, one message at a time ──────────┐
  │ 7. Claim message; restore traceId into the logger context   │
  │ 8. Re-read lead; not UNSENT? → ack, done (idempotency)      │
  │ 9. AssignedEmail.claim(email)                               │
  │      collision → DUPLICATE, no broker, ack                  │
  │10. Load distribution config (cached, §12.2.2)               │
  │11. Load live counts: ONE groupBy query, never cached        │
  │12. domain.selectBroker(candidates, totalSentToday, now)     │
  │      NoEligibleBroker → release claim, UNSENT + trace, ack  │
  │13. counters.tryIncrement(brokerId, localDate, cap)          │
  │      false → drop broker, retry from 12 (max 3)             │
  │14. UPDATE Lead: SENT, brokerId, assignedAt, AUTO, trace     │
  │15. COMMIT; mark message DONE; emit lead.routed log + metric │
  │     any throw → message back to PENDING with backoff        │
  └─────────────────────────────────────────────────────────────┘
```

Step 10 reads cached configuration; step 11 reads live counters. That split is the whole caching argument in miniature — near-static commercial config is cached, and the numbers that enforce caps never are.

### 8.1 Deficit selection

`totalSentToday` counts leads assigned today across **all** distribution brokers, where "today" is the calendar day in **`Distribution.timezone`**. Per-broker caps use each **broker's own** timezone. The share is one commercial agreement over one pool and needs one shared denominator; a cap is a property of one broker's working day.

```
targetAfterLead = (totalSentToday + 1) × brokerPercentage / 100
deficit         = targetAfterLead − brokerSentToday
```

| Broker | % | Sent today | Target after next | Deficit | Result |
|---|---|---|---|---|---|
| A | 50 | 4 | 5.50 | **+1.50** | Receives next lead |
| B | 30 | 3 | 3.30 | +0.30 | Behind, lower deficit |
| C | 20 | 3 | 2.20 | −0.80 | Above target |

Highest deficit wins. Negative deficit does not disqualify — if all eligible brokers are ahead of target, the least-over one still receives it. Ties: fewer sent today, then lower broker ID.

Eligibility requires all of: broker active; linked to the distribution; active within it; percentage > 0; today in `workingDays` (broker-local); current broker-local time within `[open, close)`; under cap. Each exclusion is recorded in `decisionTrace` with the rule that fired.

### 8.2 IP capture

Captured in the one Next.js Route Handler at the true network edge — `x-forwarded-for` leftmost, then `x-real-ip`/`cf-connecting-ip`, then `req.ip`, normalizing `::1` and `::ffff:127.0.0.1` to `127.0.0.1`, never null. Forwarded to the backend as `X-Client-IP`, accepted only on requests bearing the internal service token. Stored on **every** lead regardless of status and displayed on Leads, Distribution Detail, and Broker Leads views.

### 8.3 Duplicate semantics

Duplicate means the email has previously been *assigned to a broker* — authority is the `AssignedEmail` primary key, not a query. A repeat of an email whose earlier submission is still unsent gets a fresh attempt, because an unsold lead is still sellable. Manual assignment performs the same claim and is rejected identically.

---

## 9. Frontend Architecture and the BFF Seam

### 9.1 Shape

Server Components and Server Actions call the backend server-side over loopback; the browser never learns the backend exists. One Route Handler survives — `/api/public/leads` — because IP capture must happen at the edge and the endpoint must work without a React runtime.

Standard BFF guidance suggests Route Handlers as the aggregation layer. Server Components and Server Actions fill the identical architectural role — server-side execution, credentials never reaching the client, response shaping before the browser — with roughly a dozen fewer files and no hand-written proxy per endpoint. The BFF *seam* is what matters; the mechanism is an implementation detail, and this one is cheaper.

`JWT_SECRET` lives only in the backend, which is the sole verifier. Next middleware checks cookie *presence* to redirect to `/login` — a UX affordance explicitly documented as not a security control. A forged cookie passes middleware and is rejected by Express with 401.

The frontend emits JSON logs to stdout using the same schema as the backend, sharing the `traceId` it generated, so a single trace spans both processes.

### 9.2 Data aggregation and the round-trip budget

**The problem this solves.** A Server Component that awaits five endpoints in sequence produces a five-hop waterfall on the *server*. It never appears in the browser's network tab, so it is invisible to the usual debugging reflex — it shows up only as a page that feels slow for no visible reason. The admin dashboard is the natural offender: form status, distribution status, broker count, lead counts by status, and worker health are five separate concerns.

**Budget: no admin page issues more than 2 backend round trips.** Met two ways, in this order of preference:

**1. Composite endpoints, where the data belongs together.** One backend call, one set of parallel queries, one response shaped for exactly what the page renders:

```ts
// GET /api/dashboard/summary  → one round trip, one use case
class GetDashboardSummaryUseCase {
  async execute(): Promise<DashboardSummary> {
    const [setup, leadCounts, brokerStats, worker] = await Promise.all([
      this.formRepo.getSetupState(),          // form + distribution existence
      this.leadRepo.countByStatus(),          // single GROUP BY
      this.brokerRepo.getTodayStats(),        // single join to counters
      this.workerRepo.getHeartbeat(),
    ]);
    return { setup, leadCounts, brokerStats, worker };
  }
}
```

Composite read endpoints, each backed by one use case:

| Endpoint | Replaces | Round trips |
|---|---|---|
| `GET /api/dashboard/summary` | 5 calls | 1 |
| `GET /api/brokers/:id/detail` | broker + leads + today's stats | 1 |
| `GET /api/distribution/detail` | distribution + brokers + lead history | 1 |
| `GET /api/leads` | already single | 1 |

**2. `Promise.all` where the data genuinely is unrelated.** Two independent concerns on one page fetch concurrently, never sequentially. Two parallel calls cost one round trip of latency; two sequential calls cost two.

```ts
// ✗ sequential — two round trips of latency
const brokers = await getBrokers();
const form    = await getForm();

// ✓ concurrent — one round trip of latency
const [brokers, form] = await Promise.all([getBrokers(), getForm()]);
```

**Aggregation lives in the backend, not the BFF.** The composite endpoint is a use case in the application ring — it reuses repositories and is unit-testable. Assembling the same object in a Server Component would place business composition in the presentation layer, violating §5.1, and would still cost the round trips it was meant to avoid.

**Payload shaping.** Composite endpoints return exactly what the page renders. `decisionTrace` (1–2KB per lead) is excluded from every list response and loads only on detail (§11.2). The BFF seam's job is to make the response smaller, not merely to forward it.

### 9.3 Shared API contract types

**The problem.** Backend and frontend are separate repositories with separate `node_modules`. A change to a response shape — renaming `sentToday`, making `assignedAt` nullable — breaks the frontend at runtime with no compile-time warning. Across a 3-day build with rapid schema churn, that is a real source of lost time.

**The standard answer is a monorepo, and it is unavailable.** Turborepo or Nx with a shared `packages/types` is correct, and the deliverable requires two separate public GitHub repositories. So the *goal* — compile-time breakage on contract drift — is met without the tooling.

**Mechanism.** The backend already defines every request and response shape as a Zod schema for validation. Those schemas are the single source of truth; the types are derived, never hand-written:

```ts
// backend/src/contracts/index.ts — the published API surface
import { z } from 'zod';

export const BrokerResponseSchema = z.object({
  id: z.number(), name: z.string(), isActive: z.boolean(),
  dailyCap: z.number(), timezone: z.string(),
  openingTime: z.string(), closingTime: z.string(),
  workingDays: z.array(z.number()),
  sentToday: z.number(), isOpenNow: z.boolean(), isCapped: z.boolean(),
});
export type BrokerResponse = z.infer<typeof BrokerResponseSchema>;
// … one per endpoint
```

```bash
npm run contracts:build     # tsc --emitDeclarationOnly → dist/api-contract.d.ts
npm run contracts:sync      # copies it into ../lead-distribution-web/src/types/
```

The frontend commits the generated file and imports from it. A backend shape change that isn't synced fails `tsc` on the frontend rather than surfacing as `undefined` in production.

**Drift detection.** A CI step (and a pre-push hook) hashes the generated contract and compares it to the committed copy in the frontend repo, failing on mismatch. Without that check the sync step is a manual ritual that gets skipped exactly when things are moving fastest.

**Honest limitations.** This is not a monorepo. Sync is a command someone has to run, drift is caught after the fact rather than prevented, and the contract file is duplicated across two repos. It costs about 20 minutes and delivers the substantive benefit — a schema change breaks the build instead of production. If the two-repo constraint were lifted, a workspace package is strictly better and this section should be deleted.

---

## 10. Concurrency and Correctness

With a single-threaded consumer, the automatic path is serialized by construction. These constraints remain because they defend the manual path, survive a future second worker, and hold regardless of application bugs.

| Invariant | Mechanism | Holds if app logic is wrong? |
|---|---|---|
| One form | `singleton Boolean @unique` | Yes |
| One distribution | `singleton Boolean @unique` | Yes |
| One email → one broker | `AssignedEmail` primary key; collision *is* the detection | Yes |
| Cap never exceeded | `UPDATE … WHERE cap=0 OR sentCount<cap` under the row lock; `affectedRows` is the answer | Yes |
| No dual-write between lead and message | Both inserted in one transaction | Yes |
| Concurrent workers never share a message | `FOR UPDATE SKIP LOCKED` | Yes |

```sql
UPDATE BrokerDailyCounter
   SET sentCount = sentCount + 1
 WHERE brokerId = ? AND localDate = ?
   AND (capAtTime = 0 OR sentCount < capAtTime);
```

`affectedRows = 0` means the slot was taken between selection and increment; that broker is dropped and selection re-runs, bounded to three attempts. The cap cannot be exceeded by any interleaving — a property of the predicate, not of sequencing.

**None of the values in this table is ever read through a cache.** See §12.1.1.

---

## 11. Performance

### 11.1 Budgets

Measured on the VPS, asserted in the smoke test.

| Path | p50 | p95 | Note |
|---|---|---|---|
| `POST /api/public/leads` (capture only) | < 60ms | < 120ms | Two inserts, one transaction |
| Routing latency (capture → assigned) | < 1s | < 3s | Poll interval dominates; not visitor-facing |
| `GET /api/leads` (50 rows, filtered) | < 80ms | < 200ms | Keyset pagination, pruned columns |
| `GET /api/dashboard/summary` | < 70ms | < 180ms | Four parallel queries, one response |
| Public form page TTFB | < 50ms | < 120ms | Statically generated (§12.4.1) |
| Admin page TTFB | < 300ms | < 700ms | Server components, no client waterfall |
| **Backend round trips per admin page** | **1** | **2** | **Hard ceiling (§9.2), asserted in test 22** |
| **Middleware overhead per request** | **< 2ms** | **< 5ms** | **Excludes handler work (§17.4)** |

### 11.2 Query design

**No N+1 on the routing path.** Candidate loading is one query joining `DistributionBroker`, `Broker`, and `BrokerDailyCounter`. v1.0 issued one `COUNT` per broker; the counter table removed the count entirely, turning an O(N) hot path into O(1) rows read.

**Keyset pagination, not `OFFSET`.** `OFFSET 10000` makes MySQL walk ten thousand rows to discard them.

```sql
SELECT … FROM Lead
 WHERE (createdAt, id) < (?, ?)      -- cursor from the last row of the previous page
   AND status = ?
 ORDER BY createdAt DESC, id DESC
 LIMIT 51;                            -- 51 to compute hasMore without COUNT(*)
```

**Column pruning.** `decisionTrace` is 1–2KB of JSON per lead and never needed in a list. Every list query uses an explicit Prisma `select`; the trace loads only on the detail endpoint. Fifty leads × 2KB is 100KB of pointless payload per page view otherwise.

**Covering indexes** for the hot access patterns: `[status, createdAt]` for the leads list, `[brokerId, assignedAt]` for broker views and cap counting, `[status, availableAt]` for the outbox claim.

### 11.3 Connections and process budget

Three Node processes share one MySQL instance the reviewer may also be using. Pools sized explicitly rather than left at Prisma's default: API `connection_limit=8`, worker `connection_limit=4`. Both well inside a default `max_connections=151`, with headroom for the reviewer's own client.

`max_memory_restart`: API 300M, worker 200M, web 400M.

### 11.4 Frontend performance (non-cache)

Caching is §12.4. What remains: Server Components render tables server-side — no client fetch waterfall, no data-fetching library in the bundle. Server Actions revalidate precise paths after mutations rather than triggering a full refetch. Tailwind purges to a few KB. Gzip via `compression` on Express; Next handles its own. No SWR or React Query — the admin surface is server-rendered, and a client cache would duplicate the server's work while creating a second invalidation problem.

---

## 12. Caching Strategy

### 12.1 Position

Caching is a small set of targeted decisions, not a layer. This application's hot path is a **write**. Its read traffic is a single admin using a handful of pages. The classic caching win — many readers hitting the same expensive query — barely exists. What does exist is a little near-static configuration read on every write, one genuinely public page, and several places where caching would be *actively harmful*.

The strategy is stated in both directions, and the prohibitions matter more than the additions.

#### 12.1.1 What must never be cached

| Data | Why caching it is dangerous |
|---|---|
| `BrokerDailyCounter.sentCount` | This value **is** the daily cap enforcement. A stale count allows a cap to be exceeded — an automatic-fail condition. The counter is already a single indexed row; caching buys microseconds and risks the invariant. |
| Broker eligibility / open-now state | Time-dependent by definition. A 60-second cache means a broker keeps receiving leads for up to a minute after closing. Contradicts §8.1. |
| `AssignedEmail` lookups | The duplicate check is a unique-key insert, not a read. Adding a read-side cache would reintroduce the read-then-write race v2.0 removed. |
| Lead lists and lead detail | Changes constantly; stale data during review reads as a broken product. |
| Any authenticated response, at any layer | §12.3 — a privacy requirement, not a performance one. |

Principle P5: **anything participating in an invariant on the automatic-fail list is never cached.** The §11.1 targets are already met without caching any of it.

#### 12.1.2 What is worth caching

| Data | Volatility | Mechanism |
|---|---|---|
| Form + distribution + broker percentages | ~3 changes in the product's life; read on **every** submission | Version-gated in-process cache (§12.2.2) |
| Public form page `/{slug}` | Same volatility; the only page with real traffic | Static generation + on-demand revalidation (§12.4.1) |
| IANA timezone objects | Immutable | Memoized by zone string (§12.2.3) |
| Static assets, JS/CSS bundles | Immutable, content-hashed | Next.js defaults, `immutable` headers |
| Slug 404s | Cheap defence against scanner traffic | 30s bounded LRU (§12.2.4) |

### 12.2 Backend caching

#### 12.2.1 The problem

Every lead submission loads the distribution, its broker links, and each broker's configuration — a three-table join — to build the candidate set. That data changes when an admin edits it, which is roughly never. Reading it fresh on every write is the one genuine inefficiency on the hot path.

#### 12.2.2 Version-gated configuration cache

A naive TTL cache is wrong here for a specific reason: **there are two processes.** The API serves the admin's edit; the worker performs the routing. An in-process TTL cache in the worker would keep using old percentages for the whole TTL after the admin changes them, with no way for the admin to tell. Silent staleness in the commercial logic is precisely the wrong failure mode.

The fix is a version gate — one tiny table (§7.1), one cheap read:

```ts
class CachedDistributionConfigRepository implements DistributionConfigRepository {
  private cached: { version: number; config: DistributionConfig } | null = null;

  async load(): Promise<DistributionConfig> {
    // One primary-key read. Sub-millisecond, no join.
    const { version } = await this.prisma.configVersion.findUniqueOrThrow({
      where: { id: 1 }, select: { version: true },
    });

    if (this.cached?.version === version) {
      this.metrics.counter('config_cache_hits_total');
      return this.cached.config;                    // hit — join avoided
    }

    this.metrics.counter('config_cache_misses_total');
    const config = await this.source.load();        // the three-table join
    this.cached = { version, config };
    this.logger.info('config.cache.refreshed', { version });
    return config;
  }
}
```

Any write to `Form`, `Distribution`, or `DistributionBroker` bumps the version **inside the same transaction** as the write:

```ts
await uow.run(async (tx) => {
  await tx.distributionBroker.updateMany(/* … */);
  await tx.$executeRaw`UPDATE ConfigVersion SET version = version + 1 WHERE id = 1`;
});
```

- **Staleness is bounded at zero, not at a TTL.** Any process sees new config on its next read. Cross-process invalidation without a message, a pub/sub channel, or a cache server.
- **A three-table join becomes a single primary-key read** on the overwhelming majority of submissions.
- **Correct when disabled.** `CONFIG_CACHE=false` swaps it at the composition root (§5.5) with identical behaviour.

Honest assessment: at this volume the saving is a few milliseconds per lead. Included because it is ~40 lines and demonstrates cross-process invalidation — not because the workload demands it. **Tier 2**, and a legitimate cut.

#### 12.2.3 Timezone object memoization

Luxon zone resolution constructs an `Intl.DateTimeFormat` underneath — tens of microseconds — and the routing path does it once per broker per lead. The values are immutable, so memoizing is free and carries no staleness risk.

```ts
const zoneCache = new Map<string, Zone>();
function zoneFor(tz: string): Zone {
  let z = zoneCache.get(tz);
  if (!z) { z = IANAZone.create(tz); zoneCache.set(tz, z); }
  return z;
}
```

Bounded by the number of distinct broker timezones. Unambiguously worth doing.

#### 12.2.4 Negative cache for unknown slugs

`GET /api/public/form/:slug` is publicly reachable and will attract scanner traffic. Unknown slugs are cached as 404 for 30 seconds in a bounded LRU (max 500 entries), so a scanner cannot turn `/aaa`, `/aab`, `/aac` into one database query per request. Cleared on form creation.

#### 12.2.5 What Prisma already caches

Prisma's query engine maintains prepared statements and the pool reuses connections, so statement parsing and connection setup are already amortised. No application-level query cache is layered on top — it would duplicate that work while introducing staleness against tables that must never be stale.

### 12.3 HTTP cache headers — a privacy requirement

**Highest-priority item in this section, and a security fix rather than a performance one.**

Admin endpoints return lead names, emails, phone numbers, and IP addresses. Without explicit headers that response is eligible to be written to the browser's on-disk cache and retained by any intermediary. On a shared machine, closing the browser does not remove it.

```ts
app.use((req, res, next) => {
  if (req.path.startsWith('/api/public/')) {
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  } else {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});
```

| Route class | Header | Reason |
|---|---|---|
| `GET /api/public/form/:slug` | `public, max-age=60, stale-while-revalidate=300` | Public, near-static, no PII |
| `POST /api/public/leads` | `no-store` | Mutation |
| All admin `/api/*` routes | `no-store, private` | Contains PII |
| `/api/ops/*` | `no-store, private` | Must be live to be useful |
| `/api/health*` | `no-store` | A cached health check is a lie |

`no-store` rather than `no-cache`: `no-cache` permits storage with revalidation, which still writes PII to disk. `no-store` forbids storage.

### 12.4 Frontend caching

#### 12.4.1 Public form page — cache aggressively

`/{slug}` is public, holds no personalised data, changes only when the admin renames the form, and is the only page that will see meaningful traffic.

```tsx
// app/(public)/[slug]/page.tsx
export const dynamic = 'force-static';
export const revalidate = 3600;          // safety net; invalidation is on-demand

export async function generateStaticParams() {
  const form = await getForm();          // exactly one, by definition
  return form ? [{ slug: form.slug }] : [];
}
```

```ts
// actions/form.ts
'use server';
export async function createForm(input: CreateFormInput) {
  const form = await api.post('/api/form', input);
  revalidatePath('/[slug]', 'page');
  revalidatePath('/(admin)/form');
  return form;
}
```

Submission still posts to the Route Handler at `/api/public/leads`, which is dynamic and never cached. A cached shell with a dynamic POST target is the correct split.

#### 12.4.2 Admin pages — cache nothing, deliberately

```tsx
// app/(admin)/layout.tsx
export const dynamic = 'force-dynamic';
export const fetchCache = 'only-no-store';
```

`fetchCache = 'only-no-store'` is the subtle one. `dynamic = 'force-dynamic'` opts the *route* out of the Full Route Cache, but individual `fetch()` calls can still populate the Data Cache. `only-no-store` makes any cached fetch in this segment a build error rather than a silent staleness bug.

**Why the standard `{ next: { revalidate: 60 } }` recommendation is rejected here.** Its justification is fan-out: many users requesting identical content, so one origin hit serves the rest. Three conditions make that inapplicable:

1. **No fan-out.** One admin. A cache with one reader has a hit rate near zero and pays only invalidation complexity.
2. **The content is not shared.** It is per-session and PII-bearing. §12.3 requires it be unstorable, and a server-side cache of the same bytes is the same exposure moved one hop.
3. **Freshness is a functional requirement.** A 60-second cache means an assigned lead can still read `unsent` for a minute — exactly the bug §12.4.3 exists to prevent, reintroduced at a different layer.

Where fan-out genuinely exists — the public form page — v5 goes further than the recommendation: full static generation with on-demand revalidation, zero staleness and zero backend hops, which strictly dominates a 60-second TTL.

#### 12.4.3 Router Cache — the correctness bug

Next's client-side Router Cache retains rendered server components for back/forward navigation. The default `staleTimes.dynamic` has historically been 30 seconds, producing:

1. Admin opens `/leads`, sees a lead as `unsent`.
2. Clicks into it and manually assigns a broker — succeeds.
3. Presses back.
4. **The lead still shows `unsent`**, served from the client-side cache.

That reads as a failed assignment. It is a caching artefact, and it would surface during test case 17.

```js
// next.config.js
module.exports = { experimental: { staleTimes: { dynamic: 0, static: 180 } } };
```

Server Actions additionally call `revalidatePath` on affected routes after every mutation, so server-side caches are invalidated in the same round trip that performed the write.

#### 12.4.4 Request memoization — free, keep it

Within a single render pass React deduplicates identical `fetch` calls: a layout and a page both calling `getSession()` produce one request, not two. This needs no configuration but does require data-fetching functions to be *stable and identical* across callers — so `lib/api-client.ts` exposes named functions rather than each caller hand-rolling `fetch` with slightly different options, which would defeat memoization silently.

#### 12.4.5 Static assets

Next emits content-hashed filenames under `/_next/static/` with `Cache-Control: public, max-age=31536000, immutable` by default. Correct as-is.

#### 12.4.6 Summary

| Surface | Full Route Cache | Data Cache | Router Cache | Result |
|---|---|---|---|---|
| `/{slug}` public form | Static, on-demand revalidate | n/a | 180s | Served from cache, no backend hop |
| Admin pages | Off (`force-dynamic`) | Off (`only-no-store`) | 0s | Always fresh |
| `/ops` | Off | Off | 0s | Live by definition |
| `/_next/static/*` | n/a | n/a | n/a | Immutable, 1 year |

### 12.5 Cache invalidation matrix

| Cache | Layer | Invalidated by | Max staleness |
|---|---|---|---|
| Distribution config | Backend, in-process | `ConfigVersion` bump in the writing transaction | **0** — version checked per read |
| Timezone objects | Backend, in-process | Never (immutable) | n/a |
| Unknown-slug 404s | Backend, in-process LRU | Form creation; 30s TTL | 30s |
| Public form page | Next Full Route Cache | `revalidatePath` on form create/rename; 1h fallback | **0** on the mutation path |
| Admin pages | — | Not cached | 0 |
| Router Cache (dynamic) | Browser | `staleTimes.dynamic = 0` | 0 |
| Router Cache (static) | Browser | 180s | 180s (public form only) |
| Static assets | Browser | Content hash in filename | n/a |
| Admin API responses | — | `no-store` | 0 |

A cache with no entry here is a cache nobody owns.

### 12.6 Observability of the cache

Added to the metrics registry (§14.2): `config_cache_hits_total`, `config_cache_misses_total`, `config_cache_refresh_duration_ms`, `slug_negative_cache_hits_total`.

Added to the event taxonomy (§13.3): `config.cache.refreshed` at info level with the new version, so a config change is visible as a log line in **both** processes and a reviewer can watch invalidation propagate across the process boundary.

A **Cache** panel is added to `/ops` (Tier 2): hit rate, current version, time since last refresh.

### 12.7 Deliberately not done

| Option | Why not |
|---|---|
| Redis / Memcached | No sudo, no infrastructure, and nothing here needs a shared cache. The version gate solves cross-process invalidation without one. |
| Query-result cache over Prisma | Would sit in front of tables that must never be stale. Upside is milliseconds; downside is an automatic-fail condition. |
| ETags on list endpoints | Lead lists change on nearly every request; the conditional round trip costs more than it saves. |
| Caching broker availability | Time-dependent. A cached open/closed state is wrong by construction. |
| Service worker / offline shell | Admin tool on a stable connection. A cache layer with its own invalidation problem, for no benefit. |
| CDN in front of the public form | No sudo, no DNS control, single VPS on a fixed port. Static generation captures most of the benefit locally. |

### 12.8 Effort and tiering

| Item | Tier | Effort | Note |
|---|---|---|---|
| `no-store` on admin API responses | **Tier 0** | 10 min | Privacy requirement, not an optimisation |
| `staleTimes.dynamic = 0` | **Tier 0** | 5 min | Prevents a visible bug in test case 17 |
| `fetchCache = 'only-no-store'` | **Tier 0** | 5 min | Turns a silent staleness bug into a build error |
| Public form static generation + `revalidatePath` | **Tier 1** | 45 min | Largest real performance win |
| Timezone memoization | **Tier 1** | 15 min | Free, zero risk |
| Negative slug cache | Tier 2 | 20 min | Only matters under scanner traffic |
| Version-gated config cache | Tier 2 | 90 min | Correct and instructive; saves milliseconds at this volume |
| Cache metrics + `/ops` panel | Tier 2 | 30 min | Follows the existing registry pattern |

Total Tier 0: **20 minutes**, and two of three prevent bugs rather than improve speed. That ratio is the honest summary — the valuable work is deciding what *not* to cache and stopping the framework caching things it shouldn't.

---

## 13. Structured Logging

### 13.1 Principles

Every process — API, worker, Next.js server — emits **newline-delimited JSON to stdout**. PM2 captures stdout to files. No process writes its own log files or formats for humans in production; pretty-printing happens only in development via `pino-pretty`.

The unit of logging is the **canonical event**: one wide, self-contained line per meaningful occurrence, carrying every field needed to understand it. Not five thin lines that must be reassembled.

### 13.2 Log schema

Enforced by a typed wrapper around pino, so an untyped `logger.info('something happened')` does not compile.

```jsonc
{
  "ts":        "2026-08-25T09:14:22.417Z",  // ISO 8601, always UTC
  "level":     "info",
  "service":   "lead-api",                   // lead-api | lead-worker | lead-web
  "env":       "production",
  "version":   "1.4.0",                      // git short SHA at build
  "pid":       31847,
  "event":     "lead.routed",                // from the closed taxonomy in §13.3
  "traceId":   "9f2c8a1e4b6d7038",           // spans processes — the correlation key
  "requestId": "b7e1…",                      // one HTTP request; absent in the worker
  "userId":    12,
  "durationMs": 47,
  "msg":       "Lead routed to broker",      // human summary, never parsed
  "leadId":    884, "brokerId": 3, "deficit": 1.5,
  "candidateCount": 4, "excludedCount": 2
}
```

### 13.3 Event taxonomy

A closed set. New events require adding to the union type, keeping the vocabulary greppable rather than accreting free text.

| Event | Level | Key fields |
|---|---|---|
| `http.request` | info | method, path, status, durationMs, ip |
| `auth.login.succeeded` / `.failed` | info / warn | email (masked), ip |
| `lead.captured` | info | leadId, formId, ip, durationMs |
| `lead.routed` | info | leadId, brokerId, deficit, candidateCount, excludedCount |
| `lead.duplicate` | info | leadId, priorBrokerId |
| `lead.unsent` | warn | leadId, reason, candidateCount |
| `lead.failed` | error | leadId, error |
| `lead.assigned.manual` | info | leadId, brokerId, userId |
| `broker.excluded` | debug | brokerId, rule (`inactive`\|`closed`\|`off_day`\|`capped`\|`zero_pct`) |
| `outbox.published` / `.claimed` | debug | messageId, type / count |
| `outbox.processed` | info | messageId, attempts, durationMs |
| `outbox.retry` | warn | messageId, attempts, backoffMs, lastError |
| `outbox.dead` | error | messageId, attempts, lastError |
| `outbox.reaped` | warn | count |
| `config.cache.refreshed` | info | version |
| `worker.heartbeat` | debug | processedTotal |
| `config.loaded` | info | port, dbName, migrationStatus |
| `app.started` / `app.stopping` | info | port, version |
| `db.slow_query` | warn | durationMs, model, operation |

`broker.excluded` at debug is the single most useful line in the system when a reviewer asks "why didn't broker B get this lead?" — it names the exact rule.

### 13.4 Correlation across processes

```
Browser request
   └─ Next Route Handler generates traceId (16 bytes hex)
        └─ forwards as X-Trace-Id → Express
             └─ requestId generated per request; both bound to a child logger
                  └─ traceId written onto the Lead row AND the Outbox row
                       └─ Worker claims message, restores traceId into its logger
                            └─ every worker line for this lead carries the same traceId
```

`grep '"traceId":"9f2c8a1e"' logs/*.log | jq -s 'sort_by(.ts)'` returns the complete life of one lead across three processes and an asynchronous boundary. `traceId` is also returned in every API response envelope, so a reviewer reporting a bug can quote one string that finds everything.

### 13.5 Redaction and safety

pino `redact` paths strip `password`, `passwordHash`, `authorization`, `cookie`, `token`, and `DATABASE_URL` at the serializer, so a careless object spread cannot leak a credential.

Emails are logged **masked** (`r***@g***.com`). Lead emails are business data the admin sees in the UI, but a log file has a different audience and retention path than an authenticated page.

Stack traces are logged in full and returned to clients never — the client gets a code, a message, and the `traceId`.

### 13.6 Rotation

`pm2 install pm2-logrotate` (no sudo), 10MB per file, 14 retained, daily, gzip on rotate. Without this a chatty service fills the disk and takes MySQL down with it — a failure mode that looks like "the app does not run."

---

## 14. Observability and Monitoring

### 14.1 Why in-app

No Prometheus, Grafana, or APM is installable here. The monitoring surface ships *as part of the product*: an in-memory metrics registry, durable counters derived from the database, and an admin-only `/ops` page.

### 14.2 Metrics registry

Counters, gauges, and histograms with p50/p95/p99 over a rolling 1000-sample window. No dependency, ~80 lines.

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | method, route, status |
| `http_request_duration_ms` | histogram | route |
| `middleware_duration_ms` | histogram | — (asserts the §17.4 budget) |
| `leads_captured_total` | counter | — |
| `leads_routed_total` | counter | outcome |
| `lead_capture_to_assign_ms` | histogram | end-to-end, the number that matters |
| `broker_exclusions_total` | counter | rule |
| `outbox_depth` | gauge | status |
| `outbox_oldest_pending_age_ms` | gauge | the true lag signal |
| `config_cache_hits_total` / `_misses_total` | counter | — |
| `db_query_duration_ms` | histogram | model, operation |

In-memory metrics reset on restart — stated plainly rather than glossed. Anything that must survive a restart is derived from the database on read, so the durable numbers are durable and the volatile ones are labelled volatile. See §5.7 on why this makes the API stateful.

### 14.3 Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | Liveness. No DB touch |
| GET | `/api/health/ready` | none | DB reachable, migrations applied, worker heartbeat < 60s. 503 if not |
| GET | `/api/ops/metrics` | admin | Registry snapshot as JSON |
| GET | `/api/ops/outbox` | admin | Depth by status, oldest pending age, dead letters |
| POST | `/api/ops/outbox/:id/replay` | admin | Return a `DEAD` message to `PENDING` |
| GET | `/api/ops/logs/tail` | admin | Last N JSON lines, filterable by level, event, `traceId` |

`/api/health/ready` returning 503 on a stale worker heartbeat is what makes a dead worker *loud* instead of silent — the single most valuable line in this section.

### 14.4 `/ops` dashboard (Tier 2)

Auto-refreshing every 10 seconds:

- **System** — API uptime, worker heartbeat age (red past 60s), version SHA, DB connectivity, migration status.
- **Queue** — pending / processing / dead counts, oldest pending age, hourly throughput, dead-letter list with `lastError` and a replay button.
- **Routing** — leads by status over 24h, capture→assign p50/p95/p99, exclusion counts by rule, unsent count linking to the filtered Leads page.
- **Brokers** — live open/closed state, `sentToday / cap` bars, next open time for closed brokers.
- **Cache** — config cache hit rate, version, time since refresh.
- **Recent errors** — last 20 `level >= error` lines with `traceId`, linking to the filtered log tail.

Beyond debugging, this is the demonstration surface: the exclusion-by-rule panel *shows* a reviewer that caps and opening hours are enforced, rather than asking them to infer it.

### 14.5 Out of scope
Alerting, paging, external metric shipping, distributed tracing spans, log aggregation. `traceId` is shaped so OpenTelemetry can be adopted later without touching call sites.

---

## 15. API Specification

Envelope: `{ success, data?, error?: { code, message, details? }, traceId }`. Every shape is a Zod schema in `src/contracts` and the source of the generated types (§9.3).

**Auth** — `POST /api/auth/login` (sets httpOnly JWT cookie; generic 401, no user enumeration), `POST /api/auth/logout`, `GET /api/auth/me`.

**Brokers** — `GET /api/brokers` (with `sentToday`, `isOpenNow`, `isCapped`), `POST`, `GET/PATCH /:id`, `DELETE /:id` (409 if it holds leads — deactivate instead), **`GET /:id/detail`** (composite: broker + today's stats + first page of leads, §9.2).

**Form** — `GET /api/form`, `POST /api/form` (409 `FORM_ALREADY_EXISTS`; bumps `ConfigVersion`), `GET /api/public/form/:slug` (unauthenticated, cacheable).

**Distribution** — `GET`, `POST` (400 `FORM_REQUIRED` → `Oops, please create a form first.`; 409 if one exists; auto-binds `formId`), `PATCH`, `PUT /api/distribution/brokers`, **`GET /api/distribution/detail`** (composite), `POST /api/distribution/simulate` (dry run, no writes). All mutations bump `ConfigVersion` in the same transaction.

**Leads** — `POST /api/public/leads`, `GET /api/leads` (keyset cursor; filters: status, brokerId, search, date range), `GET /api/leads/:id` (includes `decisionTrace`), `POST /api/leads/:id/assign`, `POST /api/leads/:id/retry`.

**Dashboard** — **`GET /api/dashboard/summary`** (composite, §9.2).

**Ops** — §14.3.

**Error taxonomy** — one `AppError` base with `httpStatus` and `code`; one error middleware translates; unknown throws become `INTERNAL_ERROR` with the stack logged and never returned.

| Code | HTTP | Message |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Field-level messages |
| `UNAUTHORIZED` | 401 | Please log in to continue. |
| `FORM_ALREADY_EXISTS` | 409 | A form already exists. Only one form can be created. |
| `FORM_REQUIRED` | 400 | `Oops, please create a form first.` |
| `DISTRIBUTION_ALREADY_EXISTS` | 409 | A distribution already exists. Only one distribution can be created. |
| `DUPLICATE_LEAD` | 409 | This email has already been assigned to a broker. |
| `BROKER_CAPPED` | 409 | This broker has reached its daily cap. |
| `LEAD_NOT_ASSIGNABLE` | 409 | Only unsent leads can be assigned. |
| `SLUG_TAKEN` | 409 | That URL slug is already in use. |
| `INTERNAL_ERROR` | 500 | Something went wrong. Please try again. |

---

## 16. Screens

Every data view handles **loading / empty / success / error** explicitly. Each admin page names its backend calls, per the §11.1 budget.

**`/login`** — email and password, inline validation, generic failure message. *(0 calls before submit.)*

**`/dashboard`** — status cards; setup checklist (Form ✓/✗ → Distribution ✓/✗ → Brokers ✓/✗ → **Worker healthy ✓/✗**); last 10 leads; unsent count linking to the filtered list. *(1 call: `/api/dashboard/summary`.)*

**`/brokers`** — name, status, timezone, hours, working days, cap, `sentToday / cap`, live open-now indicator. Modal: name, active, cap (0 = Unlimited), searchable IANA timezone defaulting to `Asia/Manila`, opening and closing time, seven day chips with at least one required. *(1 call.)*

**`/brokers/[id]`** — profile, live availability ("Open — closes 18:00 Asia/Manila"), cap usage, and the required leads table: **Lead name, Email, Phone, IP address, Form name, Date received, Status**. *(1 call: `/api/brokers/:id/detail`.)*

**`/form`** — creation panel if none (name; auto-derived unique slug with reserved words blocked; live URL preview). Once created: read-only detail, copy-to-clipboard URL, disabled create control explaining the single-form rule. No delete. *(1 call.)*

**`/distribution`** — with no form, the create action shows exactly `Oops, please create a form first.` Otherwise: name, read-only linked form, reference timezone, broker multi-select; then a broker table with percentage inputs, in-distribution toggles, sent-today, remove, and a running total that warns when ≠ 100% without enforcing it. *(2 parallel calls: distribution + broker list.)*

**`/distribution/[id]`** — the audit view. Status counters; every lead with date, name, email, phone, IP, status, broker, `failureReason`; filter chips; routed rows expand to show the recorded deficit maths; unsent rows expose inline assign and retry. *(1 call: `/api/distribution/detail`.)*

**`/leads`** — all leads, filters for status/broker/date/search, keyset "load more". Unsent rows carry Assign; the modal shows each broker's availability and cap usage, flagging ineligible ones. Closed/out-of-hours can be overridden deliberately; cap and duplicate are hard-blocked server-side. *(2 parallel calls: leads page + broker list for the filter.)*

**`/{slug}`** — public, statically generated. Name, Email, Phone, Submit. **The confirmation is identical for sent, unsent, and duplicate** — varying it would leak whether an email was previously sold, which is both a systems leak and a privacy problem. Unknown slug → 404. *(0 calls at request time.)*

**`/ops`** — §14.4. *(1 call.)*

---

## 17. Validation, Security, Configuration

### 17.1 Validation (Zod, server-side authoritative)
Lead name 2–100; email valid ≤255, normalized before storage and comparison; phone 7–20 with `+ - ( ) space`; broker name 2–100; cap integer 0–10000; timezone a valid IANA identifier; times matching `^([01]\d|2[0-3]):([0-5]\d)$`; working days a non-empty array of unique 1–7; percentage 0–100 with 2 decimals; slug `^[a-z0-9]+(?:-[a-z0-9]+)*$` 2–50, excluding reserved words (`api`, `login`, `dashboard`, `brokers`, `leads`, `form`, `distribution`, `ops`).

### 17.2 Security
JWT signed with `JWT_SECRET`, 24h, httpOnly + SameSite=Lax cookie — backend is the sole verifier. bcrypt cost 12; the seeded admin password comes from an env var. Backend rejects anything lacking `X-Internal-Token`. Zod at every entry point; Prisma parameterizes everything; the only raw SQL is the audited outbox claim, counter update, and config-version bump. Per-IP rate limiting plus a honeypot on the public POST. `helmet` and CSP. `no-store, private` on every authenticated response (§12.3). `.gitignore` in commit 1, `.env.example` placeholders only, `gitleaks` before every push.

### 17.3 Environment

```bash
# ── backend/.env.example ───────────────────────────────
NODE_ENV=production
PORT=<BACKEND_PRIVATE_PORT>
HOST=127.0.0.1
DATABASE_URL="mysql://<USER>:<PASS>@127.0.0.1:3306/<DB>?connection_limit=8"
JWT_SECRET=<openssl rand -hex 32>
JWT_EXPIRES_IN=24h
INTERNAL_API_TOKEN=<openssl rand -hex 32>
SEED_ADMIN_EMAIL=<email>
SEED_ADMIN_PASSWORD=<strong>
LOG_LEVEL=info
LOG_PRETTY=false
CONFIG_CACHE=true                   # false disables the config cache with identical behaviour
INLINE_WORKER=false                 # degraded fallback if the worker process fails

# ── worker (same repo, own .env) ───────────────────────
DATABASE_URL="mysql://…?connection_limit=4"
WORKER_ID=worker-1
OUTBOX_POLL_INTERVAL_MS=500
OUTBOX_BATCH_SIZE=10
OUTBOX_MAX_ATTEMPTS=5
CONFIG_CACHE=true

# ── frontend/.env.example ──────────────────────────────
PORT=<FRONTEND_PUBLIC_PORT>
BACKEND_URL=http://127.0.0.1:<BACKEND_PRIVATE_PORT>   # server-only
INTERNAL_API_TOKEN=<must match backend>
NEXT_PUBLIC_APP_URL=http://<SERVER_IP>:<FRONTEND_PUBLIC_PORT>
```

`config/env.ts` parses these with Zod at boot and exits on anything invalid — a missing secret should kill the process at startup, not surface as a 500 during review. Real values are entered on the VPS over SSH and stored in a password manager.

### 17.4 Middleware budget and ordering

**Why this section exists.** Middleware runs on *every* request, so anything expensive there is multiplied by traffic and paid even by requests that will be rejected. v4 listed the middleware without bounding its cost or specifying whether auth touched the database.

**Budget: total middleware overhead p95 < 5ms**, excluding handler work. Measured by `middleware_duration_ms` and visible on `/ops`.

**Ordering — cheapest and most likely to reject, first:**

| # | Middleware | Cost | Why here |
|---|---|---|---|
| 1 | `requestId` + logger binding | ~0.1ms | Must be first so every later line is correlated, including rejections |
| 2 | `helmet` | ~0.1ms | Header writes only |
| 3 | `cache-headers` (§12.3) | ~0.05ms | One string comparison and a header write |
| 4 | **Internal token guard** | ~0.05ms | Constant-time compare. Rejects anything not from the BFF **before** body parsing or JWT work |
| 5 | Rate limiter | ~0.2ms | **Mounted on `/api/public/*` only** — an admin API call should never pay for it |
| 6 | Body parser | varies | `limit: '64kb'` — no endpoint accepts more; caps the work an attacker can force |
| 7 | Auth (JWT verify) | ~0.3ms | **No database lookup** — see below |
| 8 | Router → controller | — | Handler work begins |
| 9 | Error handler | — | Terminal |

**Auth performs no database lookup.** The JWT carries `sub`, `email`, and `role`; everything the request needs is in the verified claims. A per-request `SELECT` on the user table would add a database round trip to every authenticated call for information that has not changed since login.

The trade-off, stated rather than hidden: a token stays valid until it expires. There is no server-side revocation, so logout clears the cookie client-side and a stolen token is usable for up to 24 hours. For a single seeded admin account on a review deployment, that is an acceptable trade. A production system with real user churn would add a `tokenVersion` claim checked against a cached user record — which reintroduces the lookup, and should be a deliberate decision rather than an accident.

**Prohibited in middleware**, and enforced by review rather than tooling: database queries, `bcrypt` (login handler only), synchronous crypto, JSON serialization of request bodies for logging, and any `await` not on the list above. Request bodies are never logged — they contain lead PII (§13.5).

---

## 18. Deployment

No sudo — no nginx, systemd, or Docker. Frontend binds the assigned public port; backend binds the private port on `127.0.0.1`; worker binds nothing.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20 && nvm use 20 && npm i -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true

git clone <backend-repo> ~/apps/api && cd ~/apps/api
npm ci && cp .env.example .env && nano .env
npx prisma migrate deploy && npx prisma db seed && npm run build

git clone <frontend-repo> ~/apps/web && cd ~/apps/web
npm ci && cp .env.example .env && nano .env && npm run build

pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

```js
// ecosystem.config.js — three processes
module.exports = { apps: [
  { name: 'lead-api',    cwd: '~/apps/api', script: 'dist/main-api.js',
    instances: 1, max_memory_restart: '300M', time: true },
  { name: 'lead-worker', cwd: '~/apps/api', script: 'dist/main-worker.js',
    instances: 1, max_memory_restart: '200M', time: true,
    exp_backoff_restart_delay: 200 },     // avoid a crash-loop hammering MySQL
  { name: 'lead-web',    cwd: '~/apps/web', script: 'node_modules/next/dist/bin/next',
    args: 'start -p <FRONTEND_PUBLIC_PORT>',
    instances: 1, max_memory_restart: '400M', time: true },
]};
```

`instances: 1` is load-bearing on the worker and commented as such: it is what makes assignment serialized (§6.2). It also matters on the API for the metrics registry (§5.7). `SKIP LOCKED` keeps a second worker *correct*, but the current design assumes one.

The frontend build must run **after** the form exists if `generateStaticParams` is to prebuild the public page; otherwise the first visit generates it on demand and every subsequent visit is cached. Both paths are correct — documented so the behaviour isn't mistaken for a bug.

| Task | Command |
|---|---|
| Status | `pm2 status` |
| Structured logs | `pm2 logs lead-worker --raw \| jq 'select(.level=="error")'` |
| Trace one lead | `grep '"traceId":"<id>"' ~/.pm2/logs/*.log \| jq -s 'sort_by(.ts)'` |
| Readiness | `curl -s localhost:<BACKEND_PORT>/api/health/ready \| jq` |
| Queue depth | `curl -s localhost:<BACKEND_PORT>/api/ops/outbox \| jq` |
| Middleware cost | `curl -s localhost:<BACKEND_PORT>/api/ops/metrics \| jq '.middleware_duration_ms'` |
| Restart all | `pm2 restart all && pm2 save` |

README must cover: clone → install → env vars → database → migrations and seed → start/restart → **how to read the JSON logs and trace a lead** → **how to regenerate and sync API contract types** → access URL → review credentials → architecture summary → the §19 checklist.

---

## 19. Test Plan

### 19.1 Required cases
| # | Test | Expected |
|---|---|---|
| 1 | Login with seeded credentials | Dashboard; bad password → generic 401 |
| 2 | Create brokers, mixed timezones | Persist and list |
| 3 | Create one form | `/{slug}` live |
| 4 | Second form via UI **and** API | Both 409 |
| 5 | Distribution before form | Exactly `Oops, please create a form first.` |
| 6 | Distribution after form | Created, auto-bound |
| 7 | Second distribution via UI **and** API | Both 409 |
| 8 | Brokers at 50/30/20 | Persist and display |
| 9 | Submit from `/{slug}` | Saved; assigned within ~1s |
| 10 | Inspect lead | IP present, non-null |
| 11 | Check assignment | Highest-deficit eligible broker; trace shows the maths |
| 12 | Broker leads view | All seven required columns including IP |
| 13 | Distribution Detail | Sent, duplicate, unsent, failed with broker attribution |
| 14 | Resubmit same email, varied case/whitespace | `duplicate`, no broker |
| 15 | Cap 2, submit 3 | Third skips the capped broker; trace and `broker.excluded` name the rule |
| 16 | Hours set to a past window | Broker skipped; rule named in trace and log |
| 17 | Manual assign an unsent lead | `sent`, `assignedAt` set, `MANUAL` |
| 18 | `pm2 restart all`, reload | Functional, data intact, queue drains |

### 19.2 Caching verification
| # | Test | Expected |
|---|---|---|
| 19 | After test 17, press browser back to `/leads` | Lead shows `sent`, **not** cached `unsent`. Asserts §12.4.3 |
| 20 | `curl -I` any admin API endpoint | `Cache-Control: no-store, no-cache, must-revalidate, private`. Asserts §12.3 |
| 21 | Change a broker percentage, immediately submit a lead | Routing uses the **new** percentage; `config.cache.refreshed` appears in the worker log with the bumped version. Asserts §12.2.2 cross-process invalidation |

### 19.3 Architecture seam verification (new)
| # | Test | Expected |
|---|---|---|
| 22 | Load each admin page with backend request logging on; count `http.request` lines per page render | **≤2 per page.** Dashboard exactly 1. Asserts §9.2 and the §11.1 budget |
| 23 | Change a field name in a backend contract schema, run `contracts:build`, do **not** sync | Frontend `tsc` fails; the CI drift check fails. Asserts §9.3 |

### 19.4 Additional
- **Domain unit tests** (no DB, no fixtures): the worked example; all-ineligible; tie by sent count; tie by ID; all-negative-deficit; zero-percentage exclusion; overnight windows; DST boundary; three timezones with injected clocks.
- **Application unit tests** with in-memory fakes for all ports: duplicate collision, cap exhaustion mid-selection, no-distribution, idempotent redelivery.
- **Concurrency (real MySQL, real parallel HTTP — mocks prove nothing here):** 20 parallel submissions against cap 5 → exactly 5 sent; 10 parallel submissions of the same new email → exactly 1 sent, 9 duplicate; 2 parallel `POST /api/form` → exactly 1 succeeds.
- **Messaging:** kill the worker mid-batch → `PROCESSING` rows reaped and reprocessed, nothing lost; force a handler throw → backoff then `DEAD` after 5 attempts; replay a dead letter → routes successfully.
- **Cache parity:** run the full suite twice, `CONFIG_CACHE=true` and `false`. Identical results, or the cache is wrong.
- **Middleware budget:** 200 requests to a trivial endpoint; assert p95 `middleware_duration_ms` < 5ms.
- **Observability:** submit a lead, then assert one `grep` on its `traceId` returns `lead.captured`, `outbox.published`, `outbox.claimed`, `outbox.processed`, and `lead.routed` across two processes.
- **Auth sweep:** every admin endpoint with no cookie → 401.
- **Secret scan:** `gitleaks detect` on both repos before submission.

---

## 20. Delivery Plan

**Day 1 — domain and foundation.** Repo scaffolding, ESLint boundary rules, env parsing, logger with the §13.2 schema, Prisma schema including `Outbox`, `BrokerDailyCounter`, `AssignedEmail`, `WorkerHeartbeat`, `ConfigVersion`; migration and seed. **The pure domain ring written test-first** — value objects, `selectBroker`, availability — with its full unit suite green before any HTTP exists. Auth end to end; middleware stack in the §17.4 order; broker CRUD and page; health endpoints; the three Tier 0 cache settings; the contracts file and sync script (§9.3) established early, while the schema surface is small. *Gate: routing logic is provably correct with zero infrastructure.*

**Day 2 — application and messaging.** Ports and use cases with in-memory fakes; Prisma implementations; composite read use cases (§9.2); outbox publisher and consumer; worker entrypoint and heartbeat; form and distribution singletons; public form page with static generation; full capture→route flow; concurrency tests against real MySQL. *Gate: a submitted lead routes through the queue, and the concurrency and messaging tests pass.*

**Day 3 — surface and ship.** Leads, Distribution Detail, broker detail, manual assign and retry; all four UI states; metrics registry and ops endpoints; `/ops` page if time allows; VPS provisioning, three PM2 processes, logrotate, migrate, seed; README; full §19 pass against the live URL. *Gate: a clean-machine reviewer reproduces every test from the README alone.*

Cut order if Day 3 compresses: `/ops` UI → log tail → latency histograms → simulate panel → trace expansion → config cache → negative slug cache. If Day 2 slips, the outbox is replaced by inline routing after the capture commit, restoring the v2.0 advisory lock — decided on Day 2 morning, never on Day 3 evening.

Note that §9.3 belongs on **Day 1** specifically because its value compounds: established early it catches drift for two days, bolted on at the end it catches nothing and costs the same twenty minutes.

---

## 21. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Worker dies silently; leads sit unrouted | Reads as a broken product | Heartbeat + `/api/health/ready` 503 + dashboard checklist; PM2 restart with backoff; `INLINE_WORKER` fallback |
| Three processes exceed VPS memory | Everything restarts in a loop | `max_memory_restart` per process, 900M total; pools capped at 12 connections |
| Clean Architecture layering eats Day 1 | Tier 0 at risk | Full layering only in the routing context (§5.4); CRUD stays thin; boundary lint prevents drift |
| Outbox grows unbounded | Claim index degrades | Nightly purge of `DONE` older than 7 days; `DEAD` retained deliberately |
| Log volume fills the disk | MySQL dies; reads as "app does not run" | `pm2-logrotate` 10MB × 14, gzipped; `broker.excluded` at debug, off in production |
| Async routing confuses a reviewer expecting instant assignment | Perceived as a bug | README states the ~1s window; the lead appears immediately as unsent and flips to sent; `/ops` shows lag live |
| Framework default caching serves stale admin data | A successful assign appears to have failed | `staleTimes.dynamic = 0`, `fetchCache = 'only-no-store'`, `revalidatePath` after mutations; test 19 asserts it |
| Config cache serves stale percentages in the worker | Wrong commercial split, silently | Version gate makes staleness zero by construction; test 21 asserts cross-process invalidation; `CONFIG_CACHE=false` disables it |
| **API contract drift between repos** | Runtime `undefined` in the frontend, hard to trace | Types generated from Zod schemas; CI hash check fails on unsynced drift; test 23 asserts it (§9.3) |
| **Middleware creep** | Every request pays; degrades silently as features land | Explicit ordering and prohibition list (§17.4); `middleware_duration_ms` on `/ops`; p95 budget asserted in the test suite |
| Timezone logic wrong (DST, overnight, day boundary) | Automatic fail | Value objects, injected clocks, minutes-since-midnight comparison, tests across three zones and a DST boundary |
| Singleton or duplicate guard bypassed via direct API | Automatic fail | Database constraints, not service guards, are the guarantee (§10) |
| Secret reaches a commit | Automatic fail | `.gitignore` first, placeholders only, `gitleaks` pre-push |

---

## 22. Open Questions

| # | Question | Default |
|---|---|---|
| Q1 | Must percentages sum to 100? | No. UI warns; the formula routes proportionally regardless |
| Q2 | Repeat of an email whose first submission is still unsent — duplicate? | No. Duplicate requires a prior *assignment* |
| Q3 | Does `totalSentToday` count all distribution brokers or only eligible ones? | All — the share is against total daily volume |
| Q4 | May a manual assignment exceed a cap? | No. Blocked by the conditional `UPDATE` |
| Q5 | Selectable when every eligible broker has negative deficit? | Yes. Least-over wins; leads are never dropped for being ahead |
| Q6 | Cap boundary for a manual assignment? | `assignedAt`, in the target broker's timezone |
| Q7 | Whose day defines `totalSentToday` across mixed timezones? | `Distribution.timezone`, admin-configurable, default `Asia/Manila` |
| Q8 | Inline routing or a queue? | Queue — transactional outbox, single worker. No new infrastructure, and it removes the advisory lock rather than adding a broker |
| Q9 | Is ~1s async routing acceptable, or must assignment be visible on the submit response? | Async accepted. `INLINE_WORKER=true` makes it synchronous with one env var and no code change |
| Q10 | Should the worker ever run more than one instance? | No. `SKIP LOCKED` keeps multi-instance *correct*, but one instance is what makes assignment serialized without a lock |
| Q11 | Is the config cache worth its 90 minutes at this volume? | Arguably not. Tier 2, disabled by one env var, parity test proves identical behaviour. Build it only if Day 3 has room |
| Q12 | **(new)** Is a two-repo type sync acceptable, or should the contract be published as a versioned npm package? | Sync script + CI drift check. A GitHub-hosted package is cleaner but adds a publish step to every schema change during a 3-day build. Revisit if the project outlives the exam |
| Q13 | **(new)** Should auth verify a `tokenVersion` against the database for server-side revocation? | No, for this deployment. One seeded admin, 24h tokens, and a per-request lookup on every authenticated call is a poor trade (§17.4). A production system with real user churn should reverse this |
