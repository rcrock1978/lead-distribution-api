import type { BrokerState } from '../../domain/entities/broker.entity';
import type { ExclusionRule } from '../../domain/entities/broker.entity';
import type { SelectionTrace } from '../../domain/services/select-broker';
import type { ZonedInstant } from '../../domain/value-objects/zoned-instant';

/**
 * Ports the routing use case depends on. Implementations live in
 * infrastructure; these interfaces are the application ring's entire view of
 * persistence (Constitution II/III — the use case itself stays orchestration
 * only).
 */

export interface LeadRoutingRecord {
  id: number;
  formId: number;
  email: string;
  status: 'UNSENT' | 'SENT' | 'DUPLICATE' | 'FAILED';
  brokerId: number | null;
  assignmentType: 'AUTO' | 'MANUAL' | null;
  failureReason: string | null;
  decisionTrace: unknown;
}

export interface RoutingLeadRepository {
  findById(id: number): Promise<LeadRoutingRecord | null>;
  markSent(
    id: number,
    brokerId: number,
    assignedAtIso: string,
    assignmentType: 'AUTO' | 'MANUAL',
    trace: SelectionTrace,
  ): Promise<void>;
  markDuplicate(
    id: number,
    reason: string,
    trace: SelectionTrace & { duplicateOfBrokerId?: number },
    priorBrokerId: number | null,
  ): Promise<void>;
  markUnsentReason(
    id: number,
    reason: string,
    trace: SelectionTrace,
  ): Promise<void>;
}

/** A candidate plus its zone-projected "now" for eligibility checks. */
export interface BrokerCandidate {
  state: BrokerState;
  nowInBrokerZone: ZonedInstant;
}

export interface RoutingBrokerRepository {
  findCandidates(): Promise<BrokerCandidate[]>;
  getDistributionTimezone(): Promise<string>;
  /** Shared deficit denominator: leads SENT today in the DISTRIBUTION's timezone. */
  getTotalSentToday(): Promise<number>;
}

/**
 * INV-4 as a port: the conditional atomic increment
 * `UPDATE … WHERE cap=0 OR sentCount<cap` — false ⇒ slot lost ⇒ re-select.
 */
export interface CapGate {
  tryClaimSlot(
    brokerId: number,
    brokerLocalDateIso: string,
    cap: number,
  ): Promise<boolean>;
}

/**
 * INV-3 as a port: insert-only claim on AssignedEmail. Collision IS
 * duplicate detection — no read-before-write anywhere.
 */
export interface EmailGuard {
  claim(
    normalizedEmail: string,
    brokerId: number,
    leadId: number,
  ): Promise<{ outcome: 'claimed' } | { outcome: 'taken'; priorBrokerId: number }>;
}

export interface CapLossExclusion {
  brokerId: number;
  rule: Extract<ExclusionRule, 'capped'>;
}
