import type { Container } from '../../container';

const PURGE_BATCH = 500;
const LEAD_RETENTION_DAYS = 90;   // FR-036
const OUTBOX_DONE_RETENTION_DAYS = 7;

/**
 * Nightly maintenance inside the worker (research D4 — no cron/systemd/sudo):
 * batched deletes keep InnoDB lock times bounded.
 * NEVER touches AssignedEmail — the duplicate registry is permanent (FR-036).
 */
export async function runNightlyMaintenance(container: Container): Promise<{
  leadsPurged: number;
  outboxPurged: number;
}> {
  const leadsPurged = await purgeLeads(container);
  const outboxPurged = await purgeOutboxDone(container);
  container.log.info('purge.completed', 'nightly maintenance finished', {
    leadsPurged,
    outboxPurged,
  });
  return { leadsPurged, outboxPurged };
}

async function purgeLeads(container: Container): Promise<number> {
  const cutoff = new Date(Date.now() - LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const page = await container.prisma.lead.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: PURGE_BATCH,
    });
    if (page.length === 0) break;
    const res = await container.prisma.lead.deleteMany({
      where: { id: { in: page.map((l) => l.id) } },
    });
    total += res.count;
    if (page.length < PURGE_BATCH) break;
  }
  return total;
}

async function purgeOutboxDone(container: Container): Promise<number> {
  const cutoff = new Date(Date.now() - OUTBOX_DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const page = await container.prisma.outbox.findMany({
      where: { status: 'DONE', processedAt: { lt: cutoff } },
      select: { id: true },
      take: PURGE_BATCH,
    });
    if (page.length === 0) break;
    const res = await container.prisma.outbox.deleteMany({
      where: { id: { in: page.map((m) => m.id) } },
    });
    total += res.count;
    if (page.length < PURGE_BATCH) break;
  }
  container.metrics.incCounter('outbox_reaped_total', undefined, total);
  if (total > 0) {
    container.log.info('outbox.reaped', 'purged DONE outbox rows', { total });
  }
  return total;
}

/** Runs at ~03:00 local time once per day; safe under restarts. */
export function scheduleNightlyMaintenance(container: Container): void {
  let lastRunDate = '';
  const check = (): void => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() === 3 && lastRunDate !== today) {
      lastRunDate = today;
      void runNightlyMaintenance(container).catch((err) => {
        container.log.error('purge.completed', 'nightly maintenance failed', {
          error: String(err),
        });
      });
    }
  };
  setInterval(check, 60 * 60 * 1000);
}
