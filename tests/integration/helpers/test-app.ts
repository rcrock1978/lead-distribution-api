import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

import { loadEnv } from '@/src/config/env';
import { buildApp } from '@/src/interfaces/http/app';
import { buildApiRouters } from '@/src/interfaces/http/routers';
import type { Logger } from '@/src/infrastructure/observability/logger';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'mysql://lead:leaddev@127.0.0.1:3306/lead_platform_test';

export interface TestApp {
  baseUrl: string;
  prisma: PrismaClient;
  close(): Promise<void>;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  text: string;
  cookies: string[];
  get(header: string): string | null;
}

/** Idempotent: creates the scratch database and applies migrations once. */
export function ensureTestDatabase(): void {
  const mysql = (sql: string): void => {
    execSync(
      `docker exec lead-mysql mysql -uroot -prootdev -e ${JSON.stringify(sql)}`,
      { stdio: 'ignore' },
    );
  };
  mysql('CREATE DATABASE IF NOT EXISTS lead_platform_test');
  // The app user only gets per-database grants at container init — extend to
  // the scratch database here so migrations can run against it.
  mysql(
    "GRANT ALL PRIVILEGES ON lead_platform_test.* TO 'lead'@'%'; FLUSH PRIVILEGES;",
  );
  execSync('npx prisma migrate deploy', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = [
    'outbox',
    'worker_heartbeats',
    'broker_daily_counters',
    'distribution_brokers',
    'distributions',
    'assigned_emails',
    'leads',
    'forms',
    'brokers',
    'users',
    'config_versions',
  ];
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}

export async function startTestApp(
  opts: { envOverrides?: Record<string, string> } = {},
): Promise<TestApp> {
  ensureTestDatabase();

  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    PORT: '4000', // unused: the harness binds an ephemeral port directly
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    INTERNAL_API_TOKEN: 'test-internal-token',
    SEED_ADMIN_EMAIL: 'admin@example.com',
    SEED_ADMIN_PASSWORD: 'test-admin-password-123',
    PUBLIC_RATE_LIMIT_PER_MIN: '1000',
    CONFIG_CACHE: 'false',
    INLINE_WORKER: 'false',
    WORKER_ID: 'worker-test',
    ...opts.envOverrides,
  });

  const prisma = new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
  });
  await resetDatabase(prisma);

  // Deterministic admin credential for auth suites.
  const adminEmail = 'admin@example.com';
  const passwordHash = await bcrypt.hash('test-admin-password-123', 12);
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, passwordHash },
    update: { passwordHash },
  });

  const log: Logger = {
    child: () => log,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const app = buildApp({
    env,
    log,
    metrics: new (await import('@/src/infrastructure/observability/metrics')).MetricsRegistry(),
    clock: new (await import('@/src/infrastructure/time/luxon-clock')).LuxonClock(),
    prisma,
    extraRouters: buildApiRouters({
      env,
      log,
      prisma,
      clock: new (await import('@/src/infrastructure/time/luxon-clock')).LuxonClock(),
    }),
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    prisma,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await prisma.$disconnect();
    },
  };
}

export async function api(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; internalToken?: string } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  if (options.internalToken) headers['x-internal-token'] = options.internalToken;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return {
    status: res.status,
    body,
    text,
    cookies: res.headers.getSetCookie(),
    get: (h: string) => res.headers.get(h),
  };
}

export interface AdminSession {
  cookie: string;
  user: { id: number; email: string };
}

export async function loginAdmin(baseUrl: string): Promise<AdminSession> {
  const res = await api(baseUrl, 'POST', '/api/auth/login', {
    body: { email: 'admin@example.com', password: 'test-admin-password-123' },
  });
  if (res.status !== 200) {
    throw new Error(`admin login failed: ${res.status} ${res.text}`);
  }
  const sessionCookie = res.cookies.find((c) => c.startsWith('session='));
  if (!sessionCookie) throw new Error(`no session cookie: ${res.cookies}`);
  const body = res.body as { data: { user: { id: number; email: string } } };
  return {
    cookie: sessionCookie.split(';')[0] ?? '',
    user: body.data.user,
  };
}
