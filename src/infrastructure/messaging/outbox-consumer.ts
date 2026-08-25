import { randomUUID } from 'node:crypto';

import {
  runWithCorrelation,
} from '../observability/correlation';
import type { Logger } from '../observability/logger';
import type { PrismaClient } from '@prisma/client';

export type MessageHandler = (payload: unknown, meta: {
  messageId: string;
  traceId: string;
  aggregateId: string;
}) => Promise<void>;

/** Backoff schedule after failure N (research D11 / data-model.md): 1s→4s→16s→64s→256s. */
const BACKOFF_MS = [1_000, 4_000, 16_000, 64_000, 256_000];
const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60_000;

/**
 * Transactional-outbox consumer (Constitution III). Claim uses
 * FOR UPDATE SKIP LOCKED so concurrent consumers could never share a message
 * (INV-6) even though `instances: 1` makes assignment serialized by
 * construction. Handlers MUST be idempotent — redelivery is normal.
 */
export class OutboxConsumer {
  private pollTimer?: NodeJS.Timeout;
  private reaperTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private processedDelta = 0;
  private processedBase = 0;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      log: Logger;
      workerId: string;
      version: string;
      handlers: Map<string, MessageHandler>;
      pollIntervalMs?: number;
    },
  ) {}

  start(): void {
    this.stopped = false;
    void this.initializeHeartbeat();
    const poll = this.deps.pollIntervalMs ?? 500;
    this.pollTimer = setInterval(() => void this.tick(), poll);
    this.reaperTimer = setInterval(() => void this.reapStale(), 60_000);
    this.heartbeatTimer = setInterval(() => void this.beat(), 15_000);
    this.deps.log.info('worker.started', 'outbox consumer started', {
      workerId: this.deps.workerId,
      version: this.deps.version,
      handlers: [...this.deps.handlers.keys()],
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of [this.pollTimer, this.reaperTimer, this.heartbeatTimer]) {
      if (t) clearInterval(t);
    }
    await this.beat();
  }

  private async initializeHeartbeat(): Promise<void> {
    try {
      const existing = await this.deps.prisma.workerHeartbeat.findUnique({
        where: { workerId: this.deps.workerId },
      });
      this.processedBase = existing?.processedTotal ?? 0;
      await this.beat();
    } catch (err) {
      this.deps.log.warn('worker.started', 'initial heartbeat failed', {
        error: String(err),
      });
    }
  }

  private async beat(): Promise<void> {
    try {
      const total = this.processedBase + this.processedDelta;
      await this.deps.prisma.workerHeartbeat.upsert({
        where: { workerId: this.deps.workerId },
        create: {
          workerId: this.deps.workerId,
          lastBeatAt: new Date(),
          processedTotal: total,
          version: this.deps.version,
        },
        update: { lastBeatAt: new Date(), processedTotal: total, version: this.deps.version },
      });
      this.deps.log.debug('worker.heartbeat.beat', undefined, { processedTotal: total });
    } catch {
      // Heartbeat failures must never kill the worker; readiness surfaces it.
    }
  }

  private async reapStale(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
      const res = await this.deps.prisma.outbox.updateMany({
        where: { status: 'PROCESSING', claimedAt: { lt: cutoff } },
        data: { status: 'PENDING', claimedAt: null },
      });
      if (res.count > 0) {
        this.deps.log.warn('outbox.stale_reclaimed', 'stale PROCESSING rows reclaimed', {
          count: res.count,
        });
      }
    } catch (err) {
      this.deps.log.warn('outbox.stale_reclaimed', 'reaper failed', { error: String(err) });
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.claimBatch();
    } catch (err) {
      this.deps.log.error('outbox.failed', 'claim batch failed', { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async claimBatch(): Promise<void> {
    const ids = await this.deps.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM outbox
        WHERE status = 'PENDING' AND availableAt <= NOW(3)
        ORDER BY availableAt ASC
        LIMIT 10
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];
      const claimedIds = rows.map((r) => r.id);
      await tx.outbox.updateMany({
        where: { id: { in: claimedIds }, status: 'PENDING' },
        data: { status: 'PROCESSING', claimedAt: new Date(), attempts: { increment: 1 } },
      });
      return claimedIds;
    });

    for (const id of ids) {
      await this.processOne(id);
    }
  }

  private async processOne(messageId: string): Promise<void> {
    const msg = await this.deps.prisma.outbox.findUnique({ where: { id: messageId } });
    if (msg === null || msg.status !== 'PROCESSING') return; // stale-reaped or gone

    await runWithCorrelation(
      { requestId: randomUUID(), traceId: msg.traceId },
      async () => {
        const log = this.deps.log.child({ messageId: msg.id });
        log.info('outbox.claimed', undefined, {
          type: msg.type,
          attempts: msg.attempts,
          aggregateType: msg.aggregateType,
          aggregateId: msg.aggregateId,
        });

        const handler = this.deps.handlers.get(msg.type);
        try {
          if (!handler) {
            throw new Error(`No handler registered for message type ${msg.type}`);
          }
          await handler(msg.payload, {
            messageId: msg.id,
            traceId: msg.traceId,
            aggregateId: msg.aggregateId,
          });
          await this.deps.prisma.outbox.update({
            where: { id: msg.id },
            data: { status: 'DONE', processedAt: new Date() },
          });
          this.processedDelta += 1;
          log.info('outbox.processed', undefined, { type: msg.type });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (msg.attempts >= MAX_ATTEMPTS) {
            await this.deps.prisma.outbox.update({
              where: { id: msg.id },
              data: { status: 'DEAD', lastError: errorMessage.slice(0, 2000) },
            });
            log.error('outbox.dead', 'message dead-lettered', {
              type: msg.type,
              attempts: msg.attempts,
              lastError: errorMessage,
            });
          } else {
            const base =
              BACKOFF_MS[Math.min(msg.attempts, BACKOFF_MS.length) - 1] ??
              BACKOFF_MS[BACKOFF_MS.length - 1] ??
              256_000;
            const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
            await this.deps.prisma.outbox.update({
              where: { id: msg.id },
              data: {
                status: 'PENDING',
                claimedAt: null,
                availableAt: new Date(Date.now() + jittered),
                lastError: errorMessage.slice(0, 2000),
              },
            });
            log.warn('outbox.failed', 'processing failed, will retry', {
              type: msg.type,
              attempts: msg.attempts,
              retryInMs: jittered,
              lastError: errorMessage,
            });
          }
        }
      },
    );
  }
}
