import { Router } from 'express';

import type { PrismaClient } from '@prisma/client';

import { sendSuccess } from '../middleware/error-handler';

/**
 * GET /api/health      — liveness; NO database touch.
 * GET /api/health/ready — 200 iff DB reachable ∧ migrations applied ∧
 *                         worker heartbeat fresher than 60 s; 503 with reasons.
 */
export function healthRoutes(deps: {
  prisma: PrismaClient;
  version: string;
}): Router {
  const router = Router();

  router.get('/api/health', (_req, res) => {
    sendSuccess(res, 200, { status: 'ok' });
  });

  router.get('/api/health/ready', async (_req, res) => {
    const reasons: string[] = [];

    try {
      await deps.prisma.$queryRaw`SELECT 1`;
    } catch {
      reasons.push('database_unreachable');
    }

    try {
      // Proves the schema was migrated (ConfigVersion row is created by the
      // initial migration and must always exist).
      const cfg = await deps.prisma.configVersion.findUnique({ where: { id: 1 } });
      if (cfg === null) reasons.push('migrations_not_applied');
    } catch {
      reasons.push('migrations_not_applied');
    }

    let heartbeatAgeSeconds: number | null = null;
    try {
      const beat = await deps.prisma.workerHeartbeat.findFirst();
      if (beat === null) {
        reasons.push('worker_heartbeat_missing');
      } else {
        heartbeatAgeSeconds = Math.floor((Date.now() - beat.lastBeatAt.getTime()) / 1000);
        if (heartbeatAgeSeconds >= 60) {
          reasons.push(`worker_heartbeat_stale_${heartbeatAgeSeconds}s`);
        }
      }
    } catch {
      reasons.push('worker_heartbeat_unknown');
    }

    if (reasons.length > 0) {
      res.status(503).json({
        success: false,
        error: { code: 'NOT_READY', message: 'Readiness check failed.', details: { reasons } },
        traceId: 'readiness',
        data: { reasons, heartbeatAgeSeconds },
      });
      return;
    }

    sendSuccess(res, 200, {
      status: 'ready',
      heartbeatAgeSeconds,
      version: deps.version,
    });
  });

  return router;
}
