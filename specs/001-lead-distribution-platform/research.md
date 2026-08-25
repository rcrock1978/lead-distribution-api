# Research: Lead Distribution Platform

**Feature**: 001-lead-distribution-platform | **Date**: 2026-08-25
**Status**: Complete — all Technical Context unknowns resolved.

Each entry records the decision, why, and what else was considered. Decisions
marked *(PRD)* are carried verbatim from the source PRD (v5) and recorded here
so the rationale survives alongside them.

## D1. Test runner

**Decision**: Vitest for all suites (domain unit, application unit with
in-memory fakes, integration against real MySQL, concurrency via parallel HTTP,
budget assertions).
**Rationale**: First-class TypeScript/ESM without build config; fast watch
cycles matter in a 3-day window; per-file parallelism is easy to disable for
MySQL-touching suites.
**Alternatives considered**: Jest (heavier TS/ESM configuration, slower
startup); node:test (zero deps but weaker mocking/DX).

## D2. Shared API contract types across two repositories

**Decision** *(PRD §9.3)*: Backend Zod schemas in `src/contracts/index.ts` are
the single source of truth. `contracts:build` emits
`dist/api-contract.d.ts` (`tsc --emitDeclarationOnly`); `contracts:sync` copies
it into `frontend/src/types/api-contract.d.ts` where it is committed. CI and a
pre-push hook hash the generated file and fail on mismatch with the frontend's
committed copy.
**Rationale**: Delivers the actual goal — a backend shape change breaks the
frontend build instead of surfacing as runtime `undefined`.
**Alternatives considered**: Monorepo workspace package (correct but precluded
by the two-public-repos deliverable); versioned npm package (adds a publish
step to every schema change during the build window — rejected, revisit if the
project outlives it); hand-written duplicated types (rot silently).

## D3. Rate limiting and anti-bot on public submissions

**Decision**: `express-rate-limit` mounted ONLY on `/api/public/*`, keyed by
source IP, `windowMs=60000`, `limit` from env `PUBLIC_RATE_LIMIT_PER_MIN`
(default 30 — per clarified spec FR-012, deliberately above the mandated
concurrency-test burst of 20). Plus an invisible honeypot field checked before
the limiter.
**Rationale**: Battle-tested tiny dependency beats hand-rolling; scoped to
public routes so admin traffic never pays for it.
**Alternatives considered**: Custom token bucket (~40 lines, more code to
defend); unbounded public POST (invites scanner abuse of the one open
endpoint).

## D4. Data retention and purge scheduling

**Decision**: Nightly maintenance task inside the worker process (no cron/
systemd available — no sudo): batched deletes (`LIMIT 500` loops) of Lead rows
older than 90 days (FR-036) and Outbox rows `DONE` older than 7 days;
`AssignedEmail` rows are never deleted. Batch loop until fewer rows than the
batch size are affected.
**Rationale**: Bounded batches avoid long lock times on InnoDB; running inside
the worker reuses its lifecycle and heartbeat visibility.
**Alternatives considered**: External cron/systemd timer (requires sudo);
ad-hoc purge on admin action (violates "automatic" in FR-036); unbounded
retention (privacy exposure accepted in clarify session was explicitly NOT
chosen by the user).

## D5. Authentication model

**Decision** *(PRD §17.2, §17.4)*: JWT HS256, 24h expiry, httpOnly +
SameSite=Lax cookie set by the backend only; bcrypt cost 12; seeded admin
credentials from env. Middleware verifies signature only — NO database lookup;
Next middleware checks cookie presence purely as a UX redirect, documented as
not a security control. Generic 401s everywhere; no user enumeration.
**Rationale**: Removes a per-request database round trip from every
authenticated call; acceptable trade-off (no server-side revocation) for one
seeded admin — stated rather than hidden.
**Alternatives considered**: Session table + cookie lookup (per-request DB
hit); `tokenVersion` claim check (reintroduces the lookup — documented future
decision if real user churn appears).

