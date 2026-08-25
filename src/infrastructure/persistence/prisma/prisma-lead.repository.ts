import type { Prisma, PrismaClient } from '@prisma/client';

import type {
  LeadRoutingRecord,
  RoutingLeadRepository,
} from '../../../application/ports/routing-ports';
import { clientFor } from './prisma-unit-of-work';

/** Prisma adapter for lead state transitions (routing side). */
export class PrismaLeadRepository implements RoutingLeadRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: number): Promise<LeadRoutingRecord | null> {
    const row = await clientFor(this.prisma).lead.findUnique({
      where: { id },
      select: {
        id: true,
        formId: true,
        email: true,
        status: true,
        brokerId: true,
        assignmentType: true,
        failureReason: true,
        decisionTrace: true,
      },
    });
    return row === null
      ? null
      : {
          ...row,
          status: row.status as LeadRoutingRecord['status'],
          assignmentType:
            row.assignmentType as LeadRoutingRecord['assignmentType'],
        };
  }

  async markSent(
    id: number,
    brokerId: number,
    assignedAtIso: string,
    assignmentType: 'AUTO' | 'MANUAL',
    trace: unknown,
  ): Promise<void> {
    await clientFor(this.prisma).lead.update({
      where: { id },
      data: {
        status: 'SENT',
        brokerId,
        assignmentType,
        assignedAt: new Date(assignedAtIso),
        failureReason: null,
        decisionTrace: trace as Prisma.InputJsonValue,
      },
    });
  }

  async markDuplicate(
    id: number,
    reason: string,
    trace: unknown,
    priorBrokerId: number | null,
  ): Promise<void> {
    await clientFor(this.prisma).lead.update({
      where: { id },
      data: {
        status: 'DUPLICATE',
        brokerId: priorBrokerId,
        assignmentType: null,
        failureReason: reason,
        decisionTrace: trace as Prisma.InputJsonValue,
      },
    });
  }

  async markUnsentReason(
    id: number,
    reason: string,
    trace: unknown,
  ): Promise<void> {
    await clientFor(this.prisma).lead.update({
      where: { id },
      data: {
        status: 'UNSENT',
        failureReason: reason,
        decisionTrace: trace as Prisma.InputJsonValue,
      },
    });
  }
}
