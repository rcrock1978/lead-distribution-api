import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from './helpers/test-app';

const TOKEN = 'test-internal-token';

describe('public lead capture + rate limiting (US2, T035/T036)', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp({
      envOverrides: { PUBLIC_RATE_LIMIT_PER_MIN: '3' },
    });
    baseUrl = app.baseUrl;
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedFormAndDistribution(): Promise<void> {
    // Clear only capture-related tables — the users row seeded by
    // startTestApp must survive (loginAdmin depends on it).
    await app.prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
      'outbox',
      'assigned_emails',
      'leads',
      'distribution_brokers',
      'distributions',
      'forms',
    ]) {
      await app.prisma.$executeRawUnsafe(`DELETE FROM \`${t}\``);
    }
    await app.prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    const form = await app.prisma.form.create({
      data: { name: 'Capture Form', slug: 'capture-form', singleton: true },
    });
    await app.prisma.distribution.create({
      data: {
        name: 'Dist',
        formId: form.id,
        timezone: 'Asia/Manila',
        singleton: true,
      },
    });
  }

  it('captures valid submission: identical 202 + Lead UNSENT + Outbox LeadRoutingRequested sharing traceId', async () => {
    await seedFormAndDistribution();

    const traceId = randomUUID().replaceAll('-', '');
    const res = await fetch(`${baseUrl}/api/public/leads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': TOKEN,
        'x-trace-id': traceId,
        'x-client-ip': '203.0.113.77',
      },
      body: JSON.stringify({
        name: 'Alice Smith',
        email: 'Alice@Example.COM',
        phone: '+63 917 100 0000',
        website: '',
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      success: boolean;
      data: { received: boolean };
      traceId: string;
    };
    expect(body.success).toBe(true);
    expect(body.data.received).toBe(true);
    expect(body.traceId).toBe(traceId);

    const leads = await app.prisma.lead.findMany();
    expect(leads.length).toBe(1);
    const lead = leads[0]!;
    expect(lead.status).toBe('UNSENT');
    expect(lead.email).toBe('alice@example.com');
    expect(lead.name).toBe('Alice Smith');
    expect(lead.ipAddress).toBe('203.0.113.77');
    expect(lead.traceId).toBe(traceId);

    const outbox = await app.prisma.outbox.findMany();
    expect(outbox.length).toBe(1);
    expect(outbox[0]!.type).toBe('LeadRoutingRequested');
    expect(outbox[0]!.traceId).toBe(traceId);
    expect(outbox[0]!.aggregateId).toBe(String(lead.id));
  });

  it('invalid payload → 422 and nothing persisted', async () => {
    await seedFormAndDistribution();

    const res = await fetch(`${baseUrl}/api/public/leads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': TOKEN,
        'x-client-ip': '203.0.113.78',
      },
      body: JSON.stringify({ name: 'Bob', email: 'not-an-email', phone: '123' }),
    });
    expect(res.status).toBe(422);
    expect(await app.prisma.lead.count()).toBe(0);
    expect(await app.prisma.outbox.count()).toBe(0);
  });

  it('honeypot filled → rejected server-side too (edge normally swallows it)', async () => {
    const res = await fetch(`${baseUrl}/api/public/leads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': TOKEN,
        'x-client-ip': '203.0.113.79',
      },
      body: JSON.stringify({
        name: 'Bot Bot',
        email: 'bot@example.com',
        phone: '+63 917 100 0001',
        website: 'http://spam.example',
      }),
    });
    expect(res.status).toBe(422);
  });

  it('missing internal token on public route → 401', async () => {
    const res = await fetch(`${baseUrl}/api/public/form/capture-form`);
    expect(res.status).toBe(401);
  });

  it('rate limit: limit+1 from one IP → 429 with Retry-After; other IP unaffected; admin never limited', async () => {
    const post = (ip: string) =>
      fetch(`${baseUrl}/api/public/leads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': TOKEN,
          'x-client-ip': ip,
        },
        body: JSON.stringify({
          name: 'Rate Tester',
          email: `rate-${Math.random().toString(36).slice(2)}@example.com`,
          phone: '+63 917 200 0000',
        }),
      });

    for (let i = 0; i < 3; i += 1) {
      const ok = await post('198.51.100.1');
      expect(ok.status).toBe(202);
    }
    const limited = await post('198.51.100.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    const limitedBody = (await limited.json()) as { error: { code: string } };
    expect(limitedBody.error.code).toBe('RATE_LIMITED');

    // A different IP still passes.
    const other = await post('198.51.100.2');
    expect(other.status).toBe(202);

    // Admin traffic sits outside the limiter's mount point.
    const admin = await loginAdmin(baseUrl);
    for (let i = 0; i < 5; i += 1) {
      const r = await api(baseUrl, 'GET', '/api/brokers', {
        cookie: admin.cookie,
      });
      expect(r.status).toBe(200);
    }
  });
});
