import { Router } from 'express';

import type { Env } from '../../config/env';
import type { Logger } from '../../infrastructure/observability/logger';
import { JwtService } from '../../infrastructure/security/jwt.service';
import { NegativeSlugCache } from '../../infrastructure/persistence/cache/negative-slug-cache';
import { authRoutes } from './controllers/auth.controller';
import { brokerRoutes } from './controllers/broker.controller';
import { formRoutes } from './controllers/form.controller';
import { distributionRoutes } from './controllers/distribution.controller';
import { publicFormRoutes } from './controllers/public-form.controller';
import { publicLeadsRoutes } from './controllers/public-leads.controller';
import { leadsRoutes } from './controllers/leads.controller';
import {
  dashboardRoutes,
  brokerDetailHandler,
  distributionDetailRoutes,
} from './controllers/composite.controller';
import { opsRoutes } from './routes/ops.routes';
import type { PrismaClient } from '@prisma/client';
import type { LuxonClock } from '../../infrastructure/time/luxon-clock';
import type { MetricsRegistry } from '../../infrastructure/observability/metrics';

export interface ApiRouterDeps {
  env: Env;
  log: Logger;
  prisma: PrismaClient;
  clock: LuxonClock;
  metrics: MetricsRegistry;
}

/**
 * Composition of every user-story router. The negative-slug cache instance
 * is created ONCE per process and shared by the form controller (clear) and
 * the public controller (read) so invalidation is immediate.
 */
export function buildApiRouters(deps: ApiRouterDeps): Array<[string, Router]> {
  const jwt = new JwtService(deps.env.JWT_SECRET, deps.env.JWT_EXPIRES_IN);
  const negativeSlugCache = new NegativeSlugCache(deps.env.CONFIG_CACHE);

  return [
    [
      '/api/auth',
      authRoutes({ env: deps.env, log: deps.log, prisma: deps.prisma, jwt }),
    ],
    ['/api/brokers', brokerRoutes({ prisma: deps.prisma, clock: deps.clock })],
    [
      '/api/form',
      formRoutes({
        env: deps.env,
        log: deps.log,
        prisma: deps.prisma,
        negativeSlugCache,
      }),
    ],
    [
      '/api/distribution',
      distributionRoutes({
        log: deps.log,
        prisma: deps.prisma,
        clock: deps.clock,
      }),
    ],
    ['/api/public', publicFormRoutes({ prisma: deps.prisma, negativeSlugCache })],
    [
      '/api/public',
      publicLeadsRoutes({
        log: deps.log,
        prisma: deps.prisma,
        metrics: deps.metrics,
      }),
    ],
    [
      '/api/leads',
      leadsRoutes({ log: deps.log, prisma: deps.prisma, clock: deps.clock }),
    ],
    ['/api/dashboard', dashboardRoutes(deps)],
    ['/api/brokers', brokerDetailHandler(deps)],
    ['/api/distribution', distributionDetailRoutes(deps)],
    [
      '/api/ops',
      opsRoutes({
        prisma: deps.prisma,
        metrics: deps.metrics,
        log: deps.log,
      }),
    ],
  ];
}
