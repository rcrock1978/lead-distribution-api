import { AsyncLocalStorage } from 'node:async_hooks';

import type { PrismaClient } from '@prisma/client';

import type { TransactionClient } from '../../../application/ports/db.port';
import type { UnitOfWork } from '../../../application/ports/db.port';

/**
 * Transaction binding without changing application-port signatures: the
 * ambient store carries the interactive-transaction client; every Prisma
 * adapter resolves its handle through `clientFor()` so writes made during
 * `uow.run()` land on ONE transaction (INV-3/INV-4 atomicity), while calls
 * outside any unit of work fall back to the root client.
 */
const storage = new AsyncLocalStorage<{ tx: TransactionClient }>();

export function clientFor(
  fallback: PrismaClient,
): PrismaClient | TransactionClient {
  return storage.getStore()?.tx ?? fallback;
}

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    // Nested run() joins the enclosing transaction.
    if (storage.getStore() !== undefined) {
      const tx = storage.getStore()!.tx;
      return work(tx);
    }
    return this.prisma.$transaction(
      (tx) =>
        storage.run({ tx: tx as TransactionClient }, () => work(tx as TransactionClient)),
      { timeout: 15_000 },
    );
  }
}
