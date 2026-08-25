import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { CaptureLeadUseCase } from '../../../src/application/use-cases/capture-lead.use-case';
import { Email } from '../../../src/domain/value-objects/email.vo';

interface FakeLeadRow {
  id: number;
  formId: number;
  name: string;
  email: string;
  phone: string;
  status: 'UNSENT' | 'SENT' | 'DUPLICATE' | 'FAILED';
  ipAddress: string | null;
  traceId: string;
  createdAt: Date;
}

interface FakeOutboxRow {
  id: number;
  leadId: number;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  traceId: string;
  processedAt: Date | null;
  createdAt: Date;
}

function createFakes() {
  const leads: FakeLeadRow[] = [];
  const outbox: FakeOutboxRow[] = [];
  let nextLeadId = 1;
  let nextOutboxId = 1;

  return {
    leads,
    outbox,
    leadRepo: {
      async findUniqueByEmail(_formId: number, _email: string) {
        return leads.find(
          (l) => l.formId === _formId && l.email === _email,
        ) ?? null;
      },
      async create(data: {
        formId: number;
        name: string;
        email: string;
        phone: string;
        status: string;
        ipAddress: string;
        traceId: string;
      }) {
        const row: FakeLeadRow = {
          id: nextLeadId++,
          formId: data.formId,
          name: data.name,
          email: data.email,
          phone: data.phone,
          status: data.status as FakeLeadRow['status'],
          ipAddress: data.ipAddress,
          traceId: data.traceId,
          createdAt: new Date(),
        };
        leads.push(row);
        return row;
      },
    },
    outboxRepo: {
      async create(data: {
        leadId: number;
        type: string;
        aggregateType: string;
        aggregateId: string;
        payload: Record<string, unknown>;
        traceId: string;
      }) {
        const row: FakeOutboxRow = {
          id: nextOutboxId++,
          leadId: data.leadId,
          type: data.type,
          aggregateType: data.aggregateType,
          aggregateId: data.aggregateId,
          payload: data.payload,
          traceId: data.traceId,
          processedAt: null,
          createdAt: new Date(),
        };
        outbox.push(row);
        return row;
      },
    },
  };
}

