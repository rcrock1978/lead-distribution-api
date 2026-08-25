import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from './helpers/test-app';
import { postLead } from '../concurrency/helpers/worker';
import {
  OutboxConsumer,
  type MessageHandler,
} from '../../src/infrastructure/messaging/outbox-consumer';
import { LuxonClock } from '../../src/infrastructure/time/luxon-clock';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { PrismaUnitOfWork } from '../../src/infrastructure/persistence/prisma/prisma-unit-of-work';
import { PrismaLeadRepository } from '../../src/infrastructure/persistence/prisma/prisma-lead.repository';
import { PrismaBrokerRoutingRepository } from '../../src/infrastructure/persistence/prisma/prisma-broker-routing.repository';
import { PrismaCapGate } from '../../src/infrastructure/persistence/prisma/prisma-cap-gate';
import { PrismaEmailGuard } from '../../src/infrastructure/persistence/prisma/prisma-email-guard';
import { RouteLeadUseCase } from '../../src/application/use-cases/route-lead.use-case';
import { routeLeadHandler } from '../../src/interfaces/worker/handlers/route-lead.handler';
import type { Logger } from '../../src/infrastructure/observability/logger';

const silentLog: Logger = {
  child: () => silentLog,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * T051 [US5]: readiness semantics vs worker liveness, ordered draining of a
 * backlog accumulated while the worker was DOWN, and the DEAD→replay path.
 */
describe('readiness + outbox resilience', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
    await app.prisma.form.create({
      data: { name: 'Res Form', slug: 'res-form', singleton: true },
    });
    const broker = await app.prisma.broker.create({
      data: {
        name: 'Res Broker',
        isActive: true,
        dailyCap: 0,
        timezone: 'Asia/Manila',
        openingTime: '00:00',
        closingTime: '23:59',
        workingDays: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    await app.prisma.distribution.create({
      data: {
        name: 'RD',
        formId: 1,
        timezone: 'Asia/Manila',
        singleton: true,
        members: {
          create: { brokerId: broker.id, percentage: 100, isActiveInDistribution: true },
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function makeConsumer(throwOnDeadMarker: boolean): OutboxConsumer {
    const clock = new LuxonClock();
    const useCase = new RouteLeadUseCase({
      uow: new PrismaUnitOfWork(app.prisma),
      leads: new PrismaLeadRepository(app.prisma),
      brokers: new PrismaBrokerRoutingRepository(app.prisma, clock),
      capGate: new PrismaCapGate(app.prisma),
      emailGuard: new PrismaEmailGuard(app.prisma, () => clock.utcNow()),
      clock,
    });
    const inner = routeLeadHandler({
      prisma: app.prisma,
      log: silentLog,
      metrics: new MetricsRegistry(),
      routeLeadUseCase: useCase,
    } as never);
    const handler: MessageHandler = async (payload, meta) => {
      if (
        throwOnDeadMarker &&
        (payload as { email?: string }).email?.startsWith('dead-')
      ) {
        throw new Error('synthetic handler failure');
      }
      await inner(payload, meta);
    };
    return new OutboxConsumer({
      prisma: app.prisma,
      log: silentLog,
      workerId: `w-${randomUUID().slice(0, 8)}`,
      version: 'test',
      handlers: new Map([['LeadRoutingRequested', handler]]),
      pollIntervalMs: 40,
    });
  }

  it('readiness flips 503→200 with the worker lifecycle; backlog routes in order on resume', async () => {
    const admin = await loginAdmin(app.baseUrl);

    // Worker never beat in this app's lifetime → not ready.
    const before = await api(app.baseUrl, 'GET', '/api/health/ready');
    expect(before.status).toBe(503);
    expect(before.text).toContain('worker_heartbeat');

    // Accumulate a backlog WHILE down: three sequential captures.
    for (let i = 0; i < 3; i += 1) {
      const r = await postLead(app.baseUrl, {
        name: `Backlog ${i}`,
        email: `backlog-${i}-${randomUUID().slice(0, 6)}@example.com`,
        phone: '+63 917 500 0000',
      }, `203.0.113.${150 + i}`);
      expect(r.status).toBe(202);
    }
    const pendingCount = await app.prisma.outbox.count({ where: { status: 'PENDING' } });
    expect(pendingCount).toBe(3);

    // "Resume": start the worker; everything drains SENT in submission order.
    const worker = makeConsumer(false);
    worker.start();
    try {
      const deadline = Date.now() + 15_000;
      let sentRows: Array<{ id: number; assignedAt: Date | null }> = [];
      for (;;) {
        sentRows = await app.prisma.lead.findMany({
          where: { status: 'SENT' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, assignedAt: true },
        });
        if (sentRows.length >= 3 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      expect(sentRows.length).toBe(3);
      const times = sentRows.map((r) => r.assignedAt!.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times); // FIFO order

      // With fresh beats, readiness goes green.
      const ready = await api(app.baseUrl, 'GET', '/api/health/ready');
      expect(ready.status, ready.text).toBe(200);
      void admin;
    } finally {
      await worker.stop();
    }
  });

  it('messages DIE after 5 failed attempts; ops replay returns them to PENDING', async () => {
    // Seed a poison message.
    const lead = await app.prisma.lead.create({
      data: {
        formId: 1,
        name: 'Poison',
        email: 'dead-poison@example.com',
        phone: '+63 917 600 0000',
        ipAddress: '203.0.113.160',
        status: 'UNSENT',
        decisionTrace: {},
        traceId: randomUUID().replaceAll('-', ''),
      },
    });
    await app.prisma.outbox.create({
      data: {
        id: randomUUID(),
        type: 'LeadRoutingRequested',
        aggregateType: 'Lead',
        aggregateId: String(lead.id),
        payload: { leadId: lead.id, formId: 1, email: 'dead-poison@example.com' },
        traceId: lead.traceId,
      },
    });

    const worker = makeConsumer(true);
    worker.start();

    // Accelerate the backoff ladder: push attempts to 4 so the NEXT failure
    // crosses MAX_ATTEMPTS=5 without real-time sleeping through 1+4+16+64s.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const msg = await app.prisma.outbox.findFirst({
        where: { aggregateId: String(lead.id), status: 'PENDING' },
      });
      if (msg === null) break;
      if (msg.attempts < 4) {
        await app.prisma.outbox.update({
          where: { id: msg.id },
          data: { attempts: 4, availableAt: new Date(Date.now() - 1000) },
        });
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 80));
      const done = await app.prisma.outbox.findFirst({
        where: { aggregateId: String(lead.id), status: 'DEAD' },
      });
      if (done !== null) break;
    }
    await worker.stop();

    const dead = await app.prisma.outbox.findFirst({
      where: { aggregateId: String(lead.id), status: 'DEAD' },
    });
    expect(dead).not.toBeNull();

    const admin = await loginAdmin(app.baseUrl);

    // Ops surface shows it; replay flips it back to PENDING.
    const ops = await api(app.baseUrl, 'GET', '/api/ops/outbox', { cookie: admin.cookie });
    expect(ops.status).toBe(200);
    const opsBody = (ops.body as { data: { depths: Record<string, number>; dead: unknown[] } }).data;
    expect(opsBody.depths.dead ?? 0).toBeGreaterThanOrEqual(1);
    expect(opsBody.dead.length).toBeGreaterThanOrEqual(1);

    const replay = await api(
      app.baseUrl,
      'POST',
      `/api/ops/outbox/${dead!.id}/replay`,
      { cookie: admin.cookie },
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ data: { replayed: true } });
    const after = await app.prisma.outbox.findUnique({ where: { id: dead!.id } });
    expect(after?.status).toBe('PENDING');
    expect(after?.attempts).toBe(0);
  });
});
