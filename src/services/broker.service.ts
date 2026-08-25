import type { Broker, Prisma, PrismaClient } from '@prisma/client';

import type { LuxonClock } from '../infrastructure/time/luxon-clock';
import { Broker as BrokerEntity } from '../domain/entities/broker.entity';
import { bumpConfigVersion } from './config-version';

export interface BrokerInput {
  name: string;
  isActive: boolean;
  dailyCap: number;
  timezone: string;
  openingTime: string;
  closingTime: string;
  workingDays: number[];
}

export interface BrokerView {
  id: number;
  name: string;
  isActive: boolean;
  dailyCap: number;
  timezone: string;
  openingTime: string;
  closingTime: string;
  workingDays: number[];
  sentToday: number;
  isOpenNow: boolean;
  isCapped: boolean;
}

/**
 * Thin CRUD service (plan: Clean Architecture is scoped ONLY to the
 * routing/capture context — broker configuration stays controller + Zod +
 * Prisma). Computed fields (sentToday/isOpenNow/isCapped) are projected per
 * broker timezone at read time and NEVER cached (Constitution V).
 */
export class BrokerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: LuxonClock,
  ) {}

  async list(): Promise<BrokerView[]> {
    const brokers = await this.prisma.broker.findMany({ orderBy: { id: 'asc' } });
    return Promise.all(brokers.map((b) => this.toView(b)));
  }

  async get(id: number): Promise<BrokerView | null> {
    const broker = await this.prisma.broker.findUnique({ where: { id } });
    return broker === null ? null : this.toView(broker);
  }

  async create(input: BrokerInput): Promise<BrokerView> {
    const created = await this.prisma.$transaction(async (tx) => {
      const broker = await tx.broker.create({ data: input });
      await bumpConfigVersion(tx);
      return broker;
    });
    return this.toView(created);
  }

  async update(
    id: number,
    patch: { [K in keyof BrokerInput]?: BrokerInput[K] | undefined },
  ): Promise<BrokerView | null> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.broker.findUnique({ where: { id } });
      if (existing === null) return null;
      const broker = await tx.broker.update({
        where: { id },
        data: definedEntries(patch),
      });
      await bumpConfigVersion(tx);
      return broker;
    });
    return updated === null ? null : this.toView(updated);
  }

  /** 409 when the broker holds leads — deactivate instead (spec §Edge Cases). */
  async delete(id: number): Promise<'deleted' | 'has_leads' | 'not_found'> {
    return this.prisma.$transaction(async (tx) => {
      const leadCount = await tx.lead.count({ where: { brokerId: id } });
      if (leadCount > 0) return 'has_leads';
      const existing = await tx.broker.findUnique({ where: { id } });
      if (existing === null) return 'not_found';
      // Membership rows cascade; counters cannot exist without assignments.
      await tx.distributionBroker.deleteMany({ where: { brokerId: id } });
      await tx.brokerDailyCounter.deleteMany({ where: { brokerId: id } });
      await tx.broker.delete({ where: { id } });
      await bumpConfigVersion(tx);
      return 'deleted';
    });
  }

  private async toView(broker: Broker): Promise<BrokerView> {
    const now = this.clock.nowInZone(broker.timezone);

    const counter = await this.prisma.brokerDailyCounter.findUnique({
      where: {
        brokerId_localDate: {
          brokerId: broker.id,
          localDate: new Date(`${now.localDateIso}T00:00:00.000Z`),
        },
      },
    });

    const sentToday = counter?.sentCount ?? 0;
    const entity = new BrokerEntity({
      id: broker.id,
      name: broker.name,
      isActive: broker.isActive,
      isActiveInDistribution: true, // display semantics ignore membership here
      dailyCap: broker.dailyCap,
      timezone: broker.timezone,
      openingTime: broker.openingTime,
      closingTime: broker.closingTime,
      workingDays: parseWorkingDays(broker.workingDays),
      percentage: 100, // not part of the open/capped display projection
      sentToday,
    });

    return {
      id: broker.id,
      name: broker.name,
      isActive: broker.isActive,
      dailyCap: broker.dailyCap,
      timezone: broker.timezone,
      openingTime: broker.openingTime,
      closingTime: broker.closingTime,
      workingDays: parseWorkingDays(broker.workingDays),
      sentToday,
      isOpenNow: broker.isActive && entity.isOpenNow(now),
      isCapped: broker.dailyCap > 0 && sentToday >= broker.dailyCap,
    };
  }
}

function parseWorkingDays(raw: Prisma.JsonValue): number[] {
  return Array.isArray(raw) ? (raw as number[]) : [];
}

/** Prisma update inputs reject explicit `undefined` under exactOptionalPropertyTypes. */
function definedEntries(patch: {
  [K in keyof BrokerInput]?: BrokerInput[K] | undefined;
}): Partial<BrokerInput> {
  const out: Partial<BrokerInput> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.isActive !== undefined) out.isActive = patch.isActive;
  if (patch.dailyCap !== undefined) out.dailyCap = patch.dailyCap;
  if (patch.timezone !== undefined) out.timezone = patch.timezone;
  if (patch.openingTime !== undefined) out.openingTime = patch.openingTime;
  if (patch.closingTime !== undefined) out.closingTime = patch.closingTime;
  if (patch.workingDays !== undefined) out.workingDays = patch.workingDays;
  return out;
}