describe('CaptureLeadUseCase', () => {
  it('rejects missing email with 422 and persists nothing', async () => {
    const fakes = createFakes();
    const useCase = new CaptureLeadUseCase({
      leadRepo: fakes.leadRepo,
      outboxRepo: fakes.outboxRepo,
      formId: 1,
    });
    const result = await useCase.execute({
      name: 'Alice Smith',
      email: '',
      phone: '+63 917 100 0000',
      ipAddress: '203.0.113.10',
      traceId: randomUUID(),
    });
    expect(result.kind).toBe('VALIDATION_ERROR');
    expect(fakes.leads.length).toBe(0);
    expect(fakes.outbox.length).toBe(0);
  });

  it('normalizes email (trim+lowercase) before persistence', async () => {
    const fakes = createFakes();
    const useCase = new CaptureLeadUseCase({
      leadRepo: fakes.leadRepo,
      outboxRepo: fakes.outboxRepo,
      formId: 1,
    });
    const traceId = randomUUID();
    const result = await useCase.execute({
      name: 'Alice Smith',
      email: '  Alice@Test.COM  ',
      phone: '+63 917 100 0001',
      ipAddress: '198.51.100.5',
      traceId,
    });
    expect(result.kind).toBe('CAPTURED');
    expect(fakes.leads.length).toBe(1);
    expect(fakes.leads[0]!.email).toBe('alice@test.com');
    expect(fakes.outbox.length).toBe(1);
    expect(fakes.outbox[0]!.traceId).toBe(traceId);
  });

  it('accepts a repeat as fresh while prior lead is unsent (FR-011 edge case)', async () => {
    const fakes = createFakes();
    const make = () =>
      new CaptureLeadUseCase({
        leadRepo: fakes.leadRepo,
        outboxRepo: fakes.outboxRepo,
        formId: 1,
      });
    const first = await make().execute({
      name: 'Bob Jones',
      email: 'bob@example.com',
      phone: '+63 917 100 0002',
      ipAddress: '10.0.0.1',
      traceId: randomUUID(),
    });
    expect(first.kind).toBe('CAPTURED');

    const second = await make().execute({
      name: 'Bob Jones',
      email: 'bob@example.com',
      phone: '+63 917 100 0002',
      ipAddress: '10.0.0.2',
      traceId: randomUUID(),
    });
    // Duplication authority is prior ASSIGNMENT, not prior submission —
    // both submissions persist and enqueue.
    expect(second.kind).toBe('CAPTURED');
    expect(fakes.leads.length).toBe(2);
    expect(fakes.outbox.length).toBe(2);
  });

  it('rejects ipAddress null/undefined', async () => {
    const fakes = createFakes();
    const useCase = new CaptureLeadUseCase({
      leadRepo: fakes.leadRepo,
      outboxRepo: fakes.outboxRepo,
      formId: 1,
    });
    const result = await useCase.execute({
      name: 'Dave Kim',
      email: 'dave@example.com',
      phone: '+63 917 100 0004',
      ipAddress: null as unknown as string,
      traceId: randomUUID(),
    });
    expect(result.kind).toBe('VALIDATION_ERROR');
    expect(fakes.leads.length).toBe(0);
  });

  it('persisted Lead has status UNSENT and ipAddress set', async () => {
    const fakes = createFakes();
    const useCase = new CaptureLeadUseCase({
      leadRepo: fakes.leadRepo,
      outboxRepo: fakes.outboxRepo,
      formId: 1,
    });
    await useCase.execute({
      name: 'Erin Wong',
      email: 'erin@example.com',
      phone: '+63 917 100 0005',
      ipAddress: '172.16.0.1',
      traceId: randomUUID(),
    });
    expect(fakes.leads[0]!.status).toBe('UNSENT');
    expect(fakes.leads[0]!.ipAddress).toBe('172.16.0.1');
  });

  it('rejects malformed phone with nothing persisted', async () => {
    const fakes = createFakes();
    const useCase = new CaptureLeadUseCase({
      leadRepo: fakes.leadRepo,
      outboxRepo: fakes.outboxRepo,
      formId: 1,
    });
    const result = await useCase.execute({
      name: 'Grace Lim',
      email: 'grace@example.com',
      phone: '123',
      ipAddress: '192.0.2.7',
      traceId: randomUUID(),
    });
    expect(result.kind).toBe('VALIDATION_ERROR');
    expect(fakes.leads.length).toBe(0);
  });

  it('rejects too-short name with nothing persisted', async () => {
    const fakes = createFakes();
    const useCase = new CaptureLeadUseCase({
      leadRepo: fakes.leadRepo,
      outboxRepo: fakes.outboxRepo,
      formId: 1,
    });
    const result = await useCase.execute({
      name: 'A',
      email: 'hank@example.com',
      phone: '+63 917 100 0007',
      ipAddress: '192.0.2.8',
      traceId: randomUUID(),
    });
    expect(result.kind).toBe('VALIDATION_ERROR');
    expect(fakes.leads.length).toBe(0);
  });

  it('outbox entry has type LeadRoutingRequested and payload contains email', async () => {
    const fakes = createFakes();
    const useCase = new CaptureLeadUseCase({
      leadRepo: fakes.leadRepo,
      outboxRepo: fakes.outboxRepo,
      formId: 1,
    });
    const traceId = randomUUID();
    await useCase.execute({
      name: 'Frank Cruz',
      email: 'frank@example.com',
      phone: '+63 917 100 0006',
      ipAddress: '192.0.2.50',
      traceId,
    });
    const ob = fakes.outbox[0]!;
    expect(ob.type).toBe('LeadRoutingRequested');
    expect(ob.aggregateType).toBe('Lead');
    expect(ob.aggregateId).toBe(String(fakes.leads[0]!.id));
    expect(ob.payload.email).toBe('frank@example.com');
    expect(ob.traceId).toBe(traceId);
  });
});
