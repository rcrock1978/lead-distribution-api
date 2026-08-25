/**
 * Closed event taxonomy (Constitution IV). New events MUST extend this union —
 * a typo'd event string is then a compile error, keeping the vocabulary
 * greppable across all three processes.
 */
export const EVENTS = [
  // HTTP surface
  'http.request',
  'http.response',

  // Auth
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.logout',

  // Configuration writes
  'form.created',
  'distribution.created',
  'distribution.members.replaced',
  'broker.created',
  'broker.updated',
  'broker.deleted',

  // Lead lifecycle
  'lead.captured',
  'lead.capture.failed',
  'lead.routed',
  'lead.unsent',
  'lead.duplicate',
  'lead.manually_assigned',
  'lead.retried',
  'broker.excluded',

  // Outbox / messaging
  'outbox.published',
  'outbox.claimed',
  'outbox.processed',
  'outbox.failed',
  'outbox.dead',
  'outbox.replayed',
  'outbox.reaped',
  'outbox.stale_reclaimed',

  // Config cache (version-gated decorator)
  'config.cache.refreshed',
  'config.cache.cleared',

  // Worker lifecycle & maintenance
  'worker.started',
  'worker.heartbeat.beat',
  'purge.completed',
] as const;

export type EventName = (typeof EVENTS)[number];
