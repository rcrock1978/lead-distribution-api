import { describe, expect, it } from 'vitest';

import { Broker } from '@/src/domain/entities/broker.entity';
import type { BrokerState } from '@/src/domain/entities/broker.entity';
import {
  selectBroker,
} from '@/src/domain/services/select-broker';
import { ZonedInstant } from '@/src/domain/value-objects/zoned-instant';

/**
 * DOMAIN UNIT SUITE — Constitution II gate. Zero database, zero fixtures,
 * millisecond-fast. Zone math arrives as PRE-COMPUTED primitives (the
 * injected Clock's job); these tests hand-build ZonedInstant parts.
 */

let seq = 0;
function mk(pct: number, overrides: Partial<BrokerState> = {}): BrokerState {
  seq += 1;
  return {
    id: overrides.id ?? seq,
    name: overrides.name ?? `broker-${seq}`,
    isActive: true,
    isActiveInDistribution: true,
    dailyCap: 0,
    timezone: 'UTC',
    openingTime: '08:00',
    closingTime: '18:00',
    workingDays: [1, 2, 3, 4, 5],
    percentage: pct,
    sentToday: 0,
    ...overrides,
  };
}

/** Hand-projected instant (what LuxonClock would produce for these inputs). */
function zi(
  epochMs: number,
  zone: string,
  minutesSinceMidnight: number,
  isoWeekday: number,
  localDateIso = '2026-08-25',
): ZonedInstant {
  const hh = String(Math.floor(minutesSinceMidnight / 60)).padStart(2, '0');
  const mm = String(minutesSinceMidnight % 60).padStart(2, '0');
  return ZonedInstant.fromParts(
    epochMs,
    zone,
    localDateIso,
    minutesSinceMidnight,
    isoWeekday,
    `${hh}:${mm}`,
  );
}

// Anchors (verified against the IANA database):
const TUE_09_MANILA = Date.UTC(2026, 7, 25, 1, 0); // Manila Tue 09:00 / London Tue 02:00 BST / NY Mon 21:00 EDT
const DST_SPRING_NY = Date.UTC(2026, 2, 8, 7, 0); // NY Sun 2026-03-08 03:00 EDT (after spring-forward)
const DST_FALL_NY = Date.UTC(2026, 10, 1, 6, 0); // NY Sun 2026-11-01 01:00 EST (second occurrence)

