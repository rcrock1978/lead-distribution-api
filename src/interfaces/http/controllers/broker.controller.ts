import { Router } from 'express';

import { brokerInputSchema, brokerPatchSchema } from '../../../contracts';
import { AppError } from '../../../domain/errors/app-error';
import { BrokerService } from '../../../services/broker.service';
import type { PrismaClient } from '@prisma/client';
import type { LuxonClock } from '../../../infrastructure/time/luxon-clock';
import { sendSuccess } from '../middleware/error-handler';

export interface BrokerDeps {
  prisma: PrismaClient;
  clock: LuxonClock;
}

/** /api/brokers — admin CRUD over the thin service. */
export function brokerRoutes(deps: BrokerDeps): Router {
  const router = Router();
  const service = new BrokerService(deps.prisma, deps.clock);

  router.get('/', async (_req, res) => {
    sendSuccess(res, 200, await service.list());
  });

  router.post('/', async (req, res) => {
    const input = brokerInputSchema.parse(req.body);
    sendSuccess(res, 201, await service.create(input));
  });

  router.get('/:id', async (req, res) => {
    const id = Number.parseInt(req.params.id ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('NOT_FOUND', 'Broker not found.');
    }
    const broker = await service.get(id);
    if (broker === null) throw new AppError('NOT_FOUND', 'Broker not found.');
    sendSuccess(res, 200, broker);
  });

  router.patch('/:id', async (req, res) => {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const patch = brokerPatchSchema.parse(req.body);
    const broker = await service.update(id, patch);
    if (broker === null) throw new AppError('NOT_FOUND', 'Broker not found.');
    sendSuccess(res, 200, broker);
  });

  router.delete('/:id', async (req, res) => {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const result = await service.delete(id);
    switch (result) {
      case 'has_leads':
        throw new AppError(
          'BROKER_HAS_LEADS',
          'This broker has assigned leads. Deactivate it instead.',
        );
      case 'not_found':
        throw new AppError('NOT_FOUND', 'Broker not found.');
      default:
        res.status(204).end();
    }
  });

  return router;
}
