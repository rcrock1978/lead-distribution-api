import type { NextFunction, Request, Response } from 'express';

import { timingSafeCompare } from '../../../infrastructure/security/timing-safe-compare';
import { sendError } from './error-handler';

/**
 * Middleware #4 — internal-token guard (constant-time).
 *
 * Policy (contracts/api.md §Auth model):
 *  - /api/public/*  → X-Internal-Token REQUIRED. These routes are only ever
 *    reached as edge forwards from the Next.js server; the browser never talks
 *    to the backend directly (loopback bind). Spoofed client IP headers die here.
 *  - everywhere else → if the header is PRESENT it must be correct (wrong token
 *    rejects even with a valid cookie — "regardless of cookies"); absence is
 *    allowed so direct curl-with-cookie admin access keeps working.
 *  - /api/health*   → untouched.
 */
export function internalTokenGuard(internalToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path.startsWith('/api/health')) return next();

    const provided = req.header('x-internal-token');
    const isPublic = req.path.startsWith('/api/public');

    if (isPublic || provided !== undefined) {
      if (provided === undefined || !timingSafeCompare(provided, internalToken)) {
        sendError(res, 'UNAUTHORIZED', 'Please log in to continue.');
        return;
      }
    }
    next();
  };
}
