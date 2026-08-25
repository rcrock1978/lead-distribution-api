import type { ZonedInstant } from '../../domain/value-objects/zoned-instant';

/**
 * Injected time (Constitution II — no ambient Date.now() in domain or
 * application code). The infrastructure implementation projects instants into
 * IANA zones and hands the domain PURE value objects.
 */
export interface Clock {
  nowInZone(zone: string): ZonedInstant;
  fromEpochMs(epochMs: number, zone: string): ZonedInstant;
  utcNow(): Date;
}
