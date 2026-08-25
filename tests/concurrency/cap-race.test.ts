import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startTestApp,
  type TestApp,
} from '../integration/helpers/test-app';
import { drainOutbox, postLead, startTestWorker } from './helpers/worker';
import type { OutboxConsumer } from '../../src/infrastructure/messaging/outbox-consumer';

/**
 * T038 (Tier 0 — SC-004 / quickstart S7): twenty parallel distinct-email
 * submissions against a single broker capped at 5. EXACTLY five
 * assignments, zero overage — INV-4's conditional counter is unbreakable.
 */
describe('cap race: 20 parallel submissions vs cap of 5', () => {
  let app: TestApp;
  let worker: OutboxConsumer;

  beforeAll(async () => {
    app = await startTestApp();
    await app.prisma.form.create({
      data: { name: 'Cap Form', slug: 'cap-form', singleton: true },
    });
    const broker = await app.prisma.broker.create({
      data: {
        name: 'Capped Broker',
        isActive: true,
        dailyCap: 5,
        timezone: 'Asia/Manila',
        openingTime: '00:00',
        closingTime: '23:59',
        workingDays: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    await app.prisma.distribution.create({
      data: {
        name: 'Dist',
        formId: 1,
        timezone: 'Asia/Manila',
        singleton: true,
        members: {
          create: {
            brokerId: broker.id,
            percentage: 100,
            isActiveInDistribution: true,
          },
        },
      },
    });
    worker = startTestWorker(app);
  });

  afterAll(async () => {
    await worker.stop();
    await app.close();
  });

  it('assigns exactly 5, leaves 15 UNSENT with named reason, counter exact', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postLead(app.baseUrl, {
          name: `Cap Runner ${i + 1}`,
          email: `cap-runner-${i + 1}@example.com`,
          phone: '+63 917 400 0001',
        }, `198.51.100.${i + 1}`),
      ),
    );
    for (const r of responses) expect(r.status).toBe(202);

    await drainOutbox(app, { expectMessages: 20 });

    const leads = await app.prisma.lead.findMany();
    expect(leads.length).toBe(20);

    const sent = leads.filter((l) => l.status === 'SENT');
    const unsent = leads.filter((l) => l.status === 'UNSENT');
    expect(sent.length).toBe(5);
    expect(unsent.length).toBe(15);
    for (const u of unsent) {
      // Reason names no-eligibility OR exhausted contention; EITHER way the
      // persisted trace must name the 'capped' rule (FR-019 transparency).
      expect(['NO_ELIGIBLE_BROKER', 'CAP_CONTENTION_EXHAUSTED']).toContain(
        u.failureReason,
      );
      const trace = u.decisionTrace as {
        exclusions?: Array<{ brokerId: number; rule: string }>;
      };
      const rules = (trace.exclusions ?? []).map((e) => e.rule);
      expect(rules).toContain('capped');
    }
    expect(sent.every((s) => s.brokerId !== null)).toBe(true);

    // INV-4: the shared counter equals assignments EXACTLY — never over.
    const counters = await app.prisma.brokerDailyCounter.findMany();
    const totalClaimed = counters.reduce((sum, c) => sum + c.sentCount, 0);
    expect(totalClaimed).toBe(5);

    const claims = await app.prisma.assignedEmail.findMany();
    expect(claims.length).toBe(5);
  });
});
