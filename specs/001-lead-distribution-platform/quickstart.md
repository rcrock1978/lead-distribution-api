# Quickstart: Validating the Lead Distribution Platform

End-to-end validation guide for a reviewer on a clean machine. Every scenario
maps to acceptance criteria in [spec.md](./spec.md); shapes referenced here
are defined in [contracts/api.md](./contracts/api.md) and
[data-model.md](./data-model.md). Run scenarios in order — each builds state
for the next.

## Prerequisites

- Linux or macOS shell; Node.js 20 LTS (via nvm); a reachable MySQL 8 instance
  where you can create a database; `curl` and `jq`.
- No administrator/sudo rights required at any point.

## Setup

```bash
# backend
cd backend
npm ci
cp .env.example .env            # then fill: DATABASE_URL, JWT_SECRET,
                                # INTERNAL_API_TOKEN, SEED_ADMIN_EMAIL/PASSWORD,
                                # PUBLIC_RATE_LIMIT_PER_MIN (default 30)
npx prisma migrate deploy
npx prisma db seed              # creates the single admin from env
npm run build
npm run contracts:build         # emits dist/api-contract.d.ts

# frontend (separate repo/clone)
cd ../frontend
npm ci
cp .env.example .env            # BACKEND_URL (loopback), INTERNAL_API_TOKEN (match), public port
npm run build                   # build AFTER creating the form (Scenario 3)
                                # if you want /{slug} pre-rendered; either order is correct

pm2 start ecosystem.config.js && pm2 save   # three processes: lead-api, lead-worker, lead-web
pm2 status                       # expect all three "online"
curl -s localhost:$BACKEND_PORT/api/health/ready | jq   # expect {"success":true}
```

Set once for the snippets:
```bash
BASE=http://127.0.0.1:$BACKEND_PORT
WEB=http://127.0.0.1:$FRONTEND_PUBLIC_PORT
```

## Scenarios

### S1 — Auth gate (SC-007 support, FR-001/002)
```bash
curl -s $BASE/api/brokers | jq '.success'                    # expect false (401)
curl -s -c /tmp/cj -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"'$SEED_ADMIN_EMAIL'","password":"WRONG"}' | jq '.error.code'
                                                             # expect UNAUTHORIZED, generic message
curl -s -c /tmp/cj -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"'$SEED_ADMIN_EMAIL'","password":"'$SEED_ADMIN_PASSWORD'"}' | jq '.success'
                                                             # expect true; cookie jar now valid
```

### S2 — Singleton invariants via ANY channel (SC-007, INV-1/2, FR-003)
```bash
post() { curl -s -b /tmp/cj -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }
post /api/form '{"name":"Intake"}'        | jq '.success'    # true (first)
post /api/form '{"name":"Another"}'       | jq '.error.code' # FORM_ALREADY_EXISTS
post /api/distribution '{"name":"D","timezone":"Asia/Manila"}' | jq '.success'  # true
post /api/distribution '{"name":"D2","timezone":"UTC"}'        | jq '.error.code' # DISTRIBUTION_ALREADY_EXISTS
```
Repeat both second-attempts with the cookie REMOVED (`curl` without `-b`) and
with a direct call lacking `X-Internal-Token` — every path must fail
identically.

### S3 — Brokers configured across timezones (US-1)
Create three brokers via `POST /api/brokers`: A 50% cap 10 `Asia/Manila`
08:00–18:00 days 1–5; B 30% cap 10 `Europe/London`; C 20% cap 2
`America/New_York` overnight window 22:00–06:00. Then
`GET /api/brokers` → each shows correct `isOpenNow` for its local time.

### S4 — Capture + IP + uniform confirmation (SC-001/005, FR-008/010)
```bash
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
  -X POST $WEB/api/public/leads -H 'Content-Type: application/json' \
  -d '{"name":"Jane Doe","email":"JANE.Doe@Example.com ","phone":"+1 555 010 2030"}'
# expect 202, total < 2s; body identical to the one returned for a duplicate later
```
Admin `GET /api/leads?q=jane.doe@example.com` → lead exists, status `unsent`
or `sent`, **ipAddress non-null**, email stored lowercased/trimmed.

### S5 — Automatic deficit routing + trace (SC-002/006, FR-014/019)
Submit ~6 distinct emails over S4's endpoint. Within ~3s each flips `sent`.
For each: `GET /api/leads/:id` → `decisionTrace.exclusions[]` names a rule for
every ineligible broker and the winner entry carries
`targetAfterLead/sentTodayBefore/deficit`. Cross-check arithmetic by hand
against the 50/30/20 shares.

