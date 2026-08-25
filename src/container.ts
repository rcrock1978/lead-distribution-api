import { PrismaClient } from '@prisma/client';

import type { Env } from './config/env';
import { createLogger, type Logger } from './infrastructure/observability/logger';
import { MetricsRegistry } from './infrastructure/observability/metrics';
import { LuxonClock } from './infrastructure/time/luxon-clock';
import { PrismaOutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import {
  OutboxConsumer,
  type MessageHandler,
} from './infrastructure/messaging/outbox-consumer';

/**
 * Explicit composition root (no DI framework). Everything swappable is
 * swapped HERE — e.g. CONFIG_CACHE=false exchanges the cached config
 * repository decorator for the plain one (research D12).
 */
export interface Container {
  env: Env;
  log: Logger;
  metrics: MetricsRegistry;
  clock: LuxonClock;
  prisma: PrismaClient;
  outboxPublisher: PrismaOutboxPublisher;
  buildConsumer(handlers: Map<string, MessageHandler>): OutboxConsumer;
}

export function buildContainer(env: Env, processName: string): Container {
  const log = createLogger(env, processName);
  const metrics = new MetricsRegistry();
  const clock = new LuxonClock();
  const prisma = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    // Pool sizing per plan.md: API connection_limit=8, worker connection_limit=4
    // is applied through DATABASE_URL query params at deployment time.
  });
  const outboxPublisher = new PrismaOutboxPublisher(prisma);

  return {
    env,
    log,
    metrics,
    clock,
    prisma,
    outboxPublisher,
    buildConsumer: (handlers) =>
      new OutboxConsumer({
        prisma,
        log,
        workerId:
          processName === 'lead-worker' ? env.WORKER_ID : `${env.WORKER_ID}-inline`,
        version: process.env.GIT_SHA ?? 'dev',
        handlers,
      }),
  };
}
