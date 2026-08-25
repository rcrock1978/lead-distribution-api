import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  startTestApp,
  type TestApp,
} from '../integration/helpers/test-app';
import { PrismaBrokerRoutingRepository } from '../../src/infrastructure/persistence/prisma/prisma-broker-routing.repository';
import { CachedDistributionConfigRepository } from '../../src/infrastructure/persistence/cache/cached-distribution-config.repository';
import { LuxonClock } from '../../src/infrastructure/time/luxon-clock';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import type { Logger } from '../../src/infrastructure/observability/logger';

const silentLog: Logger = {
  child: () => silentLog,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * T058 (Principle V gate): the version-gated cached config repository MUST
 * produce IDENTICAL routing inputs and outcomes to the plain repository.
 */
describe('cache parity: CONFIG_CACHE on vs off', () => {
  let app: TestApp;
  const clock = new LuxonClock();

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  let seedFormId = 1;

  async function seed(): Promise<void> {
    await app.prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
      'outbox',
      'assigned_emails',
      'leads',
      'broker_daily_counters',
      'distribution_brokers',
      'distributions',
      'forms',
      'brokers',
    ]) {
      await app.prisma.$executeRawUnsafe(`DELETE FROM \`${t}\``);
    }
    await app.prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    const form = await app.prisma.form.create({
      data: { name: 'Parity Form', slug: 'parity-form', singleton: true },
    });
    seedFormId = form.id;
    const dist = await app.prisma.distribution.create({
      data: {
        name: 'PD',
        formId: form.id,
        timezone: 'Asia/Manila',
        singleton: true,
      },
    });
    const pct = [50, 30, 20];
    for (let i = 0; i < 3; i += 1) {
      const broker = await app.prisma.broker.create({
        data: {
          name: `Broker-${i}`,
          isActive: i !== 2, // third inactive → exclusion rule parity too
          dailyCap: 10,
          timezone: 'Asia/Manila',
          openingTime: '00:00',
          closingTime: '23:59',
          workingDays: [1, 2, 3, 4, 5, 6, 7],
        },
      });
      await app.prisma.distributionBroker.create({
        data: {
          distributionId: dist.id,
          brokerId: broker.id,
          percentage: pct[i]!,
          isActiveInDistribution: true,
        },
      });
    }
  }

  async function routeSix(
    cached: boolean,
  ): Promise<Array<{ email: string; brokerId: number | null; reason: string | null }>> {
    const emails = Array.from(
      { length: 6 },
      (_, i) => `parity-${randomUUID().slice(0, 6)}-${i}@example.com`,
    );
    const results: Array<{
      email: string;
      brokerId: number | null;
      reason: string | null;
    }> = [];
    for (const email of emails) {
      const lead = await app.prisma.lead.create({
        data: {
          formId: seedFormId,
          name: 'Parity Runner',
          email,
          phone: '+63 917 700 0000',
          ipAddress: '203.0.113.170',
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
          payload: { leadId: lead.id, formId: seedFormId, email },
          traceId: lead.traceId,
        },
      });
      void cached;
      results.push({ email, brokerId: null, reason: null });
    }

    // Drain synchronously through the REAL consumer machinery is covered
    // elsewhere; here we only need deterministic sequential processing.
    const { RouteLeadUseCase } = await import(
      '../../src/application/use-cases/route-lead.use-case'
    );
    const { PrismaUnitOfWork } = await import(
      '../../src/infrastructure/persistence/prisma/prisma-unit-of-work'
    );
    const { PrismaLeadRepository } = await import(
      '../../src/infrastructure/persistence/prisma/prisma-lead.repository'
    );
    const { PrismaCapGate } = await import(
      '../../src/infrastructure/persistence/prisma/prisma-cap-gate'
    );
    const { PrismaEmailGuard } = await import(
      '../../src/infrastructure/persistence/prisma/prisma-email-guard'
    );
    const plain = new PrismaBrokerRoutingRepository(app.prisma, clock);
    const brokers = cached
      ? new CachedDistributionConfigRepository(
          plain,
          app.prisma,
          clock,
          new MetricsRegistry(),
          silentLog,
        )
      : plain;

    const useCase = new RouteLeadUseCase({
      uow: new PrismaUnitOfWork(app.prisma),
      leads: new PrismaLeadRepository(app.prisma),
      brokers,
      capGate: new PrismaCapGate(app.prisma),
      emailGuard: new PrismaEmailGuard(app.prisma, () => clock.utcNow()),
      clock,
    });

    const messages = await app.prisma.outbox.findMany({
      where: { type: 'LeadRoutingRequested', status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    for (const m of messages) {
      const payload = m.payload as { leadId: number; formId: number; email: string };
      await useCase.execute({
        messageId: m.id,
        traceId: m.traceId,
        payload,
      });
    }

    return Promise.all(
      results.map(async (r) => {
        const lead = await app.prisma.lead.findFirst({
          where: { email: r.email },
          select: { status: true, brokerId: true, failureReason: true },
        });
        return {
          email: r.email,
          brokerId: lead?.brokerId ?? null,
          reason:
            lead?.status === 'UNSENT' ? (lead.failureReason ?? '') : '',
        };
      }),
    );
  }

  it('identical assignment sequence and exclusions with the decorator active', async () => {
    async function memberIds(): Promise<number[]> {
      const rows = await app.prisma.distributionBroker.findMany({
        orderBy: { brokerId: 'asc' },
        select: { brokerId: true },
      });
      return rows.map((r) => r.brokerId);
    }

    await seed();
    const plainIds = await memberIds();
    const plainRun = await routeSix(false);

    await seed();
    // Two passes so the FIRST populates the cache (miss) and the SECOND hits.
    await routeSix(true);
    await seed();
    const cachedIds = await memberIds();
    const cachedRun = await routeSix(true);

    // Auto-increment shifts raw ids between seeds — compare the ASSIGNMENT
    // PATTERN via each run's own member ordering.
    const toOrdinals = (ids: number[], run: Array<{ brokerId: number | null }>) =>
      run.map((r) => {
        const i = ids.indexOf(r.brokerId ?? -1);
        return i === -1 ? null : i;
      });
    expect(toOrdinals(cachedIds, cachedRun)).toEqual(
      toOrdinals(plainIds, plainRun),
    );
    expect(cachedRun.map((r) => r.reason)).toEqual(
      plainRun.map((r) => r.reason),
    );

    // Direct read parity for candidates + timezone under identical state.
    const plain = new PrismaBrokerRoutingRepository(app.prisma, clock);
    const decorated = new CachedDistributionConfigRepository(
      plain,
      app.prisma,
      clock,
      new MetricsRegistry(),
      silentLog,
    );
    const [a, b] = await Promise.all([
      plain.findCandidates(),
      decorated.findCandidates(),
    ]);
    expect(b.map((c) => c.state)).toEqual(a.map((c) => c.state));
    expect(await decorated.getDistributionTimezone()).toBe(
      await plain.getDistributionTimezone(),
    );
  });
});
