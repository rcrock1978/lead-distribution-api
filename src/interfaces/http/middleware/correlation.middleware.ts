import type { NextFunction, Request, Response } from 'express';

import {
  newTraceId,
  runWithCorrelation,
} from '../../../infrastructure/observability/correlation';
import type { Logger } from '../../../infrastructure/observability/logger';

interface LoggableRequest extends Request {
  log?: Logger;
}

const MIDDLEWARE_START = Symbol('middlewareStart');

/**
 * Middleware #1 (cheapest first — D14): bind requestId + traceId via
 * AsyncLocalStorage, attach a child logger, echo X-Trace-Id, record the
 * middleware-chain start timestamp, and emit http.request/http.response
 * events from the closed taxonomy.
 */
export function correlationMiddleware(log: Logger) {
  return (req: LoggableRequest, res: Response, next: NextFunction): void => {
    const incomingTrace = req.header('x-trace-id');
    const ctx = {
      requestId: newTraceId(),
      traceId:
        incomingTrace && /^[0-9a-f]{32}$/i.test(incomingTrace)
          ? incomingTrace
          : newTraceId(),
    };

    res.setHeader('X-Trace-Id', ctx.traceId);
    (res.locals as Record<symbol, unknown>)[MIDDLEWARE_START] =
      process.hrtime.bigint();

    const child = log.child({ requestId: ctx.requestId, traceId: ctx.traceId });
    req.log = child;

    child.info('http.request', `${req.method} ${req.path}`, {
      method: req.method,
      path: req.path,
    });

    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - ((res.locals as Record<symbol, unknown>)[MIDDLEWARE_START] as bigint)) /
        1_000_000;
      child.info('http.response', `${req.method} ${res.statusCode}`, {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });

    runWithCorrelation(ctx, () => next());
  };
}

/**
 * Mounted immediately BEFORE the router: observes the full middleware stack
 * while EXCLUDING handler work — exactly the Constitution VI budget boundary.
 */
export function middlewareDurationObserver(metrics: {
  observeHistogram(
    name: string,
    valueMs: number,
    labels?: Record<string, string>,
  ): void;
}) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const startedAt = (res.locals as Record<symbol, unknown>)[
      MIDDLEWARE_START
    ] as bigint | undefined;
    if (startedAt !== undefined) {
      metrics.observeHistogram(
        'middleware_duration_ms',
        Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      );
    }
    next();
  };
}
