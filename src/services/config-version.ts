import type { Prisma } from '@prisma/client';

/**
 * ConfigVersion is a SINGLETON row (id=1). Every configuration write bumps it
 * inside the SAME transaction — the version gate for cross-process caches
 * (Constitution V: cached config is never invariant-participating).
 */
export async function bumpConfigVersion(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.configVersion.upsert({
    where: { id: 1 },
    create: { id: 1, version: 1 },
    update: { version: { increment: 1 } },
  });
}
