import { describe, expect, it } from 'vitest';

import type { Clock } from '@/src/application/ports/clock.port';
import type {
  BrokerCandidate,
  RoutingBrokerRepository,
} from '@/src/application/ports/routing-ports';
import type { CapGate } from '@/src/application/ports/routing-ports';
import type { EmailGuard } from '@/src/application/ports/routing-ports';
import type {
  LeadRoutingRecord,
  RoutingLeadRepository,
} from '@/src/application/ports/routing-ports';
import type {
  TransactionClient,
  UnitOfWork,
} from '@/src/application/ports/db.port';
import type { BrokerState } from '@/src/domain/entities/broker.entity';
import type { SelectionTrace } from '@/src/domain/services/select-broker';
import { ZonedInstant } from '@/src/domain/value-objects/zoned-instant';
import { RouteLeadUseCase } from '@/src/application/use-cases/route-lead.use-case';
import type { RouteLeadMessage } from '@/src/application/use-cases/route-lead.use-case';

// ---------------------------------------------------------------------------
// In-memory fakes — the ONLY infrastructure these tests touch.
// ---------------------------------------------------------------------------

class FakeUow implements UnitOfWork {
  run<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return work({} as unknown as TransactionClient);
  }
}

/** Fixed instant with hand-projected zone parts (same trick as domain tests). */
class FakeClock implements Clock {
  private readonly parts = new Map<string, ZonedInstant>();

  constructor(
    private readonly fixedUtc: Date = new Date('2026-08-25T01:00:00.000Z'),
    defaultParts: Array<{
      zone: string;
      date: string;
      minutes: number;
      weekday: number;
    }> = [],
  ) {
    for (const p of defaultParts) {
      const hh = String(Math.floor(p.minutes / 60)).padStart(2, '0');
      const mm = String(p.minutes % 60).padStart(2, '0');
      this.parts.set(
        p.zone,
        ZonedInstant.fromParts(
          this.fixedUtc.getTime(),
          p.zone,
          p.date,
          p.minutes,
          p.weekday,
          `${hh}:${mm}`,
        ),
      );
    }
  }

  nowInZone(zone: string): ZonedInstant {
    return (
      this.parts.get(zone) ??
      ZonedInstant.fromParts(
        this.fixedUtc.getTime(),
        zone,
        '2026-08-25',
        60,
        2,
        '01:00',
      )
    );
  }

  fromEpochMs(epochMs: number, zone: string): ZonedInstant {
    const base = this.nowInZone(zone);
    return ZonedInstant.fromParts(
      epochMs,
      base.zone,
      base.localDateIso,
      base.minutesSinceMidnight,
      base.isoWeekday,
      base.localTimeHhMm,
    );
  }

  utcNow(): Date {
    return this.fixedUtc;
  }
}

class FakeLeads implements RoutingLeadRepository {
  rows = new Map<number, LeadRoutingRecord>();
  sentCalls = 0;
  duplicateCalls = 0;
  unsentCalls = 0;

  seed(row: LeadRoutingRecord): void {
    this.rows.set(row.id, row);
  }

  async findById(id: number): Promise<LeadRoutingRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async markSent(
    id: number,
    brokerId: number,
    assignedAtIso: string,
    assignmentType: 'AUTO' | 'MANUAL',
    trace: SelectionTrace,
  ): Promise<void> {
    this.sentCalls += 1;
    const row = this.rows.get(id);
    if (!row) throw new Error(`markSent: lead ${id} missing`);
    Object.assign(row, {
      status: 'SENT',
      brokerId,
      assignedAtIso,
      assignmentType,
      decisionTrace: trace,
    });
  }

  async markDuplicate(
    id: number,
    reason: string,
    trace: SelectionTrace & { duplicateOfBrokerId?: number },
    priorBrokerId: number | null,
  ): Promise<void> {
    this.duplicateCalls += 1;
    const row = this.rows.get(id);
    if (!row) throw new Error(`markDuplicate: lead ${id} missing`);
    Object.assign(row, {
      status: 'DUPLICATE',
      brokerId: priorBrokerId,
      failureReason: reason,
      decisionTrace: trace,
    });
  }

  async markUnsentReason(
    id: number,
    reason: string,
    trace: SelectionTrace,
  ): Promise<void> {
    this.unsentCalls += 1;
    const row = this.rows.get(id);
    if (!row) throw new Error(`markUnsentReason: lead ${id} missing`);
    Object.assign(row, {
      status: 'UNSENT',
      brokerId: null,
      failureReason: reason,
      decisionTrace: trace,
    });
  }
}

function brokerState(overrides: Partial<BrokerState> & { id: number }): BrokerState {
  return {
    name: `b${overrides.id}`,
    isActive: true,
    isActiveInDistribution: true,
    dailyCap: 100,
    timezone: 'UTC',
    openingTime: '00:00',
    closingTime: '23:59',
    workingDays: [1, 2, 3, 4, 5, 6, 7],
    percentage: 50,
    sentToday: 0,
    ...overrides,
  };
}

class FakeBrokers implements RoutingBrokerRepository {
  states: BrokerState[] = [];
  distributionTimezone = 'UTC';
  totalSent = 0;

