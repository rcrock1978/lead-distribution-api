import type { Broker } from '../entities/broker.entity';
import type { ExclusionRule } from '../entities/broker.entity';
import type { ZonedInstant } from '../value-objects/zoned-instant';

export interface TraceExclusionRecord {
  brokerId: number;
  rule: ExclusionRule;
}

export interface TraceWinner {
  brokerId: number;
  targetPct: number;
  targetAfterLead: number;
  sentTodayBefore: number;
  deficit: number;
}

export interface SelectionTrace {
  totalSentBefore: number;
  distributionTimezone: string;
  candidatesConsidered: number;
  exclusions: TraceExclusionRecord[];
  winner: TraceWinner | null;
}

export type SelectionResult =
  | { outcome: 'selected'; brokerId: number; trace: SelectionTrace }
  | { outcome: 'none'; reason: string; trace: SelectionTrace };

/**
 * THE commercial heart (Constitution II): pure function, zero infrastructure.
 *
 * Fair-share deficit selection over the shared daily denominator
 * `totalSentToday` (distribution-local day). Each candidate arrives with its
 * OWN zone-projected instant so working-day/window/cap checks are exact in
 * the broker's local calendar.
 *
 * Winner = highest deficit = targetAfterLead − sentTodayBefore.
 * Ties → fewer already-sent today, then ascending id.
 */
export function selectBroker(
  candidates: Array<{ broker: Broker; nowInBrokerZone: ZonedInstant }>,
  totalSentToday: number,
  distributionTimezone: string,
): SelectionResult {
  const exclusions: TraceExclusionRecord[] = [];
  const eligible: Array<{
    broker: Broker;
    sentTodayBefore: number;
    targetAfterLead: number;
    deficit: number;
  }> = [];

  for (const { broker, nowInBrokerZone } of candidates) {
    const verdict = broker.canReceiveAt(nowInBrokerZone);
    if (!verdict.eligible) {
      exclusions.push({ brokerId: broker.id, rule: verdict.rule });
      continue;
    }
    const sentTodayBefore = broker.state.sentToday;
    const targetAfterLead = broker.targetAfterLeadForTrace(totalSentToday);
    eligible.push({
      broker,
      sentTodayBefore,
      targetAfterLead,
      deficit: broker.deficitAfterLead(totalSentToday),
    });
  }

  let winner: TraceWinner | null = null;

  if (eligible.length > 0) {
    // Highest deficit; ties → fewer sent today → ascending id.
    eligible.sort((a, b) => {
      if (b.deficit !== a.deficit) return b.deficit - a.deficit;
      if (b.sentTodayBefore !== a.sentTodayBefore)
        return a.sentTodayBefore - b.sentTodayBefore;
      return a.broker.id - b.broker.id;
    });
    const top = eligible[0] as (typeof eligible)[number];
    winner = {
      brokerId: top.broker.id,
      targetPct: top.broker.state.percentage,
      targetAfterLead: top.targetAfterLead,
      sentTodayBefore: top.sentTodayBefore,
      deficit: top.deficit,
    };
  }

  const trace: SelectionTrace = {
    totalSentBefore: totalSentToday,
    distributionTimezone,
    candidatesConsidered: candidates.length,
    exclusions,
    winner,
  };

  if (winner === null) {
    return {
      outcome: 'none',
      reason:
        candidates.length === 0
          ? 'NO_ACTIVE_BROKERS'
          : 'NO_ELIGIBLE_BROKER',
      trace,
    };
  }
  return { outcome: 'selected', brokerId: winner.brokerId, trace };
}
