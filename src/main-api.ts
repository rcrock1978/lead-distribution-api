import 'dotenv/config';
import { loadEnv } from './config/env';
import { buildContainer } from './container';
import { buildApp } from './interfaces/http/app';
import { registerWorkerHandlers } from './main-worker-handlers';

/**
 * lead-api process entrypoint. Binds loopback ONLY — the browser never talks
 * to this API directly; the Next.js BFF forwards with X-Internal-Token.
 */
const env = loadEnv();
const container = buildContainer(env, 'lead-api');

// Degraded fallback (research D11): INLINE_WORKER=true runs the outbox consumer
// inside the API process. NOT the default; serialization assumption weakens.
let inlineStop: (() => Promise<void>) | undefined;
if (env.INLINE_WORKER) {
  container.log.warn('worker.started', 'INLINE_WORKER=true — running consumer in-process');
  const consumer = container.buildConsumer(registerWorkerHandlers(container));
  void consumer.start();
  inlineStop = () => consumer.stop();
}

const app = buildApp({ ...container, extraRouters: container.apiRouters });
const server = app.listen(env.PORT, '127.0.0.1', () => {
  container.log.info('config.loaded', undefined, {
    port: env.PORT,
    dbName: (env.DATABASE_URL.split('/').pop() ?? '').split('?')[0],
  });
  container.log.info('app.started', undefined, {
    port: env.PORT,
    inlineWorker: env.INLINE_WORKER,
  });
});

async function shutdown(signal: string): Promise<void> {
  container.log.info('app.stopping', `received ${signal}, shutting down`);
  server.close();
  await inlineStop?.();
  await container.prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
