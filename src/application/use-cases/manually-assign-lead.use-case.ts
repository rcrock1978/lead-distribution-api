import { AppError } from '../../domain/errors/app-error';
import type {
  CapGate,
  EmailGuard,
  LeadRoutingRecord,
  RoutingLeadRepository,
} from '../ports/routing-ports';
import type { Clock } from '../ports/clock.port';
import type { UnitOfWork } from '../ports/db.port';
import type { BrokerState } from '../../domain/entities/broker.entity';
import type { SelectionTrace } from '../../domain/services/select-broker';

/** Minimal read-side the manual path needs beyond routing ports. */
export interface BrokerStateLookup {
  getStateById(id: number): Promise<BrokerState | null>;
}

export class ManuallyAssignLeadUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      leads: RoutingLeadRepository;
      brokers: BrokerStateLookup;
      capGate: CapGate;
      emailGuard: EmailGuard;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    leadId: number;
    brokerId: number;
  }): Promise<LeadRoutingRecord> {
    return this.deps.uow.run(async () => {
      const lead = await this.deps.leads.findById(input.leadId);
      if (lead === null) {
        throw new AppError('NOT_FOUND', 'Lead not found.');
      }
      if (lead.status === 'SENT' || lead.status === 'DUPLICATE') {
        throw new AppError(
          'LEAD_NOT_ASSIGNABLE',
          `Lead is already ${lead.status.toLowerCase()} and cannot be assigned.`,
        );
      }

      const broker = await this.deps.brokers.getStateById(input.brokerId);
      if (broker === null) {
        throw new AppError('NOT_FOUND', 'Broker not found.');
      }

      // Identical invariants as AUTO (INV-4 then INV-3), same ordering so a
      // duplicate collision rolls the burned slot back with the transaction.
      const now = this.deps.clock.nowInZone(broker.timezone);
      const gotSlot = await this.deps.capGate.tryClaimSlot(
        broker.id,
        now.localDateIso,
        broker.dailyCap,
      );
      if (!gotSlot) {
        throw new AppError(
          'BROKER_CAPPED',
          'That broker has already hit today\'s cap.',
        );
      }

      const assignedAtIso = this.deps.clock.utcNow().toISOString();
      const claim = await this.deps.emailGuard.claim(
        lead.email,
        broker.id,
        lead.id,
      );
      if (claim.outcome === 'taken') {
        throw new AppError(
          'DUPLICATE_LEAD',
          'This email was already assigned to another broker.',
          { priorBrokerId: claim.priorBrokerId },
        );
      }

      const manualTrace: SelectionTrace = {
        totalSentBefore: broker.sentToday,
        distributionTimezone: now.localDateIso + ' (manual assign)',
        candidatesConsidered: 1,
        exclusions: [],
        winner: {
          brokerId: broker.id,
          targetPct: broker.percentage,
          targetAfterLead: broker.sentToday + 1,
          sentTodayBefore: broker.sentToday,
          deficit: 0,
        },
      };
      void manualTrace;
      await this.deps.leads.markSent(
        lead.id,
        broker.id,
        assignedAtIso,
        'MANUAL',
        {
          totalSentBefore: broker.sentToday,
          distributionTimezone: 'manual',
          candidatesConsidered: 1,
          exclusions: [],
          winner: {
            brokerId: broker.id,
            targetPct: broker.percentage,
            targetAfterLead: broker.sentToday + 1,
            sentTodayBefore: broker.sentToday,
            deficit: 0,
          },
        },
      );

      const updated = await this.deps.leads.findById(lead.id);
      return updated as LeadRoutingRecord;
    });
  }
}
