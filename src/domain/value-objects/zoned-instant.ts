/**
 * A moment in time projected into an IANA timezone, carried as PLAIN PRIMITIVES
 * so the domain never imports Luxon (Constitution II). Instances are produced
 * exclusively by the injected Clock port's infrastructure implementation.
 */
export class ZonedInstant {
  private constructor(
    readonly epochMs: number,
    /** IANA zone name, e.g. "Asia/Manila". */
    readonly zone: string,
    /** Broker/distribution-local calendar date, e.g. "2026-08-25". */
    readonly localDateIso: string,
    /** Minutes since LOCAL midnight (for open/close comparisons; overnight windows wrap naturally). */
    readonly minutesSinceMidnight: number,
    /** ISO weekday: 1=Monday … 7=Sunday. */
    readonly isoWeekday: number,
    /** Local "HH:MM" for display. */
    readonly localTimeHhMm: string,
  ) {}

  static fromParts(
    epochMs: number,
    zone: string,
    localDateIso: string,
    minutesSinceMidnight: number,
    isoWeekday: number,
    localTimeHhMm: string,
  ): ZonedInstant {
    return new ZonedInstant(
      epochMs,
      zone,
      localDateIso,
      minutesSinceMidnight,
      isoWeekday,
      localTimeHhMm,
    );
  }
}
