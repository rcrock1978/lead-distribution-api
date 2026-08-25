import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startTestApp,
  type TestApp,
} from '../integration/helpers/test-app';
import { drainOutbox, postLead, startTestWorker } from './helpers/worker';
import type { OutboxConsumer } from '../../src/infrastructure/messaging/outbox-consumer';

/**
 * T032 (Tier 0 — SC-003): ten PARALLEL submissions of one NEW email against
 * real HTTP. Exactly one may end SENT; the other nine MUST be DUPLICATE via
 * the AssignedEmail PK collision. Nothing lost, nothing double-assigned.
 */
describe('duplicate race: 10 parallel submissions of one new email', () => {
  let app: TestApp;
  let worker: OutboxConsumer;

  beforeAll(async () => {
    app = await startTestApp();
    await app.prisma.form.create({
      data: { name: 'Race Form', slug: 'race-form', singleton: true },
    });
    const broker = await app.prisma.broker.create({
      data: {
        name: 'Solo Broker',
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

  it('ends with exactly 1 SENT + 9 DUPLICATE and a single AssignedEmail row', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postLead(app.baseUrl, {
          name: 'Racey McRaceface',
          email: 'once-only@example.com',
          phone: '+63 917 300 0001',
        }, `203.0.113.${100 + i}`),
      ),
    );
    for (const r of responses) {
      expect(r.status).toBe(202); // identical envelope regardless of outcome
    }

    await drainOutbox(app, { expectMessages: 10 });

    const leads = await app.prisma.lead.findMany();
    expect(leads.length).toBe(10);

    const sent = leads.filter((l) => l.status === 'SENT');
    const dupes = leads.filter((l) => l.status === 'DUPLICATE');
    expect(sent.length).toBe(1);
    expect(dupes.length).toBe(9);

    // INV-3 hard proof: exactly one permanent claim row exists.
    const claims = await app.prisma.assignedEmail.findMany();
    expect(claims.length).toBe(1);
    expect(claims[0]!.email).toBe('once-only@example.com');
    expect(claims[0]!.brokerId).toBe(sent[0]!.brokerId);

    for (const d of dupes) {
      expect(d.failureReason).toBe('DUPLICATE_EMAIL');
      expect(d.brokerId).toBe(sent[0]!.brokerId);
    }
  });
});