describe('selectBroker — fair-share deficit selection', () => {
  it('routes by highest deficit on the worked 50/30/20 example', () => {
    const candidates = [
      { broker: new Broker(mk(50, { id: 1, sentToday: 4 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
      { broker: new Broker(mk(30, { id: 2, sentToday: 3 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
      { broker: new Broker(mk(20, { id: 3, sentToday: 2 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
    ];
    const result = selectBroker(candidates, 9, 'Asia/Manila');
    expect(result.outcome).toBe('selected');
    if (result.outcome !== 'selected') return;
    expect(result.brokerId).toBe(1);
    expect(result.trace.winner).toEqual({
      brokerId: 1,
      targetPct: 50,
      targetAfterLead: 5,
      sentTodayBefore: 4,
      deficit: 1,
    });
    expect(result.trace.exclusions).toEqual([]);
    expect(result.trace.totalSentBefore).toBe(9);
  });

  it('breaks exact ties by fewer-sent-today, then ascending id', () => {
    const tied = [
      { broker: new Broker(mk(50, { id: 7, sentToday: 2 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
      { broker: new Broker(mk(50, { id: 3, sentToday: 2 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
    ];
    const byId = selectBroker(tied, 3, 'UTC');
    expect(byId.outcome === 'selected' && byId.brokerId).toBe(3);

    const fewerSentWins = [
      { broker: new Broker(mk(50, { id: 1, sentToday: 4 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
      { broker: new Broker(mk(50, { id: 9, sentToday: 2 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
    ];
    const r = selectBroker(fewerSentWins, 6, 'UTC');
    expect(r.outcome === 'selected' && r.brokerId).toBe(9);
  });

  it('an all-negative-deficit field still selects least-over (closest to share)', () => {
    const candidates = [
      { broker: new Broker(mk(50, { id: 1, sentToday: 8 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
      { broker: new Broker(mk(30, { id: 2, sentToday: 4 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
      { broker: new Broker(mk(20, { id: 3, sentToday: 3 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
    ];
    // Pool grows 11→12: targets 6.0 / 3.6 / 2.4 → deficits −2 / −0.4 / −0.6
    const r = selectBroker(candidates, 11, 'UTC');
    expect(r.outcome).toBe('selected');
    if (r.outcome === 'selected') expect(r.brokerId).toBe(2);
    if (r.outcome === 'selected') expect(r.trace.winner?.deficit).toBe(-0.4);
  });

  it('excludes zero-percentage members by rule', () => {
    const candidates = [
      { broker: new Broker(mk(100, { id: 1, sentToday: 0 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
      { broker: new Broker(mk(0, { id: 2 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) },
    ];
    const r = selectBroker(candidates, 0, 'UTC');
    expect(r.outcome === 'selected' && r.brokerId).toBe(1);
    expect(r.trace.exclusions).toEqual([{ brokerId: 2, rule: 'zero_pct' }]);
  });

  it('names a rule for EVERY ineligible broker when nobody qualifies', () => {
    const candidates = [
      { broker: new Broker(mk(50, { id: 1, isActive: false })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) }, // inactive
      { broker: new Broker(mk(30, { id: 2, dailyCap: 2, sentToday: 2 })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) }, // capped
      { broker: new Broker(mk(20, { id: 3, workingDays: [1] })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) }, // off_day (Tuesday)
      { broker: new Broker(mk(20, { id: 4, openingTime: '10:00' })), nowInBrokerZone: zi(TUE_09_MANILA, 'UTC', 540, 2) }, // closed
    ];
    const r = selectBroker(candidates, 0, 'UTC');
    expect(r.outcome).toBe('none');
    if (r.outcome !== 'none') return;
    expect(r.reason).toBe('NO_ELIGIBLE_BROKER');
    expect(r.trace.exclusions).toEqual([
      { brokerId: 1, rule: 'inactive' },
      { brokerId: 2, rule: 'capped' },
      { brokerId: 3, rule: 'off_day' },
      { brokerId: 4, rule: 'closed' },
    ]);
    expect(r.trace.winner).toBeNull();
  });

  it('honours overnight windows (22:00–06:00 wraps midnight)', () => {
    const b = new Broker(mk(100, { id: 1, openingTime: '22:00', closingTime: '06:00' }));
    expect(b.canReceiveAt(zi(TUE_09_MANILA, 'UTC', 300, 2))).toEqual({ eligible: true }); // 05:00
    expect(b.canReceiveAt(zi(TUE_09_MANILA, 'UTC', 1380, 2))).toEqual({ eligible: true }); // 23:00
    const closed = b.canReceiveAt(zi(TUE_09_MANILA, 'UTC', 600, 2)); // 10:00
    expect(closed).toEqual({ eligible: false, rule: 'closed' });
  });
});

describe('selectBroker — zone projections (injected-clock equivalents)', () => {
  it('evaluates three timezones independently at one epoch', () => {
    const candidates = [
      { broker: new Broker(mk(50, { id: 1, timezone: 'Asia/Manila' })), nowInBrokerZone: zi(TUE_09_MANILA, 'Asia/Manila', 540, 2) },
      { broker: new Broker(mk(30, { id: 2, timezone: 'Europe/London', openingTime: '01:30', closingTime: '03:00' })), nowInBrokerZone: zi(TUE_09_MANILA, 'Europe/London', 120, 2) },
      { broker: new Broker(mk(20, { id: 3, timezone: 'America/New_York', openingTime: '20:00', closingTime: '22:00', workingDays: [1], percentage: 100 })), nowInBrokerZone: zi(TUE_09_MANILA, 'America/New_York', 1260, 1) },
    ];
    const r = selectBroker(candidates, 0, 'Asia/Manila');
    // All three eligible: NY is on ITS Monday at 21:00 while others are Tuesday.
    expect(r.trace.exclusions).toEqual([]);
    expect(r.outcome === 'selected').toBe(true);
  });

  it('survives the DST spring-forward boundary with correct local minutes', () => {
    const nySunday = new Broker(mk(100, { id: 1, timezone: 'America/New_York', workingDays: [1, 2, 3, 4, 5, 6, 7] }));
    // 2026-03-08 07:00Z = 03:00 EDT (minutes 180 — NOT the skipped 02:xx).
    const duringGap = nySunday.canReceiveAt(zi(DST_SPRING_NY, 'America/New_York', 180, 7));
    expect(duringGap).toEqual({ eligible: false, rule: 'closed' }); // before 08:00 open

    const earlyWindow = new Broker(mk(100, { id: 2, timezone: 'America/New_York', workingDays: [7], openingTime: '00:30', closingTime: '04:00' }));
    expect(earlyWindow.canReceiveAt(zi(DST_SPRING_NY, 'America/New_York', 180, 7))).toEqual({ eligible: true });
  });

  it('projects the fall-back repeat hour as EST (60, not 120 minutes)', () => {
    const b = new Broker(mk(100, { id: 1, timezone: 'America/New_York', workingDays: [7], openingTime: '00:45', closingTime: '01:30' }));
    // 2026-11-01 06:00Z = 01:00 EST (second 1am). Window [00:45,01:30) contains it.
    expect(b.canReceiveAt(zi(DST_FALL_NY, 'America/New_York', 60, 7))).toEqual({ eligible: true });
  });
});
