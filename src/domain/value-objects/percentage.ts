import { AppError } from '../errors/app-error';

/**
 * Commercial split 0–100, kept to 2 decimal places.
 * 0 is legal to STORE but makes a broker ineligible for routing (zero_pct).
 */
export class Percentage {
  private constructor(readonly value: number) {}

  static create(value: number): Percentage {
    if (!Number.isFinite(value)) {
      throw new AppError('VALIDATION_ERROR', 'Percentage must be a finite number.');
    }
    const rounded = Math.round(value * 100) / 100;
    if (rounded < 0 || rounded > 100) {
      throw new AppError('VALIDATION_ERROR', 'Percentage must be between 0 and 100.');
    }
    return new Percentage(rounded);
  }

  /** Fair-share target after the NEXT lead joins the pool. */
  targetAfterLead(totalSentToday: number): number {
    return Percentage.round2((this.value / 100) * (totalSentToday + 1));
  }

  static round2(x: number): number {
    return Math.round(x * 100) / 100;
  }
}
