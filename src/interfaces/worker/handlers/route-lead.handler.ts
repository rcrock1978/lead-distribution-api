import { leadRoutingPayloadSchema } from '../../../messaging/message-schemas';
import type { MessageHandler } from '../../../infrastructure/messaging/outbox-consumer';
import type { Container } from '../../../container';

/**
 * Worker-side adapter: outbox message → RouteLeadUseCase.
 * Wired to the real use case in US3 (Phase 6); until then messages fail and
 * follow the retry→dead-letter path visibly rather than silently vanishing.
 */
export function routeLeadHandler(container: Container): MessageHandler {
  return async (rawPayload, meta) => {
    const payload = leadRoutingPayloadSchema.parse(rawPayload);
    const useCase = (container as { routeLeadUseCase?: unknown }).routeLeadUseCase;
    if (!useCase) {
      throw new Error(
        `RouteLeadUseCase not wired into container yet (message ${meta.messageId})`,
      );
    }
    await (
      useCase as { execute(input: typeof payload): Promise<void> }
    ).execute(payload);
  };
}
