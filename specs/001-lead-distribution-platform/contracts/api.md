# API Contracts: Lead Distribution Platform (backend)

**Date**: 2026-08-25 | **Owner**: `backend/src/contracts/index.ts` (Zod
schemas — the single source of truth; the TypeScript types in
`frontend/src/types/api-contract.d.ts` are GENERATED from these and drift-
checked in CI + pre-push. Never hand-edit the generated file.)

## Conventions

### Response envelope
Every JSON response:
```jsonc
{
  "success": true,                  // false on error
  "data": { … },                    // present when success
  "error": {                        // present when !success
    "code": "FORM_ALREADY_EXISTS",  // from the taxonomy below
    "message": "…",                 // user-safe; never a stack trace
    "details": { }                  // optional field-level errors
  },
  "traceId": "9f2c8a1e4b6d7038"     // always present, quote it in bug reports
}
```

### Auth model
- `POST /api/auth/login` sets an httpOnly, SameSite=Lax cookie (JWT, 24h).
  All `/api/*` routes except `/api/public/*`, `/api/health*` require it → 401
  `UNAUTHORIZED` otherwise.
- Requests forwarded from the frontend server MUST carry `X-Internal-Token`
  (constant-time compare). Missing/wrong token → 401 regardless of cookies.
- Login failures return generic 401 — no account enumeration.
- Rate limiting: `POST /api/public/leads` only — per source IP, configurable,
  default ≥ 30/min (`PUBLIC_RATE_LIMIT_PER_MIN`). Exceeded → 429 with
  `Retry-After`.

### Cache headers (set by middleware, per class)
| Route class | Header |
|---|---|
| `GET /api/public/form/:slug` | `public, max-age=60, stale-while-revalidate=300` |
| `POST /api/public/leads` | `no-store` |
| All admin `/api/*` and `/api/ops/*` | `no-store, no-cache, must-revalidate, private` |
| `/api/health*` | `no-store` |

## Error taxonomy

| Code | HTTP | Message |
|---|---|---|
| VALIDATION_ERROR | 422 | Field-level messages |
| UNAUTHORIZED | 401 | Please log in to continue. |
| FORM_ALREADY_EXISTS | 409 | A form already exists. Only one form can be created. |
| FORM_REQUIRED | 400 | Oops, please create a form first. |
| DISTRIBUTION_ALREADY_EXISTS | 409 | A distribution already exists. Only one distribution can be created. |
| DUPLICATE_LEAD | 409 | This email has already been assigned to a broker. |
| BROKER_CAPPED | 409 | This broker has reached its daily cap. |
| LEAD_NOT_ASSIGNABLE | 409 | Only unsent leads can be assigned. |
| SLUG_TAKEN | 409 | That URL slug is already in use. |
| BROKER_HAS_LEADS | 409 | This broker has assigned leads. Deactivate it instead. |
| NOT_FOUND | 404 | The requested resource does not exist. |
| RATE_LIMITED | 429 | Too many submissions. Please try again shortly. |
| INTERNAL_ERROR | 500 | Something went wrong. Please try again. |

Unknown throws map to `INTERNAL_ERROR`; the stack is logged (with traceId),
never returned.

---

## Auth

### POST /api/auth/login
Request `{ email, password }` → 200 `{ data: { user: { id, email } } }` +
Set-Cookie. Failure: generic 401. Audit events: `auth.login.succeeded|.failed`
(email masked).

### POST /api/auth/logout
Clears cookie → 200. (No server-side revocation — documented trade-off.)

### GET /api/auth/me
→ `{ data: { id, email } }` | 401.

## Brokers (admin)

### GET /api/brokers
Query: none (full list; broker count is small) → array of:
```
BrokerResponse { id, name, isActive, dailyCap, timezone, openingTime,
                 closingTime, workingDays[], sentToday, isOpenNow, isCapped }
```

### POST /api/brokers
Request BrokerInput (validation per data-model.md) → 201 BrokerResponse.
Errors: 422 VALIDATION_ERROR.

### GET /api/brokers/:id → BrokerResponse | 404
### PATCH /api/brokers/:id → BrokerResponse (partial input)
Config writes bump ConfigVersion in-tx.

### DELETE /api/brokers/:id
→ 204 if unused; **409** if the broker holds leads ("deactivate instead").

### GET /api/brokers/:id/detail   *(composite — replaces 3 calls)*
→ `{ broker: BrokerResponse, leads: LeadListItem[] (first page), todayStats: { assignedToday, capUsagePct } }`

## Form (admin)

