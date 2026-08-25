# Security Checklist — lead-api

Status legend: ✅ verified in this repository · 🔍 reviewer command · 📋 deployment-time action

## 1. Transport & headers

- ✅ `helmet()` is middleware #2 (after request-id correlation, before any
  router) — see `src/interfaces/http/app.ts`. Default headers include
  `X-Content-Type-Options`, `Strict-Transport-Security` (when TLS-terminated
  upstream), `X-Frame-Options`, and a conservative content-security policy.
  The API binds to **127.0.0.1 only** (`app.listen(env.PORT, '127.0.0.1')`);
  the browser never reaches it directly — the Next.js BFF is the sole edge.
- 🔍 Reviewer: `curl -s -D - -o /dev/null http://127.0.0.1:4000/api/health | grep -iE 'x-frame|x-content|content-security'`

## 2. Secrets & credentials

- ✅ No real credential is committed. Both apps ship `.env.example` files with
  placeholder values; `.gitignore` blocks `.env` / `.env.*`
  (root `.gitignore` lines 14–16).
- ✅ Logger redaction strips `password`, `passwordHash`, `authorization`,
  `cookie`, `token`, `DATABASE_URL` at the serializer level
  (`REDACT_PATHS` in `src/infrastructure/observability/logger.ts`), so even a
  careless spread of an env object cannot leak them into logs.
- ✅ Request bodies are NEVER logged anywhere in the middleware chain or
  controllers; structured events carry ids, emails (masked by the same
  redaction), and outcomes only.
- 🔍 Reviewer: `git log -p | grep -iE 'password\s*=\s*["'\''][^"'\'']+'` (expect no hits)
- 🔍 Reviewer (secret scan, FR-034): install [gitleaks](https://github.com/gitleaks/gitleaks)
  and run from the repo root before every delivery:

  ```sh
  gitleaks detect --source . --report-path /tmp/gitleaks-report.json --redact
  ```

  ✅ **Executed 2026-08-25 — result: `no leaks found`.** One finding was the
  deterministic test-only JWT placeholder in
  `tests/integration/helpers/test-app.ts`; dispositioned as a non-secret and
  allowlisted with rationale in `.gitleaksignore` (fingerprint recorded
  there). Re-run before every delivery and append the date to this section.

## 3. Auth model

- ✅ JWT HS256, 24h expiry, HttpOnly + SameSite=Lax cookie set ONLY by the
  backend; signature verified per request with NO database lookup
  (documented trade-off: no server-side revocation for the single seeded
  admin).
- ✅ Generic `401 UNAUTHORIZED` everywhere — no account-existence oracle.
- ✅ bcrypt cost 12 for the seeded credential; timing-safe comparison guards
  the internal token (`timing-safe-compare.ts`).

## 4. Internal-token boundary

- ✅ `/api/public/*` REQUIRES `X-Internal-Token` (constant-time compare) —
  spoofed `X-Client-IP` headers die here, protecting the integrity of stored
  IP addresses (FR-010). Everywhere else a present-but-wrong token rejects;
  absence is tolerated for direct admin curl-with-cookie use.
- 📋 Deployment: rotate `INTERNAL_API_TOKEN` + `JWT_SECRET` during provisioning
  (see README → Environment).

## 5. Input handling

- ✅ Every entry point parses input through Zod contracts
  (`src/contracts/index.ts`); failures return 422 without persistence.
- ✅ Body size ceiling 64 kb (`express.json({ limit: '64kb' })`).
- ✅ Rate limiting on `/api/public/*` only, keyed by edge-resolved IP,
  default ≥30/min (FR-012) with `Retry-After` on 429.

## 6. Data protection

- ✅ Emails masked in all machine-readable events; full addresses exist only
  in the admin-authenticated views that require them.
- ✅ IP addresses are captured once per lead (never null), displayed in
  admin-only views, and expire with their lead row at the 90-day purge;
  assignment-registry rows hold no PII beyond the normalized email needed
  for duplicate enforcement.
- ✅ Decision traces and audit views are admin-gated; list endpoints exclude
  the trace payload entirely.