## D6. Structured logging

**Decision** *(PRD §13)*: pino behind a typed wrapper; newline-delimited JSON
to stdout in all three processes; closed event taxonomy as a string-literal
union (new events must extend the type); child loggers bind `requestId` +
`traceId`; redact paths strip `password`, `passwordHash`, `authorization`,
`cookie`, `token`, `DATABASE_URL`; emails masked; pretty-printing only in
development via pino-pretty.
**Rationale**: Fastest JSON logger in class; serializer-level redaction makes
careless spreads safe; typed events keep the vocabulary greppable.
**Alternatives considered**: Winston (slower, looser typing); hand-rolled
console JSON (no redaction tooling, no child-bindings performance work).

## D7. Timezone and clock handling

**Decision** *(PRD §8.1, §12.2.3)*: Luxon with a memoized `IANAZone` map keyed
by zone string; comparisons done in minutes-since-local-midnight so overnight
windows (`open > close`) wrap naturally; `Clock` port injected everywhere — no
ambient `Date.now()` in domain/application code.
**Rationale**: DST-correct zone math for free; memoization removes repeated
`Intl.DateTimeFormat` construction on the hot path; injected clocks make the
deficit selection suite run across three zones + a DST boundary without
fixtures.
**Alternatives considered**: date-fns-tz (equally capable, larger surface not
needed); Temporal (still not stable on Node 20).

## D8. Visitor IP capture

**Decision** *(PRD §8.2)*: The single Next.js Route Handler at the network edge
resolves the true client IP: leftmost `x-forwarded-for` → `x-real-ip` →
`cf-connecting-ip` → socket address; normalizes `::1` /
`::ffff:127.0.0.1` to `127.0.0.1`; never null. Forwarded to the backend as
`X-Client-IP`, accepted only when the request carries the shared internal
token. Stored on EVERY lead regardless of outcome.
**Rationale**: The backend sits behind loopback — extracting IP there would
record 127.0.0.1 for everyone; edge extraction is the only correct point.
**Alternatives considered**: Backend-only extraction (wrong data); trusting
client-supplied headers without internal-token gate (spoofable PII).

## D9. Lead list pagination and column pruning

**Decision** *(PRD §11.2)*: Keyset pagination on `(createdAt, id)` cursor,
`LIMIT n+1` to compute has-more without `COUNT(*)`; every list query uses an
explicit select that excludes `decisionTrace` (1–2KB/lead), which loads only
on detail endpoints. Covering indexes: `[status, createdAt]`,
`[brokerId, assignedAt]`, `[status, availableAt]` (outbox claim).
**Rationale**: Consistent page latency deep into history (SC-012 at 10k+ rows)
and smaller payloads.
**Alternatives considered**: OFFSET paging (linear degradation); returning
full entities then trimming (payload bloat).

## D10. Metrics registry

**Decision** *(PRD §14.2)*: In-process registry (~80 lines): counters, gauges,
histograms with rolling 1000-sample windows reporting p50/p95/p99; exposed via
admin-only `/api/ops/metrics`. Volatile by design — restart resets; durable
figures (outbox depth, lead counts) derived from the database on read.
**Rationale**: No Prometheus/Grafana installable (no external infra); volatile
numbers labelled volatile instead of pretending durability.
**Alternatives considered**: prom-client (pull model useless without a
scraper); shipping metrics externally (out of scope by spec).

## D11. Assignment serialization and concurrency safety

