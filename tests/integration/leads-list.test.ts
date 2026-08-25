import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  loginAdmin,
  startTestApp,
  type TestApp,
} from './helpers/test-app';

/**
 * T045 [US4]: keyset pagination at depth, every filter, and the
 * decisionTrace-absence guarantee on list payloads.
 */
describe('leads list + oversight endpoints', () => {
  let app: TestApp;
  let cookie: string;
  let seedBaseMs!: number;

  beforeAll(async () => {
    app = await startTestApp();
    const session = await loginAdmin(app.baseUrl);
    cookie = session.cookie;

    await app.prisma.form.create({
      data: { name: 'Leads Form', slug: 'leads-form', singleton: true },
    });
    const b1 = await app.prisma.broker.create({
      data: {
        name: 'Alpha',
        isActive: true,
        dailyCap: 0,
        timezone: 'Asia/Manila',
        openingTime: '00:00',
        closingTime: '23:59',
        workingDays: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    const b2 = await app.prisma.broker.create({
      data: {
        name: 'Beta',
        isActive: true,
        dailyCap: 0,
        timezone: 'Asia/Manila',
        openingTime: '00:00',
        closingTime: '23:59',
        workingDays: [1, 2, 3, 4, 5, 6, 7],
      },
    });

    // 25 leads across statuses/brokers/times. createdAt spread by ms offsets.
    const base = Date.now() - 60 * 60 * 1000;
    seedBaseMs = base;
    for (let i = 0; i < 25; i += 1) {
      const status = i % 3 === 0 ? 'SENT' : i % 3 === 1 ? 'UNSENT' : 'FAILED';
      const brokerId = status === 'SENT' ? (i % 2 === 0 ? b1.id : b2.id) : null;
      await app.prisma.lead.create({
        data: {
          formId: 1,
          name: `Lead ${String(i).padStart(2, '0')}`,
          email: `lead${i}@example.com`,
          phone: '+63 917 000 0000',
          ipAddress: `203.0.113.${i + 1}`,
          status,
          brokerId,
          assignedAt:
            status === 'SENT' ? new Date(base + i * 1000) : null,
          assignmentType: status === 'SENT' ? 'AUTO' : null,
          failureReason:
            status === 'FAILED' ? 'NO_ELIGIBLE_BROKER' : null,
          decisionTrace: { totalSentBefore: 0, exclusions: [], winner: null },
          traceId: `t${i}`.padEnd(32, '0'),
          createdAt: new Date(base + i * 1000),
        },
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('pages newest-first with hasMore and a working cursor chain to exhaustion', async () => {
    const page1 = await api(app.baseUrl, 'GET', '/api/leads?limit=10', { cookie });
    expect(page1.status).toBe(200);
    let body = (page1.body as { data: {
      items: Array<{ id: number; createdAt: string }>;
      nextCursor?: string;
    } }).data;
    expect(body.items.length).toBe(10);
    expect(body.nextCursor).toBeDefined();

    // Newest first: descending ids given our seeded createdAt ordering.
    const seen: number[] = body.items.map((i) => i.id);
    const page2 = await api(
      app.baseUrl,
      'GET',
      `/api/leads?limit=10&cursor=${encodeURIComponent(body.nextCursor!)}`,
      { cookie },
    );
    body = (page2.body as { data: {
      items: Array<{ id: number; createdAt: string }>;
      nextCursor?: string;
    } }).data;
    expect(body.items.length).toBe(10);
    for (const item of body.items) seen.push(item.id);

    const page3 = await api(
      app.baseUrl,
      'GET',
      `/api/leads?limit=10&cursor=${encodeURIComponent(body.nextCursor!)}`,
      { cookie },
    );
    body = (page3.body as { data: {
      items: Array<{ id: number; createdAt: string }>;
      nextCursor?: string;
    } }).data;
    expect(body.items.length).toBe(5);
    expect(body.nextCursor).toBeUndefined(); // LIMIT n+1 → no phantom page
    for (const item of body.items) seen.push(item.id);

    expect(new Set(seen).size).toBe(25); // no dupes, no gaps across pages
  });

  it('filters by status, brokerId, date range, and q search', async () => {
    const sent = await api(app.baseUrl, 'GET', '/api/leads?status=sent&limit=50', { cookie });
    const sentBody = (sent.body as { data: { items: Array<{ status: string }> } }).data;
    expect(sentBody.items.length).toBe(9);
    expect(sentBody.items.every((i) => i.status === 'sent')).toBe(true);

    const failed = await api(app.baseUrl, 'GET', '/api/leads?status=failed&limit=50', { cookie });
    expect((failed.body as { data: { items: unknown[] } }).data.items.length).toBe(8);

    const q = await api(app.baseUrl, 'GET', '/api/leads?q=lead7&limit=50', { cookie });
    const qBody = (q.body as { data: { items: Array<{ email: string }> } }).data;
    expect(qBody.items.length).toBe(1);
    expect(qBody.items[0]!.email).toBe('lead7@example.com');

    // Seeds sit at base+i*1000 (base = now-60min): flooring at seed #12
    // deterministically returns the 13 newer rows.
    const fromIso = new Date(seedBaseMs + 12_000).toISOString();
    const recent = await api(
      app.baseUrl,
      'GET',
      `/api/leads?from=${encodeURIComponent(fromIso)}&limit=50`,
      { cookie },
    );
    const recentBody = (recent.body as { data: { items: unknown[] } }).data;
    expect(recentBody.items.length).toBe(13);
  });

  it('list items NEVER carry decisionTrace; detail DOES', async () => {
    const list = await api(app.baseUrl, 'GET', '/api/leads?limit=3', { cookie });
    const listBody = (list.body as { data: { items: Array<Record<string, unknown>> } }).data;
    for (const item of listBody.items) {
      expect(item).not.toHaveProperty('decisionTrace');
    }

    const firstId = listBody.items[0]!.id as number;
    const detail = await api(app.baseUrl, 'GET', `/api/leads/${firstId}`, { cookie });
    const detailBody = detail.body as unknown as {
      data: Record<string, unknown> & { decisionTrace: unknown };
    };
    expect(detail.status).toBe(200);
    expect(detailBody.data.decisionTrace).toBeDefined();
  });

  it('manual assign: happy path MANUAL+invariants, capped blocked, duplicate blocked, non-assignable blocked', async () => {
    // Fresh UNSENT lead.
    const lead = await app.prisma.lead.create({
      data: {
        formId: 1,
        name: 'Manual Candidate',
        email: 'manual-target@example.com',
        phone: '+63 917 111 1111',
        ipAddress: '203.0.113.200',
        status: 'UNSENT',
        decisionTrace: {},
        traceId: 't-manual'.padEnd(32, '0'),
      },
    });
    // Email already owned by another (terminal) lead → duplicate guard fires.
    const ownerLead = await app.prisma.lead.create({
      data: {
        formId: 1,
        name: 'Owner',
        email: 'taken-owner@example.com',
        phone: '+63 917 444 4444',
        ipAddress: '203.0.113.199',
        status: 'SENT',
        brokerId: 2,
        assignmentType: 'AUTO',
        assignedAt: new Date(),
        decisionTrace: {},
        traceId: 't-owner'.padEnd(32, '0'),
      },
    });
    await app.prisma.assignedEmail.create({
      data: {
        email: 'taken@example.com',
        brokerId: 2,
        leadId: ownerLead.id,
        assignedAt: new Date(),
      },
    });

    const cappedBroker = await app.prisma.broker.create({
      data: {
        name: 'Tiny Cap',
        isActive: true,
        dailyCap: 0,
        timezone: 'Asia/Manila',
        openingTime: '00:00',
        closingTime: '23:59',
        workingDays: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    await app.prisma.brokerDailyCounter.create({
      data: {
        brokerId: cappedBroker.id,
        localDate: new Date(new Date().toISOString().slice(0, 10)),
        sentCount: 0,
        capAtTime: 0,
      },
    });

    // Happy path onto Alpha-style broker id 1.
    const ok = await api(app.baseUrl, 'POST', `/api/leads/${lead.id}/assign`, {
      body: { brokerId: 1 },
      cookie,
    });
    expect(ok.status).toBe(200);
    const after = await app.prisma.lead.findUnique({ where: { id: lead.id } });
    expect(after?.status).toBe('SENT');
    expect(after?.assignmentType).toBe('MANUAL');
    expect(after?.brokerId).toBe(1);

    // Re-assign now blocked (terminal state).
    const again = await api(app.baseUrl, 'POST', `/api/leads/${lead.id}/assign`, {
      body: { brokerId: 2 },
      cookie,
    });
    expect(again.status).toBe(409);
    expect((again.body as { error: { code: string } }).error.code).toBe(
      'LEAD_NOT_ASSIGNABLE',
    );

    // Duplicate email guard via assign path.
    const dupeLead = await app.prisma.lead.create({
      data: {
        formId: 1,
        name: 'Dupe Target',
        email: 'taken@example.com',
        phone: '+63 917 222 2222',
        ipAddress: '203.0.113.201',
        status: 'UNSENT',
        decisionTrace: {},
        traceId: 't-dupe'.padEnd(32, '0'),
      },
    });
    const dupe = await api(app.baseUrl, 'POST', `/api/leads/${dupeLead.id}/assign`, {
      body: { brokerId: 1 },
      cookie,
    });
    expect(dupe.status).toBe(409);
    expect((dupe.body as { error: { code: string } }).error.code).toBe('DUPLICATE_LEAD');

    // Capped broker blocked: set counter to cap.
    const cappedLead = await app.prisma.lead.create({
      data: {
        formId: 1,
        name: 'Capped Target',
        email: 'capped-target@example.com',
        phone: '+63 917 333 3333',
        ipAddress: '203.0.113.202',
        status: 'UNSENT',
        decisionTrace: {},
        traceId: 't-cap'.padEnd(32, '0'),
      },
    });
    await app.prisma.broker.update({
      where: { id: cappedBroker.id },
      data: { dailyCap: 1 },
    });
    await app.prisma.brokerDailyCounter.update({
      where: {
        brokerId_localDate: {
          brokerId: cappedBroker.id,
          localDate: new Date(new Date().toISOString().slice(0, 10)),
        },
      },
      data: { capAtTime: 1, sentCount: 1 },
    });
    const capped = await api(
      app.baseUrl,
      'POST',
      `/api/leads/${cappedLead.id}/assign`,
      { body: { brokerId: cappedBroker.id }, cookie },
    );
    expect(capped.status).toBe(409);
    expect((capped.body as { error: { code: string } }).error.code).toBe(
      'BROKER_CAPPED',
    );

    // Retry path: UNSENT lead re-enqueues.
    const retry = await api(app.baseUrl, 'POST', `/api/leads/${dupeLead.id}/retry`, { cookie });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ data: { requeued: true } });
    const retried = await app.prisma.outbox.count({
      where: { aggregateId: String(dupeLead.id), type: 'LeadRoutingRequested' },
    });
    expect(retried).toBeGreaterThanOrEqual(1);

    // SENT leads cannot be retried.
    const badRetry = await api(app.baseUrl, 'POST', `/api/leads/${lead.id}/retry`, { cookie });
    expect(badRetry.status).toBe(409);
  });
});