### GET /api/form → FormResponse `{ id, name, slug, publicUrl, createdAt }` | `{ form: null }`
### POST /api/form
Request `{ name }` (slug auto-derived) → 201 FormResponse.
Errors: 409 `FORM_ALREADY_EXISTS`; 409 `SLUG_TAKEN` (retry derives another);
422. Bumps ConfigVersion.

## Distribution (admin)

### GET /api/distribution → DistributionResponse | null-shape before creation
### POST /api/distribution
Request `{ name, timezone }` (formId auto-bound) → 201.
Errors: 400 `FORM_REQUIRED` (exact message contract); 409
`DISTRIBUTION_ALREADY_EXISTS`. Bumps ConfigVersion.

### PUT /api/distribution/brokers
Replaces member set: `[{ brokerId, percentage, isActiveInDistribution }]` →
updated members. Bumps ConfigVersion in-tx.

### GET /api/distribution/detail   *(composite)*
→ `{ distribution, members: [{ brokerId, name, percentage, isActiveInDistribution, sentToday, isOpenNow, isCapped }], leadHistory: LeadListItem[] (first page), statusCounts: { sent, duplicate, unsent, failed } }`

### POST /api/distribution/simulate
Dry run against a hypothetical submission → selection result + trace; NO
writes, NO counter changes.

## Leads

### GET /api/leads   (admin)
Query: `status?`, `brokerId?`, `from?`, `to?`, `q?` (search name/email/phone),
`cursor?` (opaque keyset `(createdAt,id)`), `limit?` (default 50, max 100).
→ `{ items: LeadListItem[], nextCursor?: string }`.
`LeadListItem` = id, name, email, phone, ipAddress, status, brokerId?,
brokerName?, assignmentType?, failureReason?, createdAt — **decisionTrace
excluded by design** (payload budget).

### GET /api/leads/:id
Full detail incl. `decisionTrace` (per-exclusion rule + winner arithmetic) |
404.

### POST /api/leads/:id/assign
Request `{ brokerId }`. Manual claim under full invariants → SENT response.
Errors: 409 `DUPLICATE_LEAD`; 409 `BROKER_CAPPED`; 409
`LEAD_NOT_ASSIGNABLE`; closed/out-of-hours brokers are permitted deliberately.

### POST /api/leads/:id/retry
Re-enqueues failed/unsent routing → 202. Obey all routing rules on execution.

## Public (no auth)

### GET /api/public/form/:slug
→ `{ name, slug }` for rendering the intake page | 404 (unknown slugs served
from bounded negative cache, 30s TTL, cleared on form creation).

### POST /api/public/leads
Headers: `X-Client-IP` (edge-resolved; requires `X-Internal-Token`),
`X-Trace-Id` (generated at edge; echoed back).
Request `{ name, email, phone, website? }` — `website` is the honeypot and
must be empty.
→ **Always 202** with the SAME body shape for sent/unsent/duplicate outcomes
(visitor must never learn which):
`{ data: { received: true }, traceId }`.
Validation failures: 422 (nothing persisted). Duplicate detection happens
asynchronously at assignment time; the visitor response never varies.
Rate limited per IP (see Conventions).

## Dashboard

### GET /api/dashboard/summary   *(composite — exactly one call for /dashboard)*
→ `{ setup: { hasForm, hasDistribution, brokerCount, workerHealthy },
     leadCounts: { sent, duplicate, unsent, failed },
     recentLeads: LeadListItem[10],
     worker: { lastBeatAt, ageSeconds, processedTotal, version } }`

## Health & Ops

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | /api/health | none | 200 liveness; no DB touch |
| GET | /api/health/ready | none | 200 if DB reachable ∧ migrations applied ∧ heartbeat < 60s; else 503 with reasons |
| GET | /api/ops/metrics | admin | Registry snapshot: counters, gauges, histograms (p50/p95/p99) incl. `middleware_duration_ms`, `config_cache_hits_total` |
| GET | /api/ops/outbox | admin | Depth by status, oldestPendingAgeMs, dead list w/ lastError |
| POST | /api/ops/outbox/:id/replay | admin | DEAD → PENDING; 200 replayed |
| GET | /api/ops/logs/tail | admin | Query `level?`, `event?`, `traceId?`, `n?` → last N structured events |

## Contract change protocol

1. Edit/add the Zod schema in `backend/src/contracts/index.ts`.
2. `npm run contracts:build && npm run contracts:sync` (in backend).
3. Commit the regenerated `frontend/src/types/api-contract.d.ts` in the same
   change set.
CI + pre-push hash-check fails any backend schema change that is not synced —
the frontend build then breaks at compile time, not production time.
