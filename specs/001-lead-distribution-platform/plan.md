# Implementation Plan: Lead Distribution Platform

**Branch**: `001-lead-distribution-platform` | **Date**: 2026-08-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-lead-distribution-platform/spec.md`

## Summary

Build the complete Lead Distribution Platform: anonymous public lead capture
with concurrency-proof duplicate prevention, automatic fair-share routing by
the highest-deficit formula across broker timezones, working days, opening
hours, and daily caps, administrator configuration and audit views, and
durable asynchronous processing with in-product observability — deployed as
three processes on a single VPS without elevated privileges.

Technical approach: TypeScript end-to-end on Node 20. Clean Architecture
applied strictly to the routing/capture context (thin services elsewhere);
transactional-outbox messaging consumed by a single serialized worker;
version-gated in-process configuration cache for zero-staleness cross-process
invalidation; API contract types generated from backend Zod schemas and synced
to the frontend repository with a CI drift check; structured JSON logging
correlated by `traceId` across all three processes.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20 LTS (nvm-managed, no sudo)

**Primary Dependencies**: Next.js (App Router, Server Components/Server
Actions), Express, Prisma (MySQL connector), Zod, pino, Luxon, jsonwebtoken,
bcrypt, helmet, compression, express-rate-limit; PM2 + pm2-logrotate

**Storage**: MySQL 8 — single shared instance; Prisma migrate deploy; explicit
pool sizing (API connection_limit=8, worker connection_limit=4)

**Testing**: Vitest for domain/application units (in-memory port fakes);
integration suites against real MySQL; concurrency suites against live HTTP
(real parallel requests, no mocks); cache-parity suite run twice
(CONFIG_CACHE on/off); budget assertions (round-trip count, middleware p95)

**Target Platform**: Single Linux VPS, unprivileged user; three PM2 processes:
`lead-api` (private port, binds 127.0.0.1), `lead-worker` (no listener),
`lead-web` (assigned public port)

**Project Type**: Web application delivered as **two public GitHub
repositories** (`backend/`, `frontend/` in this workspace; published
separately)

**Performance Goals**: Capture p95 < 120ms (p50 < 60ms); capture-to-assignment
p95 < 3s; dashboard summary p95 < 180ms; admin page TTFB p95 < 700ms; public
form TTFB p95 < 120ms (statically served)

**Constraints**: ≤ 2 backend round trips per admin page (test-asserted);
middleware overhead p95 < 5ms excluding handler work (test-asserted);
`instances: 1` per process is load-bearing; no sudo, no Redis/CDN/Docker/
external APM; authenticated responses always `no-store, private`; values
enforcing invariants never cached; no real secret ever committed (gitleaks
before every push)

**Scale/Scope**: Low hundreds of leads/day; lead history into tens of
thousands of rows (keyset-paged); 10 screens; 3-day build window with fixed
Tier 0 / Tier 1 / Tier 2 cut policy (Tier 0 never cut)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Gate | Status | Evidence |
|---|------|--------|----------|
| I | Invariants belong to the database | PASS (design) | Singleton `Boolean @unique` on Form/Distribution; `AssignedEmail` email primary key — collision IS duplicate detection; conditional `UPDATE … WHERE cap=0 OR sentCount<cap` under row lock; Lead + Outbox inserted in one transaction (dual-write impossible). See data-model.md §Invariants. |
| II | Domain does not know it is on a server | PASS (design) | `src/domain/**` has zero imports outside itself; clock injected as `Clock`/`ZonedInstant`; `selectBroker` is a pure function; enforced mechanically by import-boundary lint failing the build. |
| III | Capture and routing separately concerned | PASS (design) | Capture commits Lead(`UNSENT`) + routing message atomically, returns immediately; single worker (`instances: 1`) serializes assignment; handler idempotent via status re-check + unique-key claim + conditional increment; retries with backoff, dead-letter at 5 attempts, stale-claim reaper. |
| IV | Every process emits machine-readable events | PASS (design) | pino newline-JSON to stdout in API, worker, and web; closed event taxonomy (typed union); `traceId` originates at the edge and spans all processes and rows; redact paths strip credentials; emails masked; pm2-logrotate 10MB × 14 gzipped. |
| V | Nothing invariant-participating is ever cached | PASS (design) | Counters, eligibility/open-now, AssignmentEmail lookups, lead lists/detail, and every authenticated response are never cached (`no-store, private` headers). Only near-static config is cached, behind a version gate checked per read (zero staleness), disabled by `CONFIG_CACHE=false` with parity tests. |
| VI | Every layer boundary has a cost budget | PASS (design) | Named tests assert: backend round trips per admin page ≤ 2 (dashboard exactly 1); middleware p95 < 5ms over 200 requests; capture p95 < 120ms; capture-to-assign p95 < 3s. Middleware ordering fixed cheapest-first; auth performs no database lookup. |

Additional-constraint checks: fixed stack honoured; Clean Architecture scoped
ONLY to routing/capture (CRUD stays controller+schema+service); API statefulness
documented (per-process caches/metrics safe at `instances: 1`); contract types
generated from Zod with CI + pre-push drift hash; Tier 0 items scheduled Day 1;
README/reviewer-reproducibility gate owned by Day 3.

**Post-design re-check (after Phase 1)**: All six gates still PASS with
artifacts in place — see data-model.md (I, III), project structure + boundary
lint (II), contracts/api.md observability headers (IV), caching matrix in
research.md D14 (V), budget assertions in quickstart.md scenarios (VI). No
violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/001-lead-distribution-platform/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── api.md           # HTTP interface contracts (all endpoints)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created here)
```

### Source Code (repository root)

```text
backend/                                  # → published as its own public repo
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                           # seeded admin credentials from env
├── src/
│   ├── domain/                           # ZERO external imports (lint-enforced)
│   │   ├── entities/                     # Broker, Lead
│   │   ├── value-objects/                # Email, TimeWindow, Percentage, WorkingDays, ZonedInstant
│   │   ├── services/                     # selectBroker (pure)
│   │   └── errors/
│   ├── application/
│   │   ├── ports/                        # repositories, UnitOfWork, Clock, Logger, Metrics, OutboxPublisher
│   │   ├── use-cases/                    # CaptureLead, RouteLead, ManuallyAssignLead,
│   │   │                                 # GetDashboardSummary, CreateForm, CreateDistribution…
│   │   └── dto/
│   ├── infrastructure/
│   │   ├── persistence/prisma/{client,repositories,unit-of-work}
│   │   ├── persistence/cache/{cached-distribution-config,negative-slug-cache}
│   │   ├── messaging/{outbox-publisher,outbox-consumer,message-schemas}
│   │   ├── observability/{logger,metrics,correlation}
│   │   ├── time/luxon-clock.ts           # memoized IANA zones
│   │   ├── security/{bcrypt,jwt}
│   │   └── container.ts                  # explicit composition root (no DI framework)
│   ├── interfaces/
│   │   ├── http/{controllers,routes,middleware,schemas,mappers}
│   │   └── worker/{entrypoint,handlers,purge-tasks}
│   ├── contracts/index.ts                # ← Zod schemas = published API surface
│   ├── config/env.ts                     # Zod-parsed env, exit-fast on invalid
│   └── main-api.ts | main-worker.ts
├── tests/
│   ├── unit/domain/                      # ms-fast, no fixtures
│   ├── unit/application/                 # in-memory fakes for all ports
│   ├── integration/                      # real MySQL, Prisma implementations
│   ├── concurrency/                      # real parallel HTTP
│   └── budgets/                          # round-trip counts, middleware p95
└── package.json                          # contracts:build / contracts:sync scripts

frontend/                                 # → published as its own public repo
├── app/
│   ├── (public)/[slug]/page.tsx          # force-static, on-demand revalidate
│   ├── (public)/api/public/leads/route.ts # the ONE Route Handler: captures IP at true edge
│   ├── (admin)/layout.tsx                # force-dynamic + fetchCache 'only-no-store'
│   ├── (admin)/login/page.tsx
│   ├── (admin)/dashboard/page.tsx        # 1 call: /api/dashboard/summary
│   ├── (admin)/brokers/page.tsx
│   ├── (admin)/brokers/[id]/page.tsx     # 1 call: /api/brokers/:id/detail
│   ├── (admin)/form/page.tsx
│   ├── (admin)/distribution/page.tsx     # 2 parallel calls
│   ├── (admin)/distribution/[id]/page.tsx# 1 call: /api/distribution/detail
│   ├── (admin)/leads/page.tsx            # 2 parallel calls
│   └── ops/page.tsx                      # Tier 2, 1 call
├── actions/                              # Server Actions + revalidatePath
├── lib/{api-client,auth}.ts              # named fetchers (request-memoization friendly)
├── src/types/api-contract.d.ts           # GENERATED from backend contracts (committed)
├── next.config.js                        # staleTimes.dynamic = 0
└── package.json
```

**Structure Decision**: Two sibling application folders matching the mandated
two-repo deliverable — `backend/` (Express + Prisma + worker, Clean
Architecture rings visible in the tree, lint-enforced) and `frontend/`
(Next.js BFF whose Server Components/Actions call the backend server-side;
exactly one public Route Handler kept for edge-side IP capture). The generated
contract declaration file is the only artifact duplicated across the two
trees, produced by `contracts:build` in the backend and copied by
`contracts:sync`, with hash-drift checks in CI and a pre-push hook.

## Complexity Tracking

> No constitution violations to justify — table intentionally left empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
