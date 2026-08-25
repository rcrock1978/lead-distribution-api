import { AppError } from '../errors/app-error';

/**
 * Daily opening hours in minutes-since-LOCAL-midnight. A closing time that is
 * ≤ the opening time wraps overnight (22:00–06:00 spans midnight). The window
 * is half-open [open, close): at exactly `close` the broker is closed.
 */
export class TimeWindow {
  private constructor(
    readonly openingMinutes: number,
    readonly closingMinutes: number,
    readonly overnightWrap: boolean,
  ) {}

  static create(openingTime: string, closingTime: string): TimeWindow {
    const open = TimeWindow.parseHhMm(openingTime);
    const close = TimeWindow.parseHhMm(closingTime);
    return new TimeWindow(open, close, close <= open);
  }

  private static parseHhMm(hhmm: string): number {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
    if (!m) {
      throw new AppError('VALIDATION_ERROR', `Invalid HH:MM time: ${hhmm}`);
    }
    return Number(m[1]) * 60 + Number(m[2]);
  }

  contains(minutesSinceMidnight: number): boolean {
    if (this.openingMinutes === this.closingMinutes) return true; // 24h window
    if (!this.overnightWrap) {
      return (
        minutesSinceMidnight >= this.openingMinutes &&
        minutesSinceMidnight < this.closingMinutes
      );
    }
    return (
      minutesSinceMidnight >= this.openingMinutes ||
      minutesSinceMidnight < this.closingMinutes
    );
  }
}
