import { loadEnv } from './config/env';
import { buildContainer } from './container';
import { OutboxConsumer } from './infrastructure/messaging/outbox-consumer';
import type { MessageHandler } from './infrastructure/messaging/outbox-consumer';

/**
 * lead-worker process entrypoint — NO HTTP listener. `instances: 1` is
 * LOAD-BEARING (research D11): a single consumer serializes assignment by
 * construction; the metrics registry is per-process.
 */
const env = loadEnv();
const container = buildContainer(env, 'lead-worker');

// Handler registration arrives with US3 (route-lead.handler). The import in
// main-worker-handlers.ts keeps this file stable; until then the registry may
// be empty and claimed messages would retry → dead-letter visibly.
let consumer: OutboxConsumer;

async function main(): Promise<void> {
  const { registerWorkerHandlers } = await import('./main-worker-handlers');
  const handlers: Map<string, MessageHandler> = registerWorkerHandlers(container);
  consumer = container.buildConsumer(handlers);
  consumer.start();

  // Nightly maintenance scheduler lives with purge-tasks (US5).
  const { scheduleNightlyMaintenance } = await import('./interfaces/worker/purge-tasks');
  scheduleNightlyMaintenance(container);
}

void main();

async function shutdown(signal: string): Promise<void> {
  container.log.info('http.response', `worker received ${signal}, shutting down`);
  await consumer?.stop();
  await container.prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