### S6 — Duplicate under concurrency (SC-003, INV-3)
```bash
seq 10 | xargs -P10 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST $WEB/api/public/leads -H 'Content-Type: application/json' \
  -d '{"name":"Dup Test","email":"dup.race@example.com","phone":"+1 555 010 0000"}'
sleep 3
curl -s -b /tmp/cj "$BASE/api/leads?q=dup.race@example.com" | jq '[.data.items[].status] | group_by(.) | map({(.[0]): length}) | add'
# expect exactly ONE "sent" (first batch) and NINE "duplicate" — never two sent
```

### S7 — Cap race under concurrency (SC-004, INV-4)
With broker C capped at 2 (set in S3): submit 20 distinct emails inside C's
open window while A/B are made temporarily ineligible (deactivate or set
percentage 0). Afterwards: C's `sentToday` ≤ 2 **exactly**; remaining leads
sit `unsent` with trace rule `capped`. Restore A/B.

### S8 — Manual rescue rules (US-4, FR-023)
Pick an `unsent` lead → `POST /api/leads/:id/assign {brokerId: B}` → `sent`,
`assignmentType: MANUAL`, `assignedAt` shown in B's timezone. Attempt manual
assign of any lead to a capped broker → 409 `BROKER_CAPPED`. Attempt assign of
a `duplicate` lead → 409 `LEAD_NOT_ASSIGNABLE`.

### S9 — Restart survival & queue drain (SC-011, INV-5)
Start 10 background submissions, immediately `pm2 restart all`. After
recovery: no lead lost (count before == count after); previously `unsent`
items drain to terminal states in order; `/api/health/ready` returns 200;
`GET /api/ops/outbox` shows zero stuck `PROCESSING` older than 5 minutes.

### S10 — Freshness & cache headers (SC-008, Principle V)
```bash
curl -sI -b /tmp/cj $BASE/api/leads | grep -i cache-control
# expect: no-store, no-cache, must-revalidate, private
```
Change broker A's percentage, then IMMEDIATELY re-open the distribution page
and submit a lead — routing uses the NEW percentage; worker log contains
`config.cache.refreshed` with the bumped version:
```bash
grep '"event":"config.cache.refreshed"' ~/.pm2/logs/lead-worker-out.log | tail -1
```

### S11 — Correlated trail for one lead (SC-009, FR-032)
Take any `traceId` from an API response, then:
```bash
grep "\"traceId\":\"$TRACE_ID\"" ~/.pm2/logs/*.log | jq -s 'sort_by(.ts) | map(.event)'
# expect the full ordered life, e.g.: http.request → lead.captured → outbox.published
#   → outbox.claimed → outbox.processed → lead.routed   (spanning api + worker logs)
```

### S12 — Budgets & contract drift (Principle VI gates)
```bash
# round trips per admin page (≤2, dashboard exactly 1):
#   enable http.request logging, load each admin page, count lines per render.
# middleware p95 < 5ms over 200 requests:
for i in $(seq 200); do curl -s -o /dev/null $BASE/api/health; done
curl -s -b /tmp/cj $BASE/api/ops/metrics | jq '.middleware_duration_ms.p95'   # < 5
```
Contract drift: change a field name in a backend contract schema, run
`npm run contracts:build`, do NOT sync → frontend `tsc` fails AND the CI/pre-
push hash check fails. Revert.

### S13 — Retention purge (SC-013, FR-036)
Insert (or age) a lead older than 90 days in a test database, trigger the
nightly maintenance task (worker startup or its admin trigger), then confirm:
lead gone from lists/detail; the matching `AssignedEmail` row STILL present —
resubmitting that email yields duplicate behaviour.

### S14 — Cache parity (Principle V gate)
Run the full test suite twice: `CONFIG_CACHE=true` and `CONFIG_CACHE=false`.
All results identical — otherwise the config cache is wrong.

## Teardown

```bash
pm2 delete all
```

## Where to look when something fails

| Symptom | First check |
|---|---|
| Readiness 503 | `/api/health/ready` reasons field; heartbeat age; migrations |
| Leads stuck unsent | `/api/ops/outbox` depth + dead letters; replay button |
| "Why this broker?" | Lead detail `decisionTrace`; `broker.excluded` events at debug |
| Wrong-looking assignment | Recompute deficits from trace fields; check timezone day boundaries |
