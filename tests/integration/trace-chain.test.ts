import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  startTestApp,
  type TestApp,
} from '../integration/helpers/test-app';
import { drainOutbox, postLead, startTestWorker } from '../concurrency/helpers/worker';
import type { OutboxConsumer } from '../../src/infrastructure/messaging/outbox-consumer';
import type { Logger } from '../../src/infrastructure/observability/logger';

type Line = { level: string; event: string; fields: Record<string, unknown> };

/** Capturing logger — records every event for correlation assertions. */
function makeRecorder(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const push =
    (level: string) =>
    (event: string, msg?: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, event, fields: fields ?? {} });
      void msg;
    };
  const rec = {
    lines,
    child: () => rec,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
  return rec as unknown as Logger & { lines: Line[] };
}

/**
 * §19.4 observability case, automated: one submitted lead must produce a
 * correlated event chain — `lead.captured` in the API process and the
 * routing outcome event in the worker process — all sharing ONE traceId,
 * with that same id persisted on both the Lead row and its Outbox row.
 */
describe('trace chain across processes', () => {
  let app: TestApp;
  let worker: OutboxConsumer;
  const apiRec = makeRecorder();
  const workerRec = makeRecorder();

  beforeAll(async () => {
    app = await startTestApp({ log: apiRec });
    await app.prisma.form.create({
      data: { name: 'Chain Form', slug: 'chain-form', singleton: true },
    });
    const broker = await app.prisma.broker.create({
      data: {
        name: 'Chain Broker',
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
        name: 'CD',
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
    worker = startTestWorker(app, { log: workerRec });
  });

  afterAll(async () => {
    await worker.stop();
    await app.close();
  });

  it('lead.captured → lead.routed share one traceId, persisted on Lead + Outbox', async () => {
    const email = `chain-${randomUUID().slice(0, 8)}@example.com`;
    const res = await postLead(app.baseUrl, {
      name: 'Chain Runner',
      email,
      phone: '+63 917 950 0000',
    }, `203.0.113.190`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { traceId: string; data: { received: boolean } };
    const T = body.traceId;
    expect(T).toMatch(/^[0-9a-f]{32}$/);

    await drainOutbox(app, { expectMessages: 1 });

    // Persisted correlation: Lead row and Outbox row carry the SAME id.
    const lead = await app.prisma.lead.findFirst({ where: { email } });
    expect(lead?.traceId).toBe(T);
    const msg = await app.prisma.outbox.findFirst({
      where: { aggregateId: String(lead!.id) },
    });
    expect(msg?.traceId).toBe(T);

    // API-process event
    const captured = apiRec.lines.find(
      (l) => l.event === 'lead.captured' && l.fields.traceId === T,
    );
    expect(captured).toBeDefined();

    // Worker-process outcome event with the SAME id
    const routed = workerRec.lines.find(
      (l) =>
        ['lead.routed', 'lead.duplicate', 'lead.unsent'].includes(l.event) &&
        l.fields.traceId === T,
    );
    expect(routed).toBeDefined();

    // And the visitor's envelope echoed it back for support workflows.
    expect(body.data.received).toBe(true);
  });
});