  constructor(states: BrokerState[] = []) {
    this.states = states;
  }

  async findCandidates(): Promise<BrokerCandidate[]> {
    return this.states.map((state) => ({
      state,
      nowInBrokerZone: this.fixedClockFor(state.timezone),
    }));
  }

  private fixedClockFor(zone: string): ZonedInstant {
    const hhmm =
      zone === 'Asia/Manila'
        ? { date: '2026-08-25', minutes: 540, weekday: 2 }
        : { date: '2026-08-25', minutes: 540, weekday: 2 };
    return ZonedInstant.fromParts(
      Date.UTC(2026, 7, 25, 1, 0),
      zone,
      hhmm.date,
      hhmm.minutes,
      hhmm.weekday,
      '09:00',
    );
  }

  async getDistributionTimezone(): Promise<string> {
    return this.distributionTimezone;
  }

  async getTotalSentToday(): Promise<number> {
    return this.totalSent;
  }
}

class FakeCapGate implements CapGate {
  /** Broker ids that LOSE the conditional-update race (refused forever). */
  alwaysRefuse = new Set<number>();
  /** Broker ids refused exactly once, then they succeed (one-shot race loss). */
  refuseOnce = new Set<number>();
  claimedSlots: Array<{ brokerId: number; localDateIso: string; cap: number }> = [];

  async tryClaimSlot(
    brokerId: number,
    localDateIso: string,
    cap: number,
  ): Promise<boolean> {
    if (this.alwaysRefuse.has(brokerId)) return false;
    if (this.refuseOnce.has(brokerId)) {
      this.refuseOnce.delete(brokerId);
      return false;
    }
    this.claimedSlots.push({ brokerId, localDateIso, cap });
    return true;
  }
}

class FakeEmailGuard implements EmailGuard {
  takenByEmail = new Map<string, number>();
  claims: Array<{ email: string; brokerId: number; leadId: number }> = [];

  async claim(
    email: string,
    brokerId: number,
    leadId: number,
  ): Promise<{ outcome: 'claimed' } | { outcome: 'taken'; priorBrokerId: number }> {
    const prior = this.takenByEmail.get(email);
    if (prior !== undefined) return { outcome: 'taken', priorBrokerId: prior };
    this.claims.push({ email, brokerId, leadId });
    this.takenByEmail.set(email, brokerId);
    return { outcome: 'claimed' };
  }
}

interface Harness {
  leads: FakeLeads;
  brokers: FakeBrokers;
  capGate: FakeCapGate;
  emailGuard: FakeEmailGuard;
}

function buildHarness(states: BrokerState[]): { useCase: RouteLeadUseCase } & Harness {
  const leads = new FakeLeads();
  const brokers = new FakeBrokers(states);
  const capGate = new FakeCapGate();
  const emailGuard = new FakeEmailGuard();
  const clock = new FakeClock(new Date('2026-08-25T01:00:00.000Z'), [
    { zone: 'UTC', date: '2026-08-25', minutes: 540, weekday: 2 },
    { zone: 'America/New_York', date: '2026-08-25', minutes: 540, weekday: 2 },
    { zone: 'Asia/Manila', date: '2026-08-25', minutes: 540, weekday: 2 },
  ]);
  const useCase = new RouteLeadUseCase({
    uow: new FakeUow(),
    leads,
    brokers,
    capGate,
    emailGuard,
    clock,
  });
  return { useCase, leads, brokers, capGate, emailGuard };
}

function msg(leadId: number, email = 'visitor@example.com'): RouteLeadMessage {
  return {
    messageId: `outbox-${leadId}`,
    traceId: 'a'.repeat(32),
    payload: { leadId, formId: 1, email },
  };
}

function unsentLead(id: number, email = 'visitor@example.com'): LeadRoutingRecord {
  return {
    id,
    formId: 1,
    email,
    status: 'UNSENT',
    brokerId: null,
    assignmentType: null,
    failureReason: null,
    decisionTrace: null,
  };
}

// ---------------------------------------------------------------------------

