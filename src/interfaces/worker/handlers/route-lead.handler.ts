import {
  leadRoutingPayloadSchema,
  type LeadRoutingPayload,
} from '../../../messaging/message-schemas';
import type { MessageHandler } from '../../../infrastructure/messaging/outbox-consumer';
import type { Container } from '../../../container';

/**
 * Worker-side adapter (T042): outbox message → RouteLeadUseCase. Emits the
 * closed-taxonomy lifecycle events per outcome and records the
 * capture→assignment latency on successful assignment.
 */
export function routeLeadHandler(container: Container): MessageHandler {
  const log = container.log;
  return async (rawPayload, meta) => {
    const payload = leadRoutingPayloadSchema.parse(
      rawPayload,
    ) as LeadRoutingPayload;

    let outcome;
    try {
      outcome = await container.routeLeadUseCase.execute({
        messageId: meta.messageId,
        traceId: meta.traceId,
        payload,
      });
    } catch (err) {
      container.log.error('lead.failed', undefined, {
        leadId: payload.leadId,
        error: err instanceof Error ? err.message : String(err),
        traceId: meta.traceId,
      });
      throw err; // consumer owns backoff/dead-lettering
    }

    // Exclusion accounting (§13.3/§14.2): derive from the persisted trace so
    // the pure domain stays metrics-free. Emits the broker.excluded debug
    // event per rule AND increments the labeled counter.
    if (outcome.kind !== 'skipped') {
      try {
        const row = await container.prisma.lead.findUnique({
          where: { id: payload.leadId },
          select: { decisionTrace: true },
        });
        const exclusions =
          (row?.decisionTrace as {
            exclusions?: Array<{ brokerId?: number; rule?: string }>;
          })?.exclusions ?? [];
        for (const e of exclusions) {
          if (!e?.rule) continue;
          container.log.debug('broker.excluded', undefined, {
            leadId: payload.leadId,
            brokerId: e.brokerId,
            rule: e.rule,
            traceId: meta.traceId,
          });
          container.metrics.incCounter('broker_exclusions_total', {
            rule: e.rule,
          });
        }
      } catch {
        // Observability must never fail the pipeline.
      }
    }

    switch (outcome.kind) {
      case 'assigned':
        log.info('lead.routed', undefined, {
          leadId: payload.leadId,
          brokerId: outcome.brokerId,
          messageId: meta.messageId,
          traceId: meta.traceId,
        });
        await observeCaptureToAssign(container, payload.leadId, meta.traceId);
        break;
      case 'duplicate':
        log.info('lead.duplicate', 'email already assigned', {
          leadId: payload.leadId,
          priorBrokerId: outcome.priorBrokerId,
          traceId: meta.traceId,
        });
        break;
      case 'unsent':
        log.warn('lead.unsent', outcome.reason, {
          leadId: payload.leadId,
          attempts: outcome.selectionAttempts,
          traceId: meta.traceId,
        });
        break;
      case 'skipped':
        log.info('lead.unsent', `idempotent skip: ${outcome.reason}`, {
          leadId: payload.leadId,
          traceId: meta.traceId,
        });
        break;
    }
  };
}

async function observeCaptureToAssign(
  container: Container,
  leadId: number,
  traceId: string,
): Promise<void> {
  try {
    const lead = await container.prisma.lead.findUnique({
      where: { id: leadId },
      select: { createdAt: true, assignedAt: true },
    });
    if (lead?.assignedAt) {
      container.metrics.observeHistogram(
        'lead_capture_to_assign_ms',
        lead.assignedAt.getTime() - lead.createdAt.getTime(),
        { traceId },
      );
    }
  } catch {
    // Observability must never fail the pipeline.
  }
}
