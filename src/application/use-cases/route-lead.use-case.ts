import type { UnitOfWork } from '../ports/db.port';
import type { Clock } from '../ports/clock.port';
import type {
  CapGate,
  CapLossExclusion,
  EmailGuard,
  RoutingBrokerRepository,
  RoutingLeadRepository,
} from '../ports/routing-ports';
import { Broker } from '../../domain/entities/broker.entity';
import type { SelectionTrace } from '../../domain/services/select-broker';
import { selectBroker } from '../../domain/services/select-broker';
import { normalizeEmail } from '../support/normalize-email';

export interface RouteLeadMessage {
  /** Outbox row id — the idempotency key for logging/observation. */
  messageId: string;
  traceId: string;
  payload: { leadId: number; formId: number; email: string };
}

export type RouteLeadOutcome =
  | { kind: 'assigned'; brokerId: number }
  | { kind: 'duplicate'; priorBrokerId: number | null }
  | { kind: 'unsent'; reason: string; selectionAttempts: number }
  | { kind: 'skipped'; reason: string };

/** Persisted trace shape: cap-race losses merge into the exclusion list. */
type PersistedTrace = SelectionTrace & { duplicateOfBrokerId?: number };

const MAX_SELECTION_ATTEMPTS = 3;

/**
 * US3 orchestration: outbox message → eligibility → selection → atomic
 * claims. Pure decision math lives in the domain (selectBroker); this class
 * only sequences ports and persists outcomes.
 *
 * Ordering inside the transaction:
 *   conditional counter slot FIRST (INV-4)…
 *   …then insert-only email claim (INV-3).
 * A duplicate collision aborts the surrounding transaction, so a burned slot
 * rolls back with it; the fakes in tests assert lead-level outcomes only.
 */
export class RouteLeadUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      leads: RoutingLeadRepository;
      brokers: RoutingBrokerRepository;
      capGate: CapGate;
      emailGuard: EmailGuard;
      clock: Clock;
    },
  ) {}

  async execute(message: RouteLeadMessage): Promise<RouteLeadOutcome> {
    return this.deps.uow.run(async () => {
      const { leadId } = message.payload;

      // Idempotent redelivery gate: SENT/DUPLICATE are terminal.
      const lead = await this.deps.leads.findById(leadId);
      if (!lead) return { kind: 'skipped', reason: 'LEAD_NOT_FOUND' };
      if (lead.status === 'SENT') return { kind: 'skipped', reason: 'ALREADY_SENT' };
      if (lead.status === 'DUPLICATE') {
        return { kind: 'skipped', reason: 'ALREADY_DUPLICATE' };
      }

      const capLosses: CapLossExclusion[] = [];

      for (
        let attempt = 1;
        attempt <= MAX_SELECTION_ATTEMPTS;
        attempt += 1
      ) {
        const [candidateRows, distributionTimezone, totalSentToday] =
          await Promise.all([
            this.deps.brokers.findCandidates(),
            this.deps.brokers.getDistributionTimezone(),
            this.deps.brokers.getTotalSentToday(),
          ]);

        const dropped = new Set(capLosses.map((l) => l.brokerId));
        const candidates = candidateRows
          .filter((c) => !dropped.has(c.state.id))
          .map((c) => ({
            broker: new Broker(c.state),
            nowInBrokerZone: c.nowInBrokerZone,
          }));

        const selection = selectBroker(
          candidates,
          totalSentToday,
          distributionTimezone,
        );

        if (selection.outcome === 'none') {
          // Nobody left to ask. If brokers were dropped by cap races this
          // run, name THAT as the reason rather than "no active brokers".
          const contested = capLosses.length > 0;
          const reason = contested
            ? 'CAP_CONTENTION_EXHAUSTED'
            : selection.reason;
          await this.deps.leads.markUnsentReason(
            leadId,
            reason,
            withCapLosses(selection.trace, capLosses),
          );
          return { kind: 'unsent', reason, selectionAttempts: attempt };
        }

        const winnerState = candidateRows.find(
          (c) => c.state.id === selection.brokerId,
        );
        if (!winnerState) {
          // Unreachable: selection can only return ids from the candidate set.
          throw new Error(
            `selection returned unknown broker ${selection.brokerId}`,
          );
        }

        const brokerNow = winnerState.nowInBrokerZone;
        const gotSlot = await this.deps.capGate.tryClaimSlot(
          winnerState.state.id,
          brokerNow.localDateIso,
          winnerState.state.dailyCap,
        );

        if (!gotSlot) {
          // Lost the race on the last slot (INV-4 predicate matched nothing):
          // drop this broker and re-select.
          capLosses.push({ brokerId: winnerState.state.id, rule: 'capped' });
          continue;
        }

        const assignedAtIso = this.deps.clock.utcNow().toISOString();
        const emailResult = await this.deps.emailGuard.claim(
          normalizeEmail(message.payload.email),
          winnerState.state.id,
          leadId,
          // assignedAt travels via markSent below; guard records provenance.
        );

        if (emailResult.outcome === 'taken') {
          const trace: PersistedTrace = {
            ...withCapLosses(selection.trace, capLosses),
            duplicateOfBrokerId: emailResult.priorBrokerId,
          };
          await this.deps.leads.markDuplicate(
            leadId,
            'DUPLICATE_EMAIL',
            trace,
            emailResult.priorBrokerId,
          );
          return {
            kind: 'duplicate',
            priorBrokerId: emailResult.priorBrokerId,
          };
        }

        await this.deps.leads.markSent(
          leadId,
          winnerState.state.id,
          assignedAtIso,
          'AUTO',
          withCapLosses(selection.trace, capLosses),
        );
        return { kind: 'assigned', brokerId: winnerState.state.id };
      }

      const [distributionTimezone, totalSentToday] = await Promise.all([
        this.deps.brokers.getDistributionTimezone(),
        this.deps.brokers.getTotalSentToday(),
      ]);
      const exhaustedTrace: PersistedTrace = {
        totalSentBefore: totalSentToday,
        distributionTimezone,
        candidatesConsidered: 0,
        exclusions: [...capLosses],
        winner: null,
      };
      await this.deps.leads.markUnsentReason(
        leadId,
        'CAP_CONTENTION_EXHAUSTED',
        exhaustedTrace,
      );
      return {
        kind: 'unsent',
        reason: 'CAP_CONTENTION_EXHAUSTED',
        selectionAttempts: MAX_SELECTION_ATTEMPTS,
      };
    });
  }
}

function withCapLosses(
  trace: SelectionTrace,
  capLosses: CapLossExclusion[],
): PersistedTrace {
  if (capLosses.length === 0) return trace;
  return { ...trace, exclusions: [...trace.exclusions, ...capLosses] };
}