describe('RouteLeadUseCase', () => {
  it('acks a redelivered message without re-routing a SENT lead (idempotency)', async () => {
    const h = buildHarness([brokerState({ id: 1, percentage: 100 })]);
    h.leads.seed({
      ...unsentLead(10),
      status: 'SENT',
      brokerId: 1,
    });

    const outcome = await h.useCase.execute(msg(10));

    expect(outcome.kind).toBe('skipped');
    expect(h.leads.sentCalls).toBe(0);
    expect(h.capGate.claimedSlots).toHaveLength(0);
    expect(h.emailGuard.claims).toHaveLength(0);

    const dupOutcome = await (async () => {
      h.leads.seed({ ...unsentLead(11), status: 'DUPLICATE', brokerId: 1 });
      return h.useCase.execute(msg(11));
    })();
    expect(dupOutcome.kind).toBe('skipped');
    expect(h.leads.duplicateCalls).toBe(0);
  });

  it('marks the lead DUPLICATE when the AssignedEmail claim collides', async () => {
    const h = buildHarness([
      brokerState({ id: 1, percentage: 50 }),
      brokerState({ id: 2, percentage: 50 }),
    ]);
    h.leads.seed(unsentLead(20));
    // Guard contract: the use case claims with a NORMALIZED email; the raw
    // visitor input arrives mixed-case and must not bypass the collision.
    h.emailGuard.takenByEmail.set('visitor@example.com', 7);

    const outcome = await h.useCase.execute(msg(20, 'Visitor@Example.com'));

    expect(outcome.kind).toBe('duplicate');
    const row = h.leads.rows.get(20);
    expect(row?.status).toBe('DUPLICATE');
    expect(row?.brokerId).toBe(7);
    expect(row?.failureReason).toBe('DUPLICATE_EMAIL');
    const trace = row?.decisionTrace as SelectionTrace & { duplicateOfBrokerId?: number };
    expect(trace.duplicateOfBrokerId).toBe(7);
    // No NEW permanent claim was created for a duplicate email.
    expect(h.emailGuard.claims).toHaveLength(0);
  });

  it('re-selects within 3 attempts when the winner loses the cap race mid-selection', async () => {
    const h = buildHarness([
      brokerState({ id: 1, percentage: 70 }),
      brokerState({ id: 2, percentage: 30 }),
    ]);
    h.leads.seed(unsentLead(30));
    h.capGate.refuseOnce.add(1);

    const outcome = await h.useCase.execute(msg(30));

    expect(outcome.kind).toBe('assigned');
    if (outcome.kind !== 'assigned') return;
    expect(outcome.brokerId).toBe(2);
    const row = h.leads.rows.get(30);
    expect(row?.status).toBe('SENT');
    expect(row?.assignmentType).toBe('AUTO');
    const trace = row?.decisionTrace as SelectionTrace;
    expect(trace.exclusions.some((e) => e.brokerId === 1 && e.rule === 'capped')).toBe(
      true,
    );
    expect(h.capGate.claimedSlots).toEqual([
      { brokerId: 2, localDateIso: '2026-08-25', cap: 100 },
    ]);
    expect(h.emailGuard.claims[0]?.brokerId).toBe(2);
  });

  it('leaves the lead UNSENT after 3 consecutive cap-race losses', async () => {
    const h = buildHarness([
      brokerState({ id: 1, percentage: 50 }),
      brokerState({ id: 2, percentage: 30 }),
      brokerState({ id: 3, percentage: 20 }),
    ]);
    h.leads.seed(unsentLead(40));
    h.capGate.alwaysRefuse.add(1);
    h.capGate.alwaysRefuse.add(2);
    h.capGate.alwaysRefuse.add(3);

    const outcome = await h.useCase.execute(msg(40));

    expect(outcome.kind).toBe('unsent');
    if (outcome.kind !== 'unsent') return;
    expect(outcome.reason).toBe('CAP_CONTENTION_EXHAUSTED');
    expect(outcome.selectionAttempts).toBe(3);
    const row = h.leads.rows.get(40);
    expect(row?.status).toBe('UNSENT');
    expect(row?.failureReason).toBe('CAP_CONTENTION_EXHAUSTED');
    const trace = row?.decisionTrace as SelectionTrace;
    expect(trace.exclusions.filter((e) => e.rule === 'capped')).toHaveLength(3);
    expect(h.emailGuard.claims).toHaveLength(0);
  });

  it('leaves the lead UNSENT with NO_ACTIVE_BROKERS when nobody exists', async () => {
    const h = buildHarness([]);
    h.leads.seed(unsentLead(50));

    const outcome = await h.useCase.execute(msg(50));

    expect(outcome.kind).toBe('unsent');
    if (outcome.kind !== 'unsent') return;
    expect(outcome.reason).toBe('NO_ACTIVE_BROKERS');
    expect(outcome.selectionAttempts).toBe(1);
    const row = h.leads.rows.get(50);
    expect(row?.status).toBe('UNSENT');
    expect(row?.failureReason).toBe('NO_ACTIVE_BROKERS');
    expect(h.capGate.claimedSlots).toHaveLength(0);
  });

  it('assigns the highest-deficit broker on the happy path', async () => {
    const h = buildHarness([
      brokerState({ id: 1, percentage: 50, sentToday: 5 }),
      brokerState({ id: 2, percentage: 30, sentToday: 1 }),
      brokerState({ id: 3, percentage: 20, sentToday: 1 }),
    ]);
    h.brokers.totalSent = 7;
    h.leads.seed(unsentLead(60));

    const outcome = await h.useCase.execute(msg(60));

    expect(outcome.kind).toBe('assigned');
    if (outcome.kind !== 'assigned') return;
    // Targets after pool grows 7→8: 4.0 / 2.4 / 1.6 → deficits −1 / +1.4 / +0.6
    expect(outcome.brokerId).toBe(2);
    expect(h.leads.sentCalls).toBe(1);
    const trace = h.leads.rows.get(60)?.decisionTrace as SelectionTrace;
    expect(trace.winner?.deficit).toBe(1.4);
    expect(trace.totalSentBefore).toBe(7);
  });
});
