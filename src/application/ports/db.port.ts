import type { Prisma } from '@prisma/client';

/**
 * The transaction handle passed through use-cases. TYPE-ONLY import —
 * the application ring keeps zero runtime coupling to Prisma; the concrete
 * UnitOfWork implementation lives in infrastructure.
 */
export type TransactionClient = Prisma.TransactionClient;

/** Interactive transaction boundary used by capture and routing writes. */
export interface UnitOfWork {
  run<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T>;
}
