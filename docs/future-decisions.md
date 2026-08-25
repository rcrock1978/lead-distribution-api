# Future Decisions — deliberate deferrals (PRD §22)

These are NOT defects. Each is a documented decision with a trigger condition
for revisiting. Do not "fix" them without the trigger.

## Q12 — Shared API contract as a versioned npm package
- **Current**: sync script + CI drift hash (`contracts:build` / `contracts:sync`).
- **Trigger to revisit**: a second consumer of the API appears, or schema
  churn outlives the review window.
- **Then**: publish `@org/lead-api-contracts` from the backend repo; frontend
  depends on a pinned version; delete the sync script and drift check.

## Q13 — Server-side token revocation (`tokenVersion` claim)
- **Current**: stateless 24h JWT, no per-request DB lookup (§17.4 trade-off).
- **Trigger to revisit**: any real user churn — a second admin, forced
  logout-on-password-change, or an incident involving a leaked session.
- **Then**: add `tokenVersion INT @default(1)` on User, bump on credential
  change, verify against a cached user record (accepts the lookup §17.4
  rejected).

## Related deferrals carried from the PRD
| Decision | Trigger |
|---|---|
| Monorepo workspace for types | The two-public-repos constraint is lifted |
| Redis / external cache | Sustained traffic where config-cache savings matter |
| OpenTelemetry spans | Any external tracing backend becomes installable |
| Multi-worker outbox consumers | Volume exceeds one worker's drain rate (SKIP LOCKED already keeps it correct) |
