import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from '../integration/helpers/test-app';
import { drainOutbox, postLead, startTestWorker } from '../concurrency/helpers/worker';
import type { OutboxConsumer } from '../../src/infrastructure/messaging/outbox-consumer';

/**
 * T059 (Constitution VI / quickstart S12): budget gates.
 *  - middleware p95 < 5ms over a 200-request burst
 *  - capture p95 < 120ms (http_request_duration_ms{route="capture"})
 *  - capture→assignment p95 < 3000ms
 */
describe('performance budgets', () => {
  let app: TestApp;
  let worker: OutboxConsumer;
  let cookie: string;

  beforeAll(async () => {
    app = await startTestApp();
    const session = await loginAdmin(app.baseUrl);
    cookie = session.cookie;
    await app.prisma.form.create({
      data: { name: 'Budget Form', slug: 'budget-form', singleton: true },
    });
    const broker = await app.prisma.broker.create({
      data: {
        name: 'Budget Broker',
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
        name: 'BD',
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
    if (worker) await worker.stop();
    await app.close();
  });

  async function metricsPayload(): Promise<{
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, { count: number; p50: number; p95: number; p99: number }>;
  }> {
    const res = await api(app.baseUrl, 'GET', '/api/ops/metrics', { cookie });
    expect(res.status).toBe(200);
    return (res.body as { data: typeof res.body extends never ? never : Parameters<JSON['parse']>['0'] extends never ? never : any }).data;
  }

  it('middleware p95 stays under 5ms across a 200-request burst', async () => {
    for (let i = 0; i < 200; i += 1) {
      await api(app.baseUrl, 'GET', '/api/health');
    }
    const data = await metricsPayload();
    const key = Object.keys(data.histograms).find(
      (k) => k.startsWith('middleware_duration_ms'),
    );
    expect(key).toBeDefined();
    expect(data.histograms[key!]!.count).toBeGreaterThanOrEqual(200);
    expect(data.histograms[key!]!.p95).toBeLessThan(5);
  });

  it('capture p95 stays under 120ms over a 20-POST burst', async () => {
    for (let i = 0; i < 20; i += 1) {
      const r = await postLead(app.baseUrl, {
        name: `Budget Runner ${i}`,
        email: `budget-${randomUUID().slice(0, 8)}@example.com`,
        phone: '+63 917 800 0000',
      }, `203.0.113.${180 + i}`);
      expect(r.status).toBe(202);
    }
    const data = await metricsPayload();
    const captureKey = Object.keys(data.histograms).find(
      (k) =>
        k.startsWith('http_request_duration_ms') &&
        k.includes('route="capture"') &&
        k.includes('method="POST"'),
    );
    if (!captureKey) {
    }
    expect(captureKey).toBeDefined();
    expect(data.histograms[captureKey!]!.count).toBe(20);
    expect(data.histograms[captureKey!]!.p95).toBeLessThan(120);
  });

  it('capture-to-assignment p95 stays under 3s', async () => {
    worker = startTestWorker(app, { pollIntervalMs: 40 });
    for (let i = 0; i < 10; i += 1) {
      const r = await postLead(app.baseUrl, {
        name: `Latency Runner ${i}`,
        email: `lat-${randomUUID().slice(0, 8)}@example.com`,
        phone: '+63 917 900 0000',
      }, `198.51.101.${i + 1}`);
      expect(r.status).toBe(202);
    }
    await drainOutbox(app, { expectMessages: 10 });

    const data = await metricsPayload();
    const latKey = Object.keys(data.histograms).find((k) =>
      k.startsWith('lead_capture_to_assign_ms'),
    );
    expect(latKey).toBeDefined();
    expect(data.histograms[latKey!]!.count).toBeGreaterThanOrEqual(10);
    expect(data.histograms[latKey!]!.p95).toBeLessThan(3000);
  });

  it('dashboard composite is complete in ONE response (no second round-trip)', async () => {
    const res = await api(app.baseUrl, 'GET', '/api/dashboard/summary', { cookie });
    const d = (res.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(d).sort()).toEqual([
      'leadCounts',
      'recentLeads',
      'setup',
      'worker',
    ]);
    expect(d.setup).toHaveProperty('hasForm');
    expect(d.setup).toHaveProperty('workerHealthy');
  });
});
