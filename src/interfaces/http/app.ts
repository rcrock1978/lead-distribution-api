import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import express, { type Express, type Router } from 'express';

import type { Env } from '../../config/env';
import { JwtService } from '../../infrastructure/security/jwt.service';
import { correlationMiddleware, middlewareDurationObserver } from './middleware/correlation.middleware';
import { cacheHeadersMiddleware } from './middleware/cache-headers';
import { internalTokenGuard } from './middleware/internal-token';
import { createPublicRateLimiter } from './middleware/rate-limit';
import { jwtVerifyMiddleware } from './middleware/auth';
import { notFoundHandler, terminalErrorHandler } from './middleware/error-handler';
import { healthRoutes } from './routes/health.routes';
import type { MetricsRegistry } from '../../infrastructure/observability/metrics';
import type { Logger } from '../../infrastructure/observability/logger';
import type { LuxonClock } from '../../infrastructure/time/luxon-clock';
import type { PrismaClient } from '@prisma/client';

export interface AppDeps {
  env: Env;
  log: Logger;
  metrics: MetricsRegistry;
  clock: LuxonClock;
  prisma: PrismaClient;
  /** Prefixed routers registered by the composition root (added per user story). */
  extraRouters?: Array<[string, Router]>;
}

/**
 * Express app factory with the EXACT middleware order (research D14,
 * Constitution VI): cheapest-and-most-likely-to-reject first; auth performs
 * NO database lookup; middleware budget observed just before the router.
 * Prohibited inside middleware: DB queries, bcrypt, sync crypto, body
 * serialization for logging.
 */
export function buildApp(deps: AppDeps): Express {
  const app = express();
  const jwt = new JwtService(deps.env.JWT_SECRET);

  // Middleware #0 — full request duration (plan D10): starts BEFORE
  // correlation so the observation covers the entire stack incl. handlers.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    // Snapshot identity NOW: Express mutates req internals during routing,
    // so lazy reads inside the finish closure are unreliable.
    const method = req.method;
    const pathAtStart = String(req.originalUrl ?? req.url);
    const route = pathAtStart.startsWith('/api/public/leads')
      ? 'capture'
      : pathAtStart.startsWith('/api/public')
        ? 'public'
        : 'other';
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      deps.metrics.observeHistogram(
        'http_request_duration_ms',
        ms,
        { method, route },
      );
    });
    next();
  });

  // 1. requestId/logger binding + trace correlation
  app.use(correlationMiddleware(deps.log));
  // 2. security headers
  app.use(helmet());
  // 3. cache headers per route class (Principle V)
  app.use(cacheHeadersMiddleware());
  // 4. internal-token guard (constant-time)
  app.use(internalTokenGuard(deps.env.INTERNAL_API_TOKEN));
  // 5. rate limiter — public routes ONLY
  app.use(
    '/api/public',
    createPublicRateLimiter(deps.env.PUBLIC_RATE_LIMIT_PER_MIN),
  );
  // 6. body parser (64 kb ceiling)
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  // 7. JWT verify — signature only, no DB lookup
  app.use(jwtVerifyMiddleware(jwt));
  // Budget observer sits immediately before ANY router mount: measures the
  // full middleware stack while EXCLUDING handler work.
  app.use(middlewareDurationObserver(deps.metrics));

  app.use(healthRoutes({ prisma: deps.prisma, version: process.env.GIT_SHA ?? 'dev' }));
  for (const [prefix, router] of deps.extraRouters ?? []) {
    app.use(prefix, router);
  }

  // 404s and errors last.
  app.use(notFoundHandler);
  app.use(terminalErrorHandler(deps.log));

  return app;
}
