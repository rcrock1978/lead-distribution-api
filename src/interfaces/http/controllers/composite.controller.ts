import { Router } from 'express';

import type { PrismaClient } from '@prisma/client';

import { sendSuccess } from '../middleware/error-handler';
import type { LuxonClock } from '../../../infrastructure/time/luxon-clock';
import { BrokerService } from '../../../services/broker.service';
import { PrismaBrokerRoutingRepository } from '../../../infrastructure/persistence/prisma/prisma-broker-routing.repository';
import { selectBroker } from '../../../domain/services/select-broker';
import { Broker } from '../../../domain/entities/broker.entity';

export interface CompositeDeps {
  prisma: PrismaClient;
  clock: LuxonClock;
}

const LEAD_LIST_SELECT = {
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
} as const;

type LeadRow = {
  id: number;
  name: string;
  email: string;
  phone: string;
  ipAddress: string;
  status: string;
  brokerId: number | null;
  broker: { name: string } | null;
  assignmentType: string | null;
  failureReason: string | null;
  createdAt: Date;
};

function toLeadListItem(r: LeadRow) {
  return {
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
  };
}

/**
 * US4 composite reads — exactly ONE round-trip per admin page (plan §D9 /
 * SC-012): GET /api/dashboard/summary, GET /api/brokers/:id/detail and
 * GET /api/distribution/detail assemble everything the page needs here.
 */
export function dashboardRoutes(deps: CompositeDeps): Router {
  const router = Router();

  router.get('/summary', async (_req, res) => {
    const now = new Date();

    const [form, distribution, brokerCount, statusGrouped, recentRows, beat] =
      await Promise.all([
        deps.prisma.form.findFirst({ select: { singleton: true } }),
        deps.prisma.distribution.findFirst({ select: { singleton: true } }),
        deps.prisma.broker.count(),
        deps.prisma.lead.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        deps.prisma.lead.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
          select: LEAD_LIST_SELECT,
        }),
        deps.prisma.workerHeartbeat.findFirst({
          orderBy: { lastBeatAt: 'desc' },
        }),
      ]);

    const counts = { sent: 0, duplicate: 0, unsent: 0, failed: 0 };
    for (const g of statusGrouped) {
      const key = g.status.toLowerCase() as keyof typeof counts;
      if (key in counts) counts[key] = g._count._all;
    }

    const lastBeatAt = beat?.lastBeatAt ?? null;
    const ageSeconds =
      lastBeatAt === null
        ? Number.MAX_SAFE_INTEGER
        : Math.floor((now.getTime() - lastBeatAt.getTime()) / 1000);

    sendSuccess(res, 200, {
      setup: {
        hasForm: form !== null,
        hasDistribution: distribution !== null,
        brokerCount,
        workerHealthy: ageSeconds < 60,
      },
      leadCounts: counts,
      recentLeads: recentRows.map(toLeadListItem),
      worker: {
        lastBeatAt:
          lastBeatAt === null ? '' : lastBeatAt.toISOString(),
        ageSeconds: lastBeatAt === null ? -1 : ageSeconds,
        processedTotal: beat?.processedTotal ?? 0,
        version: beat?.version ?? '',
      },
    });
  });

  return router;
}

/** GET /api/brokers/:id/detail — broker + first lead page + today stats. */
export function brokerDetailHandler(deps: CompositeDeps): Router {
  const router = Router();
  router.get('/:id/detail', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      sendSuccess(res, 404, { notFound: true });
      return;
    }
    const svc = new BrokerService(deps.prisma, deps.clock);
    const view = await svc.get(id);
    if (view === null) {
      sendSuccess(res, 404, { notFound: true });
      return;
    }
    const [leads, assignedToday] = await Promise.all([
      deps.prisma.lead.findMany({
        where: { brokerId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: LEAD_LIST_SELECT,
      }),
      deps.prisma.lead.count({
        where: {
          brokerId: id,
          status: 'SENT',
          assignedAt: { gte: startOfBrokerDay(deps.clock.nowInZone(view.timezone)) },
        },
      }),
    ]);
    sendSuccess(res, 200, {
      broker: view,
      leads: leads.map(toLeadListItem),
      todayStats: {
        assignedToday,
        capUsagePct:
          view.dailyCap === 0
            ? 0
            : Math.min(100, Math.round((assignedToday / view.dailyCap) * 100)),
      },
    });
  });
  return router;
}

function startOfBrokerDay(now: {
  localDateIso: string;
}): Date {
  return new Date(`${now.localDateIso}T00:00:00.000Z`);
}

/** GET /api/distribution/detail — config+members+history+counts (one call). */
export function distributionDetailRoutes(deps: CompositeDeps): Router {
  const router = Router();
  router.get('/detail', async (_req, res) => {
    const dist = await deps.prisma.distribution.findFirst({
      where: { singleton: true },
    });
    if (dist === null) {
      sendSuccess(res, 200, { distribution: null });
      return;
    }
    const [members, history, grouped] = await Promise.all([
      deps.prisma.distributionBroker.findMany({
        where: { distributionId: dist.id },
        include: { broker: true },
        orderBy: { brokerId: 'asc' },
      }),
      deps.prisma.lead.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: LEAD_LIST_SELECT,
      }),
      deps.prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const svc = new BrokerService(deps.prisma, deps.clock);
    const memberViews = [];
    for (const m of members) {
      const v = await svc.get(m.brokerId);
      if (v === null) continue;
      memberViews.push({
        brokerId: m.brokerId,
        name: m.broker.name,
        percentage: Number(m.percentage),
        isActiveInDistribution: m.isActiveInDistribution,
        sentToday: v.sentToday,
        isOpenNow: v.isOpenNow,
        isCapped: v.isCapped,
      });
    }

    const statusCounts = { sent: 0, duplicate: 0, unsent: 0, failed: 0 };
    for (const g of grouped) {
      const key = g.status.toLowerCase() as keyof typeof statusCounts;
      if (key in statusCounts) statusCounts[key] = g._count._all;
    }

    // Dry-run next selection (zero writes) for at-a-glance routing preview.
    const routingRepo = new PrismaBrokerRoutingRepository(deps.prisma, deps.clock);
    const [candidates, tz, totalSentToday] = await Promise.all([
      routingRepo.findCandidates(),
      routingRepo.getDistributionTimezone(),
      routingRepo.getTotalSentToday(),
    ]);
    const selection = selectBroker(
      candidates.map((c) => ({
        broker: new Broker(c.state),
        nowInBrokerZone: c.nowInBrokerZone,
      })),
      totalSentToday,
      tz,
    );

    sendSuccess(res, 200, {
      distribution: {
        id: dist.id,
        name: dist.name,
        timezone: dist.timezone,
        createdAt: dist.createdAt.toISOString(),
      },
      members: memberViews,
      leadHistory: history.map(toLeadListItem),
      statusCounts,
      ...(selection.outcome === 'selected'
        ? { nextSelection: { brokerId: selection.brokerId } }
        : {}),
    });
  });
  return router;
}
