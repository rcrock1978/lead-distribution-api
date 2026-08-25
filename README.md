# lead-api (backend)

Express + Prisma + MySQL API and routing worker for the Lead Distribution
Platform. The full product story lives in `specs/001-lead-distribution-platform/`;
`quickstart.md` there is the source of truth for every verification step.

## Stack

Node 20 · TypeScript (CommonJS) · Express 5 · Prisma + MySQL 8 · pino ·
Vitest · PM2 (process manager, `instances:1` worker is load-bearing).

## Clean-machine setup

```sh
nvm install 20 && nvm use 20          # Node 20 required
docker run -d --name lead-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=rootdev \
  -e MYSQL_DATABASE=lead_platform \
  -e MYSQL_USER=lead -e MYSQL_PASSWORD=leaddev mysql:8

npm ci
cp .env.example .env                  # then edit values (see below)
npx prisma migrate deploy
npm run seed                          # creates admin + ConfigVersion row
npm run build
```

### Environment (`backend/.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MySQL DSN incl. `connection_limit` (API 8 / worker 4) |
| `JWT_SECRET` | HS256 signing key (32+ chars) |
| `INTERNAL_API_TOKEN` | Shared secret the frontend BFF must present |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Provisioned at seed time |
| `PUBLIC_RATE_LIMIT_PER_MIN` | Public capture ceiling, default 30 |
| `JWT_EXPIRES_IN` | Session token lifetime (`24h`) — cookie max-age follows |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` / `OUTBOX_MAX_ATTEMPTS` | Worker queue tuning (500 / 10 / 5) |
| `CONFIG_CACHE` | Enables version-gated config cache decorator |
| `INLINE_WORKER` | `true` runs the consumer inside the API process |

**Review credentials** come from `.env.example` defaults — never commit real
values (FR-034). Secret scan before delivery:
`gitleaks detect --source . --redact` (see `docs/security-checklist.md`).

## Run

```sh
npm run start          # lead-api on 127.0.0.1:4000
npm run start:worker   # lead-worker (NO http listener)
```

or via PM2 from the repo root: `pm2 start ecosystem.config.js && pm2 save`.
Restart survival is a spec guarantee — `pm2 restart all` must never lose
leads (SC-011).

## Reading logs

Every process writes newline-delimited JSON to stdout (PM2 routes it through
pm2-logrotate, 10MB × 14 gzip). Each line carries `event`, `msg`, `level`,
`requestId`, and usually `traceId`.

```sh
pm2 logs lead-api --out --raw | jq 'select(.event=="lead.routed")'
```

Event vocabulary is a closed union in `src/infrastructure/observability/events.ts`.

## Tracing one lead by correlation id

1. Grab the `traceId` from any row/detail (`GET /api/leads/:id` → `traceId`),
   or from the visitor-facing 202 response.
2. One grep spans all processes:

   ```sh
   pm2 logs --out --raw --nostream | grep '"traceId":"<32-hex>"'
   ```

   Expected chain: edge POST → `lead.captured` → `lead.routed` /
   `lead.duplicate` / `lead.unsent`, sharing the id across rows too.

## Contract types

Backend Zod schemas are the single source of truth. After changing
`src/contracts/index.ts`:

```sh
npm run contracts:build && npm run contracts:sync   # updates ../lead-distribution-web/src/types/api-contract.d.ts
```

Commit the regenerated file in the same change set; CI fails on drift.

## Tests

```sh
npx vitest run            # everything (unit + integration + concurrency + budgets)
npx vitest run --project integration
```

Integration/concurrency suites use a scratch database
(`lead_platform_test`) created automatically; Docker Desktop must be running.

## Access URLs

- Admin UI: `http://localhost:3000/login` (frontend repo serves this API)
- Ops console: `http://localhost:3000/ops`
- Health: `http://127.0.0.1:4000/api/health`, readiness at `/api/health/ready`
