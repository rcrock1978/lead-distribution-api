import { Router } from 'express';
import { readFile } from 'node:fs/promises';

import type { PrismaClient } from '@prisma/client';
import { logsTailQuerySchema } from '../../../contracts';
import { sendError, sendSuccess } from '../middleware/error-handler';
import type { MetricsRegistry } from '../../../infrastructure/observability/metrics';
import type { Logger } from '../../../infrastructure/observability/logger';

export interface OpsDeps {
  prisma: PrismaClient;
  metrics: MetricsRegistry;
  log: Logger;
}

const DEAD_AFTER_ATTEMPTS = 5;

/**
 * US5 operations surface (contracts/api.md §Health & Ops). Admin-only via the
 * global JWT guard — /api/public-style exemptions do not apply here.
 */
export function opsRoutes(deps: OpsDeps): Router {
  const router = Router();

  // GET /api/ops/outbox — depth by status, oldest pending age, dead letters.
  router.get('/outbox', async (_req, res) => {
    const [grouped, oldestPending, deadRows] = await Promise.all([
      deps.prisma.outbox.groupBy({ by: ['status'], _count: { _all: true } }),
      deps.prisma.outbox.findFirst({
        where: { status: 'PENDING', availableAt: { lte: new Date() } },
        orderBy: { availableAt: 'asc' },
        select: { availableAt: true },
      }),
      deps.prisma.outbox.findMany({
        where: { status: 'DEAD' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          attempts: true,
          lastError: true,
          createdAt: true,
        },
      }),
    ]);

    const depths: Record<string, number> = {};
    for (const g of grouped) depths[g.status.toLowerCase()] = g._count._all;

    sendSuccess(res, 200, {
      depths,
      oldestPendingAgeMs:
        oldestPending === null
          ? null
          : Date.now() - oldestPending.availableAt.getTime(),
      dead: deadRows.map((d) => ({
        id: d.id,
        type: d.type,
        attempts: d.attempts,
        lastError: d.lastError ?? '',
        createdAt: d.createdAt.toISOString(),
      })),
    });
  });

  // POST /api/ops/outbox/:id/replay — DEAD → PENDING.
  router.post('/outbox/:id/replay', async (req, res) => {
    const id = String(req.params.id ?? '');
    const msg = await deps.prisma.outbox.findUnique({ where: { id } });
    if (msg === null) {
      sendError(res, 'NOT_FOUND', 'Outbox message not found.');
      return;
    }
    if (msg.status !== 'DEAD') {
      sendError(
        res,
        'VALIDATION_ERROR',
        `Only DEAD messages can be replayed (message is ${msg.status}).`,
      );
      return;
    }
    await deps.prisma.outbox.update({
      where: { id },
      data: {
        status: 'PENDING',
        attempts: 0,
        claimedAt: null,
        processedAt: null,
        availableAt: new Date(),
      },
    });
    deps.log.info('outbox.replayed', undefined, { messageId: id });
    sendSuccess(res, 200, { replayed: true });
  });

  // GET /api/ops/metrics — registry snapshot (volatile by design) PLUS
  // durable figures derived from the database on read (research D10): the
  // worker runs in its OWN process, so cross-process routing latency is
  // computed here from recent SENT leads instead of living in this
  // process's histogram memory.
  router.get('/metrics', async (_req, res) => {
    const [pendingDepth, deadDepth, recentSent] = await Promise.all([
      deps.prisma.outbox.count({ where: { status: 'PENDING' } }),
      deps.prisma.outbox.count({ where: { status: 'DEAD' } }),
      deps.prisma.lead.findMany({
        where: { status: 'SENT', assignedAt: { not: null } },
        orderBy: { assignedAt: 'desc' },
        take: 500,
        select: { createdAt: true, assignedAt: true },
      }),
    ]);
    deps.metrics.setGauge('outbox_pending_depth', pendingDepth);
    deps.metrics.setGauge('outbox_dead_depth', deadDepth);

    const latencies = recentSent
      .map((l) => l.assignedAt!.getTime() - l.createdAt.getTime())
      .sort((a, b) => a - b);
    const pct = (p: number): number =>
      latencies.length === 0
        ? 0
        : latencies[
            Math.min(
              latencies.length - 1,
              Math.ceil((p / 100) * latencies.length) - 1,
            )
          ]!;
    const dbLatency = {
      count: latencies.length,
      sumMs: latencies.reduce((a, b) => a + b, 0),
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
    };

    const snap = deps.metrics.snapshot();
    snap.histograms['lead_capture_to_assign_ms{source="db"}'] = dbLatency;
    sendSuccess(res, 200, snap);
  });

  // GET /api/ops/logs/tail — last N structured events from configured files.
  router.get('/logs/tail', async (req, res) => {
    const parsed = logsTailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 'VALIDATION_ERROR', 'Validation failed.', {
        issues: parsed.error.issues.map((i) => i.message),
      });
      return;
    }
    const { level, event, traceId, n } = parsed.data;
    const files = (process.env.OPS_LOG_FILES ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '');

    type LogLine = Record<string, unknown>;
    let lines: Array<LogLine & { level?: string; event?: string; traceId?: string }> = [];

    if (files.length === 0) {
      sendSuccess(res, 200, { events: [], note: 'OPS_LOG_FILES not configured' });
      return;
    }

    for (const file of files) {
      try {
        const contents = await readFile(file, 'utf8');
        const fileLines = contents.trim().split('\n').slice(-2000); // bound scan
        for (const line of fileLines) {
          try {
            const obj = JSON.parse(line) as LogLine;
            lines.push(obj);
          } catch {
            // Non-JSON output (e.g. pretty stack traces) is skipped.
          }
        }
      } catch {
        // Missing/unreadable file contributes nothing.
      }
    }

    if (level) lines = lines.filter((l) => l.level === level);
    if (event) lines = lines.filter((l) => l.event === event);
    if (traceId) {
      const t = traceId.toLowerCase();
      lines = lines.filter((l) => l.traceId === t);
    }
    lines = lines.slice(-n);

    sendSuccess(res, 200, { events: lines });
  });

  return router;
}
