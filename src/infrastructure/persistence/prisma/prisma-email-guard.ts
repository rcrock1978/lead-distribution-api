import type { Prisma, PrismaClient } from '@prisma/client';

import type { EmailGuard } from '../../../application/ports/routing-ports';
import { clientFor } from './prisma-unit-of-work';

/**
 * INV-3 as an insert-only claim: the AssignedEmail PRIMARY KEY collision IS
 * duplicate detection. No read-before-write on the happy path; on P2002 the
 * prior owner's brokerId is read once for trace provenance.
 */
export class PrismaEmailGuard implements EmailGuard {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date,
  ) {}

  async claim(
    normalizedEmail: string,
    brokerId: number,
    leadId: number,
  ): Promise<
    { outcome: 'claimed' } | { outcome: 'taken'; priorBrokerId: number }
  > {
    try {
      await clientFor(this.prisma).assignedEmail.create({
        data: {
          email: normalizedEmail,
          brokerId,
          leadId,
          assignedAt: this.now(),
        },
      });
      return { outcome: 'claimed' };
    } catch (err) {
      const isUniqueViolation =
        (err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';
      if (!isUniqueViolation) throw err;

      const db = clientFor(this.prisma);
      // Case 1: the EMAIL is permanently owned → duplicate, UNLESS the prior
      // owner is THIS lead (true idempotent redelivery of the same message).
      const byEmail = await db.assignedEmail.findUnique({
        where: { email: normalizedEmail },
        select: { brokerId: true, leadId: true },
      });
      if (byEmail !== null) {
        return byEmail.leadId === leadId
          ? { outcome: 'claimed' }
          : { outcome: 'taken', priorBrokerId: byEmail.brokerId };
      }
      // Case 2: email free but THIS lead already claimed elsewhere (crash
      // between claim and markSent under a changed selection) — the prior
      // assignment stands as provenance.
      const byLead = await db.assignedEmail.findUnique({
        where: { leadId },
        select: { brokerId: true },
      });
      if (byLead !== null) {
        return { outcome: 'taken', priorBrokerId: byLead.brokerId };
      }
      throw new Error(
        `AssignedEmail unique violation without readable prior row (email=${normalizedEmail} leadId=${leadId})`,
      );
    }
  }
}
