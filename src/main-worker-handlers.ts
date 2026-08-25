import type { MessageHandler } from './infrastructure/messaging/outbox-consumer';
import type { Container } from './container';
import { routeLeadHandler } from './interfaces/worker/handlers/route-lead.handler';

/**
 * Single place where message types map to handlers. The worker entrypoint and
 * the INLINE_WORKER fallback both consume this registry.
 */
export function registerWorkerHandlers(container: Container): Map<string, MessageHandler> {
  const handlers = new Map<string, MessageHandler>();
  handlers.set('LeadRoutingRequested', routeLeadHandler(container));
  return handlers;
}
