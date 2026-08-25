import type { OutboxMessageInput } from '../../messaging/message-schemas';
import type { TransactionClient } from './db.port';

/**
 * Publishing is ALWAYS inside the caller's transaction (Constitution III):
 * the Lead row and its routing intent commit atomically or not at all.
 */
export interface OutboxPublisher {
  publish(message: OutboxMessageInput, tx?: TransactionClient): Promise<void>;
}
