import { Router } from 'express';
import { Prisma } from '@prisma/client';

import {
  CreateDistributionUseCase,
} from '../../../application/use-cases/create-distribution.use-case';
import type { DistributionRepositoryPort } from '../../../application/use-cases/create-distribution.use-case';
import {
  distributionCreateInputSchema,
  distributionMembersInputSchema,
  distributionPatchInputSchema,
} from '../../../contracts';
import { bumpConfigVersion } from '../../../services/config-version';
import { AppError } from '../../../domain/errors/app-error';
import type { Logger } from '../../../infrastructure/observability/logger';
import type { PrismaClient } from '@prisma/client';
import type { LuxonClock } from '../../../infrastructure/time/luxon-clock';
import { BrokerService } from '../../../services/broker.service';
import { sendError, sendSuccess } from '../middleware/error-handler';
import { PrismaBrokerRoutingRepository } from '../../../infrastructure/persistence/prisma/prisma-broker-routing.repository';
import { selectBroker } from '../../../domain/services/select-broker';
import { Broker } from '../../../domain/entities/broker.entity';

export interface DistributionDeps {
  log: Logger;
  prisma: PrismaClient;
  clock: LuxonClock;
}

function repoFrom(prisma: PrismaClient, log: Logger): DistributionRepositoryPort {
  return {
    findSingleton: async () => {
      const found = await prisma.distribution.findFirst({
        where: { singleton: { not: null } },
      });
      return found
        ? {
            id: found.id,
            name: found.name,
            formId: found.formId,
            timezone: found.timezone,
          }
        : null;
    },
    getFormId: async () => {
      const form = await prisma.form.findFirst({ orderBy: { id: 'asc' } });
      return form?.id ?? null;
    },
    createWithVersionBump: async ({ name, timezone, formId }) => {
      const created = await prisma.$transaction(async (tx) => {
        const distribution = await tx.distribution.create({
          data: { name, timezone, formId, singleton: true },
        });
        await bumpConfigVersion(tx);
        return distribution;
      });
      log.info('distribution.created', 'Distribution created', {
        distributionId: created.id,
      });
      return created;
    },
    replaceMembersWithVersionBump: async (distributionId, members) => {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.distribution.findUnique({
          where: { id: distributionId },
        });
        if (existing === null) {
          throw new AppError('NOT_FOUND', 'Distribution not found.');
        }
        await tx.distributionBroker.deleteMany({ where: { distributionId } });
        for (const m of members) {
          await tx.distributionBroker.create({
            data: {
              distributionId,
              brokerId: m.brokerId,
              percentage: new Prisma.Decimal(m.percentage),
              isActiveInDistribution: m.isActiveInDistribution,
            },
          });
        }
        await bumpConfigVersion(tx);
      });
      log.info('distribution.members.replaced', 'Members replaced', {
        distributionId,
        memberCount: members.length,
      });
    },
  };
}

/**
 * POST /api/distribution          — CreateDistributionUseCase.
 * GET  /api/distribution          — current distribution or null-shape.
 * PUT  /api/distribution/brokers  — full member replacement (version-bumped).
 */
export function distributionRoutes(deps: DistributionDeps): Router {
  const router = Router();
  const repo = repoFrom(deps.prisma, deps.log);

  router.post('/', async (req, res) => {
    const input = distributionCreateInputSchema.parse(req.body);
    const useCase = new CreateDistributionUseCase(repo);
    let created;
    try {
      created = await useCase.execute(input);
    } catch (err) {
      // Racer lost the singleton UNIQUE insert → contract 409 (§15).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        sendError(
          res,
          'DISTRIBUTION_ALREADY_EXISTS',
          'A distribution already exists. Only one distribution can be created.',
        );
        return;
      }
      throw err;
    }
    sendSuccess(res, 201, created);
  });

  router.get('/', async (_req, res) => {
    const distribution = await repo.findSingleton();
    if (distribution === null) {
      sendSuccess(res, 200, { distribution: null, members: [] });
      return;
    }

    // One call for the page: members joined with computed per-broker-timezone
    // views. Never cached (Constitution V).
    const rows = await deps.prisma.distributionBroker.findMany({
      where: { distributionId: distribution.id },
      include: { broker: true },
      orderBy: { brokerId: 'asc' },
    });
    const brokerService = new BrokerService(deps.prisma, deps.clock);
    const members = [];
    for (const row of rows) {
      const view = await brokerService.get(row.brokerId);
      if (view === null) continue;
      members.push({
        brokerId: row.brokerId,
        name: row.broker.name,
        percentage: Number(row.percentage),
        isActiveInDistribution: row.isActiveInDistribution,
        sentToday: view.sentToday,
        isOpenNow: view.isOpenNow,
        isCapped: view.isCapped,
      });
    }
    sendSuccess(res, 200, { distribution, members });
  });

  // PATCH /api/distribution — rename / change reference timezone (§15).
  router.patch('/', async (req, res) => {
    const parsed = distributionPatchInputSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 'VALIDATION_ERROR', 'Validation failed.', {
        issues: parsed.error.issues.map((i) => i.message),
      });
      return;
    }
    try {
      const updated = await deps.prisma.$transaction(async (tx) => {
        const dist = await tx.distribution.findFirst({
          where: { singleton: true },
        });
        if (dist === null) {
          throw new AppError('NOT_FOUND', 'No distribution exists yet.');
        }
        const data: { name?: string; timezone?: string } = {};
        if (parsed.data.name !== undefined) data.name = parsed.data.name;
        if (parsed.data.timezone !== undefined) {
          data.timezone = parsed.data.timezone;
        }
        const row = await tx.distribution.update({
          where: { id: dist.id },
          data,
        });
        await bumpConfigVersion(tx);
        return row;
      });
      deps.log.info('distribution.updated', undefined, {
        distributionId: updated.id,
      });
      sendSuccess(res, 200, {
        id: updated.id,
        name: updated.name,
        timezone: updated.timezone,
      });
    } catch (err) {
      if (err instanceof AppError) {
        sendError(res, err.code, err.message);
        return;
      }
      throw err;
    }
  });

  // POST /api/distribution/simulate — dry-run selection (Tier 2, T044):
  // live candidates + live counts through selectBroker with ZERO writes.
  router.post('/simulate', async (_req, res) => {
    const routingRepo = new PrismaBrokerRoutingRepository(deps.prisma, deps.clock);
    const [candidateRows, distributionTimezone, totalSentToday] =
      await Promise.all([
        routingRepo.findCandidates(),
        routingRepo.getDistributionTimezone(),
        routingRepo.getTotalSentToday(),
      ]);
    const selection = selectBroker(
      candidateRows.map((c) => ({
        broker: new Broker(c.state),
        nowInBrokerZone: c.nowInBrokerZone,
      })),
      totalSentToday,
      distributionTimezone,
    );
    sendSuccess(res, 200, selection);
  });

  router.put('/brokers', async (req, res) => {
    const { members } = distributionMembersInputSchema.parse(req.body);
    const distribution = await repo.findSingleton();
    if (distribution === null) {
      throw new AppError('NOT_FOUND', 'Create the distribution first.');
    }
    const brokerIds = members.map((m) => m.brokerId);
    const known = await deps.prisma.broker.count({
      where: { id: { in: brokerIds } },
    });
    if (known !== new Set(brokerIds).size) {
      throw new AppError('VALIDATION_ERROR', 'Validation failed.', {
        fields: { members: 'Unknown brokerId in member list.' },
      });
    }
    await repo.replaceMembersWithVersionBump(distribution.id, members);
    sendSuccess(res, 200, { members });
  });

  return router;
}
