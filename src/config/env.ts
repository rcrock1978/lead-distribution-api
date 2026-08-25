import { z } from 'zod';

/**
 * Zod-parsed environment — exits fast on invalid configuration.
 * Placeholders in .env.example; real secrets NEVER enter git history.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  INTERNAL_API_TOKEN: z
    .string()
    .min(8, 'INTERNAL_API_TOKEN must be at least 8 characters'),

  PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),

  // §17.3 — previously hardcoded; now deployment-tunable.
  JWT_EXPIRES_IN: z.string().regex(/^\d+(s|m|h|d)$/, 'JWT_EXPIRES_IN must look like 24h').default('24h'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  WORKER_ID: z.string().min(1).default('worker-1'),

  CONFIG_CACHE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  INLINE_WORKER: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Seed-time only (prisma/seed.ts); optional at API runtime.
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema> & {
  isProduction: boolean;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: 'env.invalid',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      }),
    );
    process.exit(1);
  }
  return { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' };
}
