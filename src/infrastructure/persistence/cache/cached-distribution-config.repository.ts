import type { PrismaClient } from '@prisma/client';

import type {
  BrokerCandidate,
  RoutingBrokerRepository,
} from '../../../application/ports/routing-ports';
import type { Logger } from '../../observability/logger';
import type { MetricsRegistry } from '../../observability/metrics';
import type { LuxonClock } from '../../time/luxon-clock';

interface StaticMemberConfig {
  id: number;
  name: string;
  isActive: boolean;
  isActiveInDistribution: boolean;
  dailyCap: number;
  timezone: string;
  openingTime: string;
  closingTime: string;
  workingDays: number[];
  percentage: number;
}

/**
 * Version-gated cache for NEAR-STATIC distribution configuration ONLY
 * (research D12 / Constitution V): membership, percentages, windows.
 * Eligibility inputs that move — nowInBrokerZone projections and per-broker
 * sentToday — are recomputed LIVE on every call; nothing invariant-
 * participating is ever served stale. Every read checks ConfigVersion first,
 * so staleness is structurally zero; the cache only saves re-reading the
 * member JOIN when config hasn't changed.
 */
export class CachedDistributionConfigRepository implements RoutingBrokerRepository {
  private cached: {
    version: number;
    timezone: string;
    members: StaticMemberConfig[];
  } | null = null;

  constructor(
    private readonly inner: RoutingBrokerRepository,
    private readonly prisma: PrismaClient,
    private readonly clock: LuxonClock,
    private readonly metrics: MetricsRegistry,
    private readonly log: Logger,
  ) {}

  private async loadIfStale(): Promise<void> {
    const cv = await this.prisma.configVersion.findUnique({ where: { id: 1 } });
    if (this.cached !== null && cv !== null && cv.version === this.cached.version) {
      this.metrics.incCounter('config_cache_hits_total');
      return;
    }
    this.metrics.incCounter('config_cache_misses_total');

    // Miss: pull fresh static config through the plain repository path.
    const [timezone] = await Promise.all([this.inner.getDistributionTimezone()]);
    const candidates = await this.inner.findCandidates();
    this.cached = {
      version: cv?.version ?? 0,
      timezone,
      members: candidates.map((c) => ({ ...c.state })),
    };
    if (cv !== null) {
      this.log.debug('config.cache.refreshed', undefined, {
        version: cv.version,
      });
    }
  }

  async findCandidates(): Promise<BrokerCandidate[]> {
    await this.loadIfStale();
    const members = this.cached?.members ?? [];
    const candidates: BrokerCandidate[] = [];
    for (const m of members) {
      const nowInBrokerZone = this.clock.nowInZone(m.timezone);
      // LIVE read: the INV-4 denominator never comes from the config cache.
      const counter = await this.prisma.brokerDailyCounter.findUnique({
        where: {
          brokerId_localDate: {
            brokerId: m.id,
            localDate: new Date(`${nowInBrokerZone.localDateIso}T00:00:00.000Z`),
          },
        },
        select: { sentCount: true },
      });
      candidates.push({
        state: { ...m, sentToday: counter?.sentCount ?? 0 },
        nowInBrokerZone,
      });
    }
    return candidates;
  }

  async getDistributionTimezone(): Promise<string> {
    await this.loadIfStale();
    return this.cached?.timezone ?? 'UTC';
  }

  async getTotalSentToday(): Promise<number> {
    // Live passthrough — counts are invariant-participating (Constitution V).
    return this.inner.getTotalSentToday();
  }
}
