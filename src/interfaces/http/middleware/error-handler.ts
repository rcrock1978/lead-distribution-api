import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { AppError } from '../../../domain/errors/app-error';
import { currentContext } from '../../../infrastructure/observability/correlation';

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  traceId: string;
}

const HTTP_STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORM_ALREADY_EXISTS: 409,
  FORM_REQUIRED: 400,
  DISTRIBUTION_ALREADY_EXISTS: 409,
  DUPLICATE_LEAD: 409,
  BROKER_CAPPED: 409,
  LEAD_NOT_ASSIGNABLE: 409,
  BROKER_HAS_LEADS: 409,
  SLUG_TAKEN: 409,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

function traceIdOf(): string {
  return currentContext()?.traceId ?? 'unknown';
}

/** Uniform error envelope — the ONLY shape errors ever take. */
export function sendError(
  res: Response,
  code: keyof typeof HTTP_STATUS_BY_CODE | string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const status = HTTP_STATUS_BY_CODE[code] ?? 500;
  const body: ApiErrorBody = {
    success: false,
    error: details ? { code, message, details } : { code, message },
    traceId: traceIdOf(),
  };
  res.status(status).json(body);
}

export function sendSuccess(res: Response, status: number, data: unknown): void {
  res.status(status).json({ success: true, data, traceId: traceIdOf() });
}

/** Terminal error handler — stacks are LOGGED with traceId, NEVER returned. */
export function terminalErrorHandler(log: {
  error(event: string, msg?: string, fields?: Record<string, unknown>): void;
}): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const k = issue.path.join('.') || '_root';
        if (!(k in fieldErrors)) fieldErrors[k] = issue.message;
      }
      sendError(res, 'VALIDATION_ERROR', 'Validation failed.', {
        fields: fieldErrors,
      });
      return;
    }

    if (err instanceof AppError) {
      sendError(res, err.code, err.message, err.details);
      return;
    }

    log.error('http.response', 'Unhandled error', {
      path: _req.originalUrl.split('?')[0],
      method: _req.method,
      errorStack: err instanceof Error ? err.stack : String(err),
    });
    sendError(res, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  };
}

/** Envelope-shaped 404 for unmatched routes. */
export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, 'NOT_FOUND', 'Route not found.');
}
