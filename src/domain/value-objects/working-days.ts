import { AppError } from '../errors/app-error';

/** ISO working days: 1=Monday … 7=Sunday. Non-empty, unique. */
export class WorkingDays {
  private constructor(private readonly days: ReadonlySet<number>) {}

  static create(days: number[]): WorkingDays {
    if (days.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'At least one working day is required.');
    }
    for (const d of days) {
      if (!Number.isInteger(d) || d < 1 || d > 7) {
        throw new AppError('VALIDATION_ERROR', 'Working days are ISO weekdays 1–7.');
      }
    }
    if (new Set(days).size !== days.length) {
      throw new AppError('VALIDATION_ERROR', 'Working days must be unique.');
    }
    return new WorkingDays(new Set(days));
  }

  includes(isoWeekday: number): boolean {
    return this.days.has(isoWeekday);
  }

  toArray(): number[] {
    return [...this.days].sort((a, b) => a - b);
  }
}