**Decision** *(PRD §6, §10)*: Single outbox worker (`instances: 1`) makes
assignment serialized BY CONSTRUCTION; `FOR UPDATE SKIP LOCKED` batch claims
keep multi-instance *correct* if ever scaled; cap enforcement stays a
conditional atomic UPDATE (`affectedRows = 0` → drop broker, re-select, max 3
attempts); duplicate detection = unique-key insert collision on
`AssignedEmail`. The v2-era advisory lock exists ONLY in the documented
`INLINE_WORKER=true` degraded fallback.
**Rationale**: Database predicates hold under ANY interleaving including
manual assignment; queue serialization removes the need for distributed locks.
**Alternatives considered**: Redis/BullMQ (infrastructure unavailable);
application-level mutexes (unsafe beyond one process); advisory locks on the
automatic path (redundant once a single consumer exists — removed).

## D12. Cross-process configuration invalidation

**Decision** *(PRD §12.2.2)*: One-row `ConfigVersion` table bumped INSIDE the
same transaction as any Form/Distribution/broker-link write; the cached
repository reads the version (single-PK read) before serving its cached join —
staleness bounded at ZERO across processes, no TTL. Cache lives in
infrastructure as a decorator over the repository port; `CONFIG_CACHE=false`
swaps it out at the composition root with identical behaviour (parity-tested).
Tier 2: cuttable.
**Rationale**: Two processes (API edits, worker routes) make naive TTL caches
silently wrong for commercial splits; the version gate is ~40 lines and
demonstrates cross-process invalidation without pub/sub infrastructure.
**Alternatives considered**: TTL cache (silent staleness — wrong failure
mode); Redis pub/sub (unavailable); always-fresh read (the one genuine hot-
path inefficiency this platform has).

## D13. Frontend caching posture

**Decision** *(PRD §12.3–12.4)*: Public form page fully static
(`force-static`) with on-demand `revalidatePath` after form create/rename;
admin layout `force-dynamic` + `fetchCache='only-no-store'` (cached fetch =
build error); Router Cache `staleTimes.dynamic = 0`; static assets immutable
by content hash; explicit HTTP cache classes: public form GET cacheable
(60s + SWR), everything authenticated `no-store, no-cache, must-revalidate,
private`, health endpoints `no-store`.
**Rationale**: Fan-out exists only on the public page; admin PII must be
unstorable anywhere (privacy requirement); `no-store` chosen over `no-cache`
because storage-with-revalidation still writes PII to disk.
**Alternatives considered**: `{ next: { revalidate: 60 } }` on admin data
(rejected — no fan-out, non-shared content, freshness is functional);
CDN/static hosting (no DNS control, single VPS).

## D14. Middleware chain ordering and budget

**Decision** *(PRD §17.4)*: Fixed order — requestId/logger binding → helmet →
cache-headers → internal-token guard (constant-time) → rate limiter (public
routes only) → body parser (64kb limit) → JWT verify (no DB) → router → error
handler. Prohibited in middleware: DB queries, bcrypt, sync crypto, body
serialization for logging. Budget asserted by test: p95 < 5ms measured by
`middleware_duration_ms` over 200 requests.
**Rationale**: Cheapest-and-most-likely-to-reject first means abusive requests
never pay for parsing or crypto; explicit prohibition list stops creep.
**Alternatives considered**: Ad-hoc ordering (every request pays maximum
cost); auth-with-user-lookup (a SELECT on every authenticated call).

## D15. Deployment topology

**Decision** *(PRD §18)*: PM2 ecosystem with three apps — `lead-api`
(`instances: 1`, 300M restart threshold), `lead-worker` (`instances: 1`
LOAD-BEARING, 200M, `exp_backoff_restart_delay: 200`), `lead-web` (400M,
public port); pm2-logrotate 10MB × 14 gzipped; Node 20 via nvm; migrations and
seed run from the backend checkout; frontend build AFTER the form exists if
static generation should prebuild (both orders correct, documented).
**Rationale**: No sudo rules out systemd/Docker/nginx; memory ceilings protect
a shared VPS; backoff prevents crash-loops hammering MySQL.
**Alternatives considered**: systemd units / Docker / nginx reverse proxy
(all require privileges or unavailable infra); multiple worker instances
(breaks serialization assumption — metrics registry too).
