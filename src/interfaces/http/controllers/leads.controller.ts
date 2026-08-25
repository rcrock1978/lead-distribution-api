import { Router } from 'express';

import type { PrismaClient } from '@prisma/client';
import { leadListQuerySchema, manualAssignInputSchema } from '../../../contracts';
import { sendError, sendSuccess } from '../middleware/error-handler';
import { AppError } from '../../../domain/errors/app-error';
import { PrismaLeadRepository } from '../../../infrastructure/persistence/prisma/prisma-lead.repository';
import { PrismaBrokerRoutingRepository } from '../../../infrastructure/persistence/prisma/prisma-broker-routing.repository';
import { PrismaCapGate } from '../../../infrastructure/persistence/prisma/prisma-cap-gate';
import { PrismaEmailGuard } from '../../../infrastructure/persistence/prisma/prisma-email-guard';
import { PrismaUnitOfWork } from '../../../infrastructure/persistence/prisma/prisma-unit-of-work';
import { ManuallyAssignLeadUseCase } from '../../../application/use-cases/manually-assign-lead.use-case';
import type { Logger } from '../../../infrastructure/observability/logger';
import type { LuxonClock } from '../../../infrastructure/time/luxon-clock';

export interface LeadsDeps {
  log: Logger;
  prisma: PrismaClient;
  clock: LuxonClock;
}

function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString(
    'base64',
  );
}

function decodeCursor(
  raw: string,
): { createdAt: Date; id: number } | null {
  try {
    const [iso, id] = Buffer.from(raw, 'base64').toString('utf8').split('|');
    const d = new Date(iso ?? '');
    const n = Number(id);
    if (Number.isNaN(d.getTime()) || !Number.isInteger(n)) return null;
    return { createdAt: d, id: n };
  } catch {
    return null;
  }
}

/**
 * US4 lead oversight (contracts/api.md §Leads):
 *  GET   /api/leads          keyset page, filters, decisionTrace EXCLUDED
 *  GET   /api/leads/:id      full record incl. decisionTrace
 *  POST  /api/leads/:id/assign   manual assignment under full invariants
 *  POST  /api/leads/:id/retry    re-enqueue UNSENT/FAILED
 */
export function leadsRoutes(deps: LeadsDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const q = leadListQuerySchema.parse(req.query);

    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status.toUpperCase();
    if (q.brokerId !== undefined) where.brokerId = q.brokerId;
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (q.q) {
      where.OR = [
        { email: { contains: q.q } },
        { name: { contains: q.q } },
      ];
    }
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (cur === null) {
        sendError(res, 'VALIDATION_ERROR', 'Malformed cursor.');
        return;
      }
      // Keyset: strictly older than the cursor tuple.
      where.OR = [
        { createdAt: { lt: cur.createdAt } },
        { createdAt: { equals: cur.createdAt }, id: { lt: cur.id } },
      ];
    }

    const rows = await deps.prisma.lead.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        ipAddress: true,
        status: true,
        brokerId: true,
        broker: { select: { name: true } },
        assignmentType: true,
        failureReason: true,
        createdAt: true,
        // decisionTrace deliberately NOT selected (1–2KB/lead).
      },
    });

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const items = page.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      ipAddress: r.ipAddress,
      status: r.status.toLowerCase(),
      brokerId: r.brokerId,
      brokerName: r.broker?.name ?? null,
      assignmentType: r.assignmentType?.toLowerCase() ?? null,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
    }));
    const last = page.at(-1);
    sendSuccess(res, 200, {
      items,
      ...(hasMore && last
        ? { nextCursor: encodeCursor(last.createdAt, last.id) }
        : {}),
    });
  });

  router.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      sendError(res, 'NOT_FOUND', 'Lead not found.');
      return;
    }
    const row = await deps.prisma.lead.findUnique({
      where: { id },
      include: { broker: { select: { name: true } } },
    });
    if (row === null) {
      sendError(res, 'NOT_FOUND', 'Lead not found.');
      return;
    }
    sendSuccess(res, 200, {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      ipAddress: row.ipAddress,
      status: row.status.toLowerCase(),
      brokerId: row.brokerId,
      brokerName: row.broker?.name ?? null,
      assignmentType: row.assignmentType?.toLowerCase() ?? null,
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
      assignedAt: row.assignedAt?.toISOString() ?? null,
      traceId: row.traceId,
      decisionTrace: row.decisionTrace,
    });
  });

  router.post('/:id/assign', async (req, res) => {
    const id = Number(req.params.id);
    const parsed = manualAssignInputSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 'VALIDATION_ERROR', 'Validation failed.', {
        issues: parsed.error.issues.map((i) => i.message),
      });
      return;
    }
    const useCase = new ManuallyAssignLeadUseCase({
      uow: new PrismaUnitOfWork(deps.prisma),
      leads: new PrismaLeadRepository(deps.prisma),
      brokers: new PrismaBrokerRoutingRepository(deps.prisma, deps.clock),
      capGate: new PrismaCapGate(deps.prisma),
      emailGuard: new PrismaEmailGuard(deps.prisma, () => deps.clock.utcNow()),
      clock: deps.clock,
    });
    try {
      await useCase.execute({ leadId: id, brokerId: parsed.data.brokerId });
    } catch (err) {
      if (err instanceof AppError) {
        sendError(res, err.code, err.message, err.details);
        return;
      }
      throw err;
    }
    deps.log.info('lead.manually_assigned', undefined, {
      leadId: id,
      brokerId: parsed.data.brokerId,
    });
    sendSuccess(res, 200, { assigned: true });
  });

  router.post('/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    const lead = await deps.prisma.lead.findUnique({ where: { id } });
    if (lead === null) {
      sendError(res, 'NOT_FOUND', 'Lead not found.');
      return;
    }
    if (lead.status !== 'UNSENT' && lead.status !== 'FAILED') {
      sendError(
        res,
        'LEAD_NOT_ASSIGNABLE',
        `Only UNSENT or FAILED leads can be retried (lead is ${lead.status}).`,
      );
      return;
    }
    await deps.prisma.outbox.create({
      data: {
        id: crypto.randomUUID(),
        type: 'LeadRoutingRequested',
        aggregateType: 'Lead',
        aggregateId: String(lead.id),
        payload: {
          leadId: lead.id,
          formId: lead.formId,
          email: lead.email,
        } as never,
        traceId: lead.traceId,
        status: 'PENDING',
      },
    });
    deps.log.info('lead.retried', undefined, { leadId: lead.id });
    sendSuccess(res, 200, { requeued: true });
  });

  return router;
}
