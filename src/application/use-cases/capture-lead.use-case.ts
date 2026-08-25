import { randomUUID } from 'node:crypto';

import { Email } from '../../domain/value-objects/email.vo';

export interface CaptureLeadPorts {
  leadRepo: {
    create(data: {
      formId: number;
      name: string;
      email: string;
      phone: string;
      status: string;
      ipAddress: string;
      traceId: string;
    }): Promise<{ id: number }>;
  };
  outboxRepo: {
    create(data: {
      leadId: number;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      traceId: string;
    }): Promise<{ id: number }>;
  };
  formId: number;
}

export type CaptureLeadResult =
  | { kind: 'CAPTURED'; leadId: number; traceId: string }
  | { kind: 'VALIDATION_ERROR'; errors: string[]; traceId: string };

/**
 * Captures a public lead submission (US2).
 *
 * Per constitution V: nothing invariant-participating is cached — the email
 * uniqueness check is a direct row lookup under the Prisma transaction.
 */
export class CaptureLeadUseCase {
  constructor(private readonly deps: CaptureLeadPorts) {}

  async execute(input: {
    name: string;
    email: string;
    phone: string;
    ipAddress: string;
    traceId: string;
  }): Promise<CaptureLeadResult> {
    // 1. Validate with Zod-style guards — nothing persisted on failure.
    const emailResult = Email.create(input.email);
    let normalizedEmail: string | null = null;
    const errors: string[] = [];
    if (!emailResult.ok) {
      errors.push(emailResult.error);
    } else {
      normalizedEmail = emailResult.value.toString();
    }
    if (!input.ipAddress || typeof input.ipAddress !== 'string' || input.ipAddress.trim() === '') {
      errors.push('ipAddress is required.');
    }
    if (!input.name || typeof input.name !== 'string' || input.name.trim().length < 2) {
      errors.push('name must be 2-100 characters.');
    }
    if (!input.phone || typeof input.phone !== 'string' || !/^[0-9+\-() ]{7,20}$/.test(input.phone)) {
      errors.push('phone must be a valid phone number.');
    }
    if (errors.length > 0 || normalizedEmail === null) {
      return { kind: 'VALIDATION_ERROR', errors, traceId: input.traceId };
    }

    // NOTE (FR-011 / Edge Cases): duplication authority is PRIOR ASSIGNMENT
    // only — a repeat while the earlier lead is still unsent is accepted as
    // a fresh attempt here. The AssignedEmail PK collision at routing time
    // is the sole duplicate guard (INV-3).

    // Persist Lead + Outbox in ONE transaction (INV-5); the caller wraps
    // this in the Prisma transaction via tx-scoped adapters.
    const lead = await this.deps.leadRepo.create({
      formId: this.deps.formId,
      name: input.name.trim(),
      email: normalizedEmail,
      phone: input.phone,
      status: 'UNSENT',
      ipAddress: input.ipAddress,
      traceId: input.traceId,
    });

    const outboxEntry = await this.deps.outboxRepo.create({
      leadId: lead.id,
      type: 'LeadRoutingRequested',
      aggregateType: 'Lead',
      aggregateId: String(lead.id),
      payload: {
        leadId: lead.id,
        formId: this.deps.formId,
        email: normalizedEmail,
      },
      traceId: input.traceId,
    });

    return {
      kind: 'CAPTURED',
      leadId: lead.id,
      traceId: input.traceId,
    };
  }
}
