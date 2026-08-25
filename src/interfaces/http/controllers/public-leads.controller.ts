import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';

import { submissionInputSchema } from '../../../contracts';
import { sendError, sendSuccess } from '../middleware/error-handler';
import {
  CaptureLeadUseCase,
  type CaptureLeadPorts,
} from '../../../application/use-cases/capture-lead.use-case';
import type { Logger } from '../../../infrastructure/observability/logger';

export interface PublicLeadsDeps {
  log: Logger;
  prisma: PrismaClient;
}

function normalizeIp(ip: string): string {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length);
  return ip;
}

/**
 * Client IP for persistence. The edge (frontend BFF) resolves the true
 * visitor IP and forwards it as X-Client-IP (research D8) — that header is
 * authoritative whenever present. Direct callers (integration tests, local
 * curl) fall back to socket address with loopback normalization.
 */
export function clientIpForPersistence(req: {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}): string {
  const edgeIp = req.headers['x-client-ip'];
  if (typeof edgeIp === 'string' && edgeIp.trim() !== '') {
    return normalizeIp(edgeIp.trim());
  }
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const leftmost = fwd.split(',')[0]?.trim() ?? '';
    if (leftmost !== '') return normalizeIp(leftmost);
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim() !== '') return normalizeIp(realIp.trim());
  return normalizeIp(req.socket.remoteAddress ?? '0.0.0.0');
}

type TxClient = Prisma.TransactionClient;

/** Transaction-scoped port adapters — Lead + Outbox share ONE tx (INV-5). */
function buildCapturePorts(tx: TxClient, formId: number): Omit<CaptureLeadPorts, 'formId'> & {
  formId: number;
} {
  return {
    formId,
    leadRepo: {
      async findUniqueByEmail(pid, email) {
        return tx.lead.findFirst({
          where: { formId: pid, email },
          select: { id: true, formId: true, email: true },
        });
      },
      async create(data) {
        return tx.lead.create({
          data: {
            formId: data.formId,
            name: data.name,
            email: data.email,
            phone: data.phone,
            ipAddress: data.ipAddress,
            status: 'UNSENT',
            decisionTrace: { exclusions: [] },
            traceId: data.traceId,
          },
          select: { id: true },
        });
      },
    },
    outboxRepo: {
      async create(data) {
        await tx.outbox.create({
          data: {
            id: randomUUID(),
            type: data.type,
            aggregateType: data.aggregateType,
            aggregateId: data.aggregateId,
            payload: data.payload as Prisma.InputJsonValue,
            traceId: data.traceId,
          },
        });
        return { id: 0 };
      },
    },
  };
}

/**
 * POST /api/public/leads — the sole open endpoint (rate-limited upstream).
 * Zod failure → 422 nothing persisted; every other outcome returns the
 * IDENTICAL 202 envelope `{ data: { received: true }, traceId }`.
 */
export function publicLeadsRoutes(deps: PublicLeadsDeps): Router {
  const router = Router();

  router.post('/leads', async (req, res) => {
    const headerTrace = req.headers['x-trace-id'];
    const traceId =
      typeof headerTrace === 'string' && /^[0-9a-f]{32}$/i.test(headerTrace)
        ? headerTrace.toLowerCase()
        : randomUUID().replaceAll('-', '');

    const parsed = submissionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 'VALIDATION_ERROR', 'Validation failed.', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const { name, email, phone } = parsed.data;
    const ipAddress = clientIpForPersistence(req);

    // Resolve the singleton form — no form yet means nothing to attach to;
    // the visitor still sees the identical 202.
    const form = await deps.prisma.form.findFirst({ select: { id: true } });
    if (form === null) {
      deps.log.warn('lead.captured', 'No form exists; submission dropped.', {
        outcome: 'no_form',
        traceId,
      });
      sendSuccess(res, 202, { received: true });
      return;
    }

    try {
      const result = await deps.prisma.$transaction(async (tx) =>
        new CaptureLeadUseCase(buildCapturePorts(tx, form.id)).execute({
          name,
          email,
          phone,
          ipAddress,
          traceId,
        }),
      );
      deps.log.info('lead.captured', undefined, {
        outcome: result.kind,
        ...(result.kind === 'VALIDATION_ERROR' ? {} : { leadId: result.leadId }),
        traceId,
      });
    } catch (err) {
      // Never leak capture failures to the visitor.
      deps.log.error(
        'lead.capture.failed',
        err instanceof Error ? err.message : String(err),
        { traceId },
      );
    }

    sendSuccess(res, 202, { received: true });
  });

  return router;
}
