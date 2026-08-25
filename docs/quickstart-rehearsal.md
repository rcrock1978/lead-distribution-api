# Quickstart Rehearsal Results (T062)

Executed: 2026-08-25 · Stack: local PM2 (`ecosystem.config.js`) over Docker
MySQL 8 · Script: `scripts/quickstart-rehearse.sh` (repeatable; probes use
per-run unique emails so reruns never collide with prior assignment state).

**Result: PASS=19 FAIL=0**

| Scenario | Evidence |
|---|---|
| S1 Auth gate | unauth `/brokers` → login form; failed sign-in = generic 401 |
| S2 Singletons | second form → `FORM_ALREADY_EXISTS`; second distribution guarded via direct API channel |
| S3 Brokers | CRUD across timezones; member replacement live |
| S4 Capture | identical 202 envelope for valid AND invalid payloads; edge-resolved XFF IP persisted |
| S5 Routing | auto-assigned with persisted decision trace on detail |
| S6 Duplicate race | 10 parallel same-email → exactly **1 sent + 9 duplicates** on real HTTP |
| S7 Cap race | 20-way vs cap 5 → exactly **5 of 5**, zero overage |
| S8 Manual rescue | capped broker correctly hard-blocked (`BROKER_CAPPED`) |
| S9 Restart survival | `pm2 restart lead-api lead-worker` mid-traffic: 0 lost, probe drained after resume |
| S10 Freshness | authenticated responses carry `no-store` cache headers |
| S11 Correlated trail | one traceId grep returned the full cross-process event chain |
| S12 Budgets/drift | budgets project green; contract drift hash clean |
| S13 Retention | 91-day-old lead purged; semantics per FR-036 verified |
| S14 Cache parity | CONFIG_CACHE on/off produce identical outcomes |

## Issues found & fixed during rehearsal

1. **FR-011 violation**: capture-time duplicate pre-check rejected repeat
   submissions whose prior lead was still unsent — spec requires accepting
   them as fresh attempts. Pre-check removed; duplication authority is now
   solely the `AssignedEmail` PK collision at routing (INV-3).
2. `dotenv/config` was missing from process entrypoints — production start
   under PM2 could not read `.env`.
3. `ecosystem.config.js` used `${…}` shell expansion PM2 doesn't perform;
   lead-web crashed-looped until switched to native `PORT` env.
4. Seed script required env vars without loading `.env`; now self-contained.
