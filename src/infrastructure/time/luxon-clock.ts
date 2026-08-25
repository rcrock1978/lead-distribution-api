import { DateTime, IANAZone } from 'luxon';

import { AppError } from '../../domain/errors/app-error';
import { ZonedInstant } from '../../domain/value-objects/zoned-instant';
import { Clock } from '../../application/ports/clock.port';

/**
 * Luxon-backed Clock. IANAZone objects are MEMOIZED (immutable values —
 * one of the few caches Principle V permits).
 */
export class LuxonClock implements Clock {
  private readonly zones = new Map<string, IANAZone>();

  zoneFor(zone: string): IANAZone {
    const cached = this.zones.get(zone);
    if (cached !== undefined) return cached;

    const resolved = IANAZone.create(zone);
    if (!resolved.isValid) {
      throw new AppError('VALIDATION_ERROR', `Unknown IANA timezone: ${zone}`, {
        timezone: `Unknown IANA timezone: ${zone}`,
      });
    }
    this.zones.set(zone, resolved);
    return resolved;
  }

  isValidZone(zone: string): boolean {
    try {
      this.zoneFor(zone);
      return true;
    } catch {
      return false;
    }
  }

  nowInZone(zone: string): ZonedInstant {
    return this.fromEpochMs(Date.now(), zone);
  }

  fromEpochMs(epochMs: number, zone: string): ZonedInstant {
    const z = this.zoneFor(zone);
    const dt = DateTime.fromMillis(epochMs).setZone(z);
    const hhMm = `${String(dt.hour).padStart(2, '0')}:${String(dt.minute).padStart(2, '0')}`;
    return ZonedInstant.fromParts(
      epochMs,
      zone,
      dt.toISODate() as string,
      dt.hour * 60 + dt.minute,
      dt.weekday,
      hhMm,
    );
  }

  utcNow(): Date {
    return new Date();
  }
}
