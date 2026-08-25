import { z } from 'zod';

import { ERROR_CODES } from '../domain/errors/app-error';

/**
 * API CONTRACT SCHEMAS — the single source of truth for request/response
 * shapes (contracts/api.md). Zod validation is server-authoritative at every
 * entry point. The frontend consumes the GENERATED declaration of ./types.ts.
 */

export const errorCodeSchema = z.enum(ERROR_CODES);
export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

// ---- Validation primitives (data-model.md §Validation Rules Summary) ----

export const nameSchema = z.string().trim().min(2).max(100);
export const emailSchema = z.string().trim().toLowerCase().email().max(255);
export const phoneSchema = z.string().regex(/^[0-9+\-() ]{7,20}$/);
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_SLUGS = [
  'api', 'login', 'dashboard', 'brokers', 'leads', 'form', 'distribution', 'ops',
];
export const workingDaysSchema = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'working days must be unique');
export const timezoneNameSchema = z.string().min(1).max(64);
export const dailyCapSchema = z.number().int().min(0).max(10_000);
export const percentageSchema = z.number().min(0).max(100);

// ---- Auth ----

export const loginInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});
export const userResponseSchema = z.object({ id: z.number(), email: z.string() });

// ---- Brokers ----

export const brokerInputSchema = z.object({
  name: nameSchema,
  isActive: z.boolean().default(true),
  dailyCap: dailyCapSchema,
  timezone: timezoneNameSchema,
  openingTime: hhmmSchema,
  closingTime: hhmmSchema,
  workingDays: workingDaysSchema,
});
export const brokerPatchSchema = brokerInputSchema.partial();
export const brokerResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  isActive: z.boolean(),
  dailyCap: z.number(),
  timezone: z.string(),
  openingTime: z.string(),
  closingTime: z.string(),
  workingDays: z.array(z.number().int()),
  sentToday: z.number(),
  isOpenNow: z.boolean(),
  isCapped: z.boolean(),
});

// ---- Form / Distribution ----

export const formCreateInputSchema = z.object({ name: nameSchema });
export const distributionCreateInputSchema = z.object({
  name: nameSchema,
  timezone: timezoneNameSchema,
});
export const distributionMembersInputSchema = z.object({
  members: z
    .array(
      z.object({
        brokerId: z.number().int().positive(),
        percentage: percentageSchema,
        isActiveInDistribution: z.boolean(),
      }),
    )
    .max(200),
});

/** GET /api/distribution — the singleton plus computed member views. */
export const distributionMemberViewSchema = z.object({
  brokerId: z.number().int().positive(),
  name: z.string(),
  percentage: percentageSchema,
  isActiveInDistribution: z.boolean(),
  sentToday: z.number().int(),
  isOpenNow: z.boolean(),
  isCapped: z.boolean(),
});
export const distributionRecordSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  formId: z.number().int().positive(),
  timezone: z.string(),
});
export const distributionGetResponseSchema = z.object({
  distribution: distributionRecordSchema.nullable(),
  members: z.array(distributionMemberViewSchema),
});

// ---- Public capture ----

export const submissionInputSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  website: z.string().max(0).optional(), // honeypot: must be absent or empty
});

// ---- Leads ----

export const leadListQuerySchema = z.object({
  status: z.enum(['unsent', 'sent', 'duplicate', 'failed']).optional(),
  brokerId: z.coerce.number().int().positive().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const manualAssignInputSchema = z.object({
  brokerId: z.number().int().positive(),
});

// ---- Ops ----

export const logsTailQuerySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  event: z.string().max(64).optional(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/i).optional(),
  n: z.coerce.number().int().min(1).max(500).default(100),
});
