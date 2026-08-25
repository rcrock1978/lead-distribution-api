import type { Server } from 'node:http';

import {
  OutboxConsumer,
  type MessageHandler,
} from '../../../src/infrastructure/messaging/outbox-consumer';
import { RouteLeadUseCase } from '../../../src/application/use-cases/route-lead.use-case';
import { PrismaUnitOfWork } from '../../../src/infrastructure/persistence/prisma/prisma-unit-of-work';
import { PrismaLeadRepository } from '../../../src/infrastructure/persistence/prisma/prisma-lead.repository';
import { PrismaBrokerRoutingRepository } from '../../../src/infrastructure/persistence/prisma/prisma-broker-routing.repository';
import { PrismaCapGate } from '../../../src/infrastructure/persistence/prisma/prisma-cap-gate';
import { PrismaEmailGuard } from '../../../src/infrastructure/persistence/prisma/prisma-email-guard';
import { LuxonClock } from '../../../src/infrastructure/time/luxon-clock';
import { MetricsRegistry } from '../../../src/infrastructure/observability/metrics';
import { routeLeadHandler } from '../../../src/interfaces/worker/handlers/route-lead.handler';
import type { Logger } from '../../../src/infrastructure/observability/logger';
import type { TestApp } from '../../integration/helpers/test-app';

const silentLog: Logger = {
  child: () => silentLog,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * In-process worker for concurrency suites: the REAL OutboxConsumer +
 * REAL RouteLeadUseCase adapters over the SAME database the API writes to,
 * polling fast so drains complete inside test timeouts.
 */
export function startTestWorker(
  app: TestApp,
  opts: { pollIntervalMs?: number } = {},
): OutboxConsumer {
  const clock = new LuxonClock();
  const routeLeadUseCase = new RouteLeadUseCase({
    uow: new PrismaUnitOfWork(app.prisma),
    leads: new PrismaLeadRepository(app.prisma),
    brokers: new PrismaBrokerRoutingRepository(app.prisma, clock),
    capGate: new PrismaCapGate(app.prisma),
    emailGuard: new PrismaEmailGuard(app.prisma, () => clock.utcNow()),
    clock,
  });
  // Structural subset of Container consumed by routeLeadHandler.
  const handlerDeps = {
    prisma: app.prisma,
    log: silentLog,
    metrics: new MetricsRegistry(),
    routeLeadUseCase,
  };
  const handlers = new Map<string, MessageHandler>([
    ['LeadRoutingRequested', routeLeadHandler(handlerDeps as never)],
  ]);
  const consumer = new OutboxConsumer({
    prisma: app.prisma,
    log: silentLog,
    workerId: `worker-concurrency-${Math.random().toString(36).slice(2, 8)}`,
    version: 'test',
    handlers,
    pollIntervalMs: opts.pollIntervalMs ?? 40,
  });
  consumer.start();
  return consumer;
}

export async function drainOutbox(
  app: TestApp,
  opts: { expectMessages?: number; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const started = Date.now();
  for (;;) {
    const pending = await app.prisma.outbox.count({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
    });
    const processed = await app.prisma.outbox.count({
      where: { status: 'DONE' },
    });
    if (
      pending === 0 &&
      (opts.expectMessages === undefined || processed >= opts.expectMessages)
    ) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `outbox did not drain within ${timeoutMs}ms (pending=${pending} done=${processed})`,
      );
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

export async function postLead(
  baseUrl: string,
  body: { name: string; email: string; phone: string },
  ip: string,
  token = 'test-internal-token',
): Promise<Response> {
  return fetch(`${baseUrl}/api/public/leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': token,
      'x-client-ip': ip,
    },
    body: JSON.stringify(body),
  });
}

export type { Server };
