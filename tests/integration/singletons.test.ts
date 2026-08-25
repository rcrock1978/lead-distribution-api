import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from './helpers/test-app';

/**
 * Singleton invariants must hold through EVERY channel: the admin UI hits the
 * same API as any direct caller. These tests exercise direct calls both with
 * and without credentials/internal token.
 */
describe('singleton guards (integration)', () => {
  let app: TestApp;
  let session: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    app = await startTestApp();
    session = await loginAdmin(app.baseUrl);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a distribution before any form exists with the exact contract message', async () => {
    const res = await api(app.baseUrl, 'POST', '/api/distribution', {
      body: { name: 'National Pool', timezone: 'Asia/Manila' },
      cookie: session.cookie,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'FORM_REQUIRED' } });
    const message = (res.body as { error?: { message?: string } }).error?.message;
    expect(message).toBe('Oops, please create a form first.');
  });

  it('creates exactly one form — a second attempt 409s FORM_ALREADY_EXISTS', async () => {
    const first = await api(app.baseUrl, 'POST', '/api/form', {
      body: { name: 'Main Intake' },
      cookie: session.cookie,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      data: { name: 'Main Intake', slug: 'main-intake' },
    });

    const second = await api(app.baseUrl, 'POST', '/api/form', {
      body: { name: 'Another Form' },
      cookie: session.cookie,
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'FORM_ALREADY_EXISTS' } });
  });

  it('binds the distribution to the existing form; a second one 409s', async () => {
    const first = await api(app.baseUrl, 'POST', '/api/distribution', {
      body: { name: 'National Pool', timezone: 'Asia/Manila' },
      cookie: session.cookie,
    });
    expect(first.status).toBe(201);
    // formId auto-bound to the single form row:
    expect(first.body).toMatchObject({ data: { formId: expect.any(Number) } });

    const second = await api(app.baseUrl, 'POST', '/api/distribution', {
      body: { name: 'Second Pool', timezone: 'UTC' },
      cookie: session.cookie,
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: { code: 'DISTRIBUTION_ALREADY_EXISTS' },
    });
  });

  it('refuses broker deletion while the broker holds leads (deactivate instead)', async () => {
    const broker = await api(app.baseUrl, 'POST', '/api/brokers', {
      body: {
        name: 'Alpha Broker',
        dailyCap: 10,
        timezone: 'Asia/Manila',
        openingTime: '09:00',
        closingTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      },
      cookie: session.cookie,
    });
    expect(broker.status).toBe(201);
    const brokerId = (broker.body as { data: { id: number } }).data.id;

    // A lead referencing this broker exists → deletion must be refused.
    await app.prisma.lead.create({
      data: {
        formId: 1,
        name: 'Existing Customer',
        email: 'taken@example.com',
        phone: '+63 917 000 0000',
        ipAddress: '127.0.0.1',
        status: 'SENT',
        brokerId,
        assignmentType: 'AUTO',
        traceId: 'f'.repeat(32),
        decisionTrace: {},
      },
    });

    const del = await api(app.baseUrl, 'DELETE', `/api/brokers/${brokerId}`, {
      cookie: session.cookie,
    });
    expect(del.status).toBe(409);

    const stillThere = await api(app.baseUrl, 'GET', `/api/brokers/${brokerId}`, {
      cookie: session.cookie,
    });
    expect(stillThere.status).toBe(200);
  });

  it('rejects admin writes carrying a WRONG internal token even with a valid cookie', async () => {
    const res = await api(app.baseUrl, 'POST', '/api/brokers', {
      body: {
        name: 'Sneaky Broker',
        dailyCap: 5,
        timezone: 'UTC',
        openingTime: '00:00',
        closingTime: '23:59',
        workingDays: [1],
      },
      cookie: session.cookie,
      internalToken: 'wrong-token-value',
    });
    expect(res.status).toBe(401);

    // Sanity: the SAME request with the correct token succeeds.
    const ok = await api(app.baseUrl, 'POST', '/api/brokers', {
      body: {
        name: 'Honest Broker',
        dailyCap: 5,
        timezone: 'UTC',
        openingTime: '00:00',
        closingTime: '23:59',
        workingDays: [1],
      },
      cookie: session.cookie,
      internalToken: 'test-internal-token',
    });
    expect(ok.status).toBe(201);
  });
});
