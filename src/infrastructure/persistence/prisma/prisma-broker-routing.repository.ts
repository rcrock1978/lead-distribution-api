import { DateTime } from 'luxon';
import type { PrismaClient } from '@prisma/client';

import type {
  BrokerCandidate,
  RoutingBrokerRepository,
} from '../../../application/ports/routing-ports';
import type { BrokerState } from '../../../domain/entities/broker.entity';
import type { LuxonClock } from '../../time/luxon-clock';
import { clientFor } from './prisma-unit-of-work';

/**
 * Routing read-side over Prisma. Candidates include EVERY distribution member
 * (even isActive=false / percentage=0) so selectBroker's persisted trace can
 * NAME the exclusion rule instead of silently dropping rows.
 *
 * Constitution V: nothing here is cached — counts and eligibility are live.
 */
export class PrismaBrokerRoutingRepository
  implements RoutingBrokerRepository
{
  /** Extra read used by the manual-assign use case (US4). */
  async getStateById(id: number): Promise<BrokerState | null> {
    const db = clientFor(this.prisma);
    const broker = await db.broker.findUnique({ where: { id } });
    if (broker === null) return null;
    const nowInBrokerZone = this.clock.nowInZone(broker.timezone);
    const membership = await db.distributionBroker.findFirst({
      where: { distribution: { singleton: true }, brokerId: id },
      select: { percentage: true, isActiveInDistribution: true },
    });
    const counter = await db.brokerDailyCounter.findUnique({
      where: {
        brokerId_localDate: {
          brokerId: id,
          localDate: new Date(`${nowInBrokerZone.localDateIso}T00:00:00.000Z`),
        },
      },
      select: { sentCount: true },
    });
    return {
      id: broker.id,
      name: broker.name,
      isActive: broker.isActive,
      isActiveInDistribution: membership?.isActiveInDistribution ?? false,
      dailyCap: broker.dailyCap,
      timezone: broker.timezone,
      openingTime: broker.openingTime,
      closingTime: broker.closingTime,
      workingDays: broker.workingDays as number[],
      percentage: Number(membership?.percentage ?? 0),
      sentToday: counter?.sentCount ?? 0,
    };
  }

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: LuxonClock,
  ) {}

  async findCandidates(): Promise<BrokerCandidate[]> {
    const db = clientFor(this.prisma);
    const members = await db.distributionBroker.findMany({
      where: { distribution: { singleton: true } },
      include: { broker: true },
    });

    const candidates: BrokerCandidate[] = [];
    for (const m of members) {
      const nowInBrokerZone = this.clock.nowInZone(m.broker.timezone);
      const counter = await db.brokerDailyCounter.findUnique({
        where: {
          brokerId_localDate: {
            brokerId: m.brokerId,
            localDate: new Date(`${nowInBrokerZone.localDateIso}T00:00:00.000Z`),
          },
        },
        select: { sentCount: true },
      });
      candidates.push({
        state: {
          id: m.broker.id,
          name: m.broker.name,
          isActive: m.broker.isActive,
          isActiveInDistribution: m.isActiveInDistribution,
          dailyCap: m.broker.dailyCap,
          timezone: m.broker.timezone,
          openingTime: m.broker.openingTime,
          closingTime: m.broker.closingTime,
          workingDays: m.broker.workingDays as number[],
          percentage: Number(m.percentage),
          sentToday: counter?.sentCount ?? 0,
        },
        nowInBrokerZone,
      });
    }
    return candidates;
  }

  async getDistributionTimezone(): Promise<string> {
    const dist = await clientFor(this.prisma).distribution.findFirst({
      where: { singleton: true },
      select: { timezone: true },
    });
    return dist?.timezone ?? 'UTC';
  }

  /** Shared deficit denominator: SENT leads in the DISTRIBUTION-local day. */
  async getTotalSentToday(): Promise<number> {
    const zone = await this.getDistributionTimezone();
    const now = DateTime.now().setZone(zone);
    const dayStart = now.startOf('day').toUTC().toJSDate();
    const dayEnd = now.startOf('day').plus({ days: 1 }).toUTC().toJSDate();
    return clientFor(this.prisma).lead.count({
      where: { status: 'SENT', assignedAt: { gte: dayStart, lt: dayEnd } },
    });
  }
}
