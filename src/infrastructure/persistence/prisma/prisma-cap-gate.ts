import type { PrismaClient } from '@prisma/client';

import type { CapGate } from '../../../application/ports/routing-ports';
import { clientFor } from './prisma-unit-of-work';

/**
 * INV-4 as SQL: sentCount moves ONLY through the conditional UPDATE
 * `WHERE (capAtTime=0 OR sentCount<capAtTime)`; affectedRows===1 is the
 * entire guarantee. Row-absent case: INSERT IGNORE (concurrent creators
 * converge) then one retry of the same conditional predicate.
 */
export class PrismaCapGate implements CapGate {
  constructor(private readonly prisma: PrismaClient) {}

  async tryClaimSlot(
    brokerId: number,
    localDateIso: string,
    cap: number,
  ): Promise<boolean> {
    const db = clientFor(this.prisma);
    const claim = async (): Promise<number> =>
      db.$executeRaw`
        UPDATE broker_daily_counters
           SET sentCount = sentCount + 1
         WHERE brokerId = ${brokerId}
           AND localDate = ${localDateIso}
           AND (capAtTime = 0 OR sentCount < ${cap})
      `;

    if ((await claim()) === 1) return true;

    await db.$executeRaw`
      INSERT IGNORE INTO broker_daily_counters
        (brokerId, localDate, sentCount, capAtTime)
      VALUES (${brokerId}, ${localDateIso}, 0, ${cap})
    `;
    return (await claim()) === 1;
  }
}
