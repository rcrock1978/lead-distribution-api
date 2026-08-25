import { Percentage } from '../value-objects/percentage';
import { TimeWindow } from '../value-objects/time-window';
import { WorkingDays } from '../value-objects/working-days';
import { ZonedInstant } from '../value-objects/zoned-instant';

/** The five closed exclusion rules named in every decision trace. */
export type ExclusionRule = 'inactive' | 'closed' | 'off_day' | 'capped' | 'zero_pct';

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; rule: ExclusionRule };

/**
 * Everything selection needs about one broker, projected by the application
 * layer (percentage, live sentToday in the BROKER's timezone).
 */
export interface BrokerState {
  id: number;
  name: string;
  isActive: boolean;
  isActiveInDistribution: boolean;
  dailyCap: number;
  timezone: string;
  openingTime: string;
  closingTime: string;
  workingDays: number[];
  percentage: number;
  /** Live count for the BROKER-local day (INV-4 denominator is per-broker). */
  sentToday: number;
}

export class Broker {
  private readonly timeWindow: TimeWindow;
  private readonly workingDays: WorkingDays;
  private readonly percentage: Percentage;

  constructor(private readonly s: BrokerState) {
    this.timeWindow = TimeWindow.create(s.openingTime, s.closingTime);
    this.workingDays = WorkingDays.create(s.workingDays);
    this.percentage = Percentage.create(s.percentage);
  }

  get id(): number {
    return this.s.id;
  }

  get name(): string {
    return this.s.name;
  }

  get state(): BrokerState {
    return { ...this.s };
  }

  /**
   * Pure eligibility gate. `now` MUST be projected into THIS broker's
   * timezone by the caller (the injected Clock does zone math; the domain
   * only compares primitives — Constitution II).
   * Order matters only for WHICH rule the trace names.
   */
  canReceiveAt(now: ZonedInstant): EligibilityResult {
    if (!this.s.isActive || !this.s.isActiveInDistribution) {
      return { eligible: false, rule: 'inactive' };
    }
    if (this.percentage.value <= 0) {
      return { eligible: false, rule: 'zero_pct' };
    }
    if (!this.workingDays.includes(now.isoWeekday)) {
      return { eligible: false, rule: 'off_day' };
    }
    if (!this.timeWindow.contains(now.minutesSinceMidnight)) {
      return { eligible: false, rule: 'closed' };
    }
    if (this.s.dailyCap > 0 && this.s.sentToday >= this.s.dailyCap) {
      return { eligible: false, rule: 'capped' };
    }
    return { eligible: true };
  }

  /** Open/closed ignores active flags and caps — display semantics. */
  isOpenNow(now: ZonedInstant): boolean {
    return this.timeWindow.contains(now.minutesSinceMidnight);
  }

  /**
   * Fair-share deficit if THIS lead joins the pool:
   *   targetAfterLead − sentTodayBefore.
   * Negative when over target — "least over" wins an all-negative field
   * (closest to fair share).
   */
  deficitAfterLead(totalSentToday: number): number {
    const target = this.percentage.targetAfterLead(totalSentToday);
    return Percentage.round2(target - this.s.sentToday);
  }

  targetAfterLeadForTrace(totalSentToday: number): number {
    return this.percentage.targetAfterLead(totalSentToday);
  }
}
