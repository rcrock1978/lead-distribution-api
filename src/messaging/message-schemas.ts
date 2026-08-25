import { z } from 'zod';

/**
 * Closed message vocabulary for the transactional outbox.
 * Idempotency key = the outbox row's UUID primary key.
 */
export const OUTBOX_MESSAGE_TYPES = ['LeadRoutingRequested', 'LeadCaptured'] as const;
export type OutboxMessageType = (typeof OUTBOX_MESSAGE_TYPES)[number];

export const leadRoutingPayloadSchema = z.object({
  leadId: z.number().int().positive(),
  formId: z.number().int().positive(),
  email: z.string(),
});

export type LeadRoutingPayload = z.infer<typeof leadRoutingPayloadSchema>;

export interface OutboxMessageInput {
  id: string;
  type: OutboxMessageType;
  aggregateType: 'Lead';
  aggregateId: string;
  payload: LeadRoutingPayload;
  traceId: string;
}
