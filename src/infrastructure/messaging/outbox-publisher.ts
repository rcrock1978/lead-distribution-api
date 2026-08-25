import type { OutboxPublisher } from '../../application/ports/outbox.publisher.port';
import type { TransactionClient } from '../../application/ports/db.port';
import type { OutboxMessageInput } from '../../messaging/message-schemas';
import type { PrismaClient } from '@prisma/client';

export class PrismaOutboxPublisher implements OutboxPublisher {
  constructor(private readonly prisma: PrismaClient) {}

  async publish(message: OutboxMessageInput, tx?: TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.outbox.create({
      data: {
        id: message.id,
        type: message.type,
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        payload: JSON.parse(JSON.stringify(message.payload)),
        traceId: message.traceId,
        status: 'PENDING',
      },
    });
  }
}
