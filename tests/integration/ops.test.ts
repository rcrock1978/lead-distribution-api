import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from './helpers/test-app';

/** Smoke coverage for the US5 ops surface (T052/T053/T055). */
describe('ops endpoints', () => {
  let app: TestApp;
  let cookie: string;

  beforeAll(async () => {
    app = await startTestApp();
    const session = await loginAdmin(app.baseUrl);
    cookie = session.cookie;
    // Generate traffic so middleware histogram has samples.
    await api(app.baseUrl, 'GET', '/api/health');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/ops/metrics returns counters/gauges/histograms incl. middleware percentiles', async () => {
    const res = await api(app.baseUrl, 'GET', '/api/ops/metrics', { cookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: {
      counters: Record<string, number>;
      gauges: Record<string, number>;
      histograms: Record<string, { p50: number; p95: number; p99: number; count: number }>;
    } }).data;

    expect(data.gauges['outbox_pending_depth']).toBe(0);
    const mw = Object.keys(data.histograms).find((k) =>
      k.startsWith('middleware_duration_ms'),
    );
    expect(mw).toBeDefined();
    expect(data.histograms[mw!]!.count).toBeGreaterThan(0);
  });

  it('GET /api/ops/outbox reports empty depths on a fresh database', async () => {
    const res = await api(app.baseUrl, 'GET', '/api/ops/outbox', { cookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: {
      depths: Record<string, number>;
      oldestPendingAgeMs: number | null;
      dead: unknown[];
    } }).data;
    expect(data.depths.pending ?? 0).toBe(0);
    expect(data.oldestPendingAgeMs).toBeNull();
    expect(data.dead).toEqual([]);
  });

  it('POST /api/ops/outbox/:id/replay 404s for unknown ids', async () => {
    const res = await api(
      app.baseUrl,
      'POST',
      '/api/ops/outbox/does-not-exist/replay',
      { cookie },
    );
    expect(res.status).toBe(404);
  });

  it('GET /api/ops/logs/tail notes missing OPS_LOG_FILES config', async () => {
    delete process.env.OPS_LOG_FILES;
    const res = await api(app.baseUrl, 'GET', '/api/ops/logs/tail?n=5', { cookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: { events: unknown[]; note?: string } }).data;
    expect(data.events).toEqual([]);
    expect(data.note).toContain('OPS_LOG_FILES');
  });
});
