import type { NextFunction, Request, Response } from 'express';

import { SESSION_COOKIE_NAME } from '../../../infrastructure/security/jwt.service';
import type { JwtService } from '../../../infrastructure/security/jwt.service';
import { sendError } from './error-handler';

export interface AuthedUser {
  id: number;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

/** Routes that never require a session cookie. */
const EXEMPT_PREFIXES = ['/api/public', '/api/health'];
const EXEMPT_EXACT = ['/api/auth/login', '/api/auth/logout'];

/**
 * Middleware #7 — JWT verify (signature + expiry ONLY, no DB lookup — D5).
 * Applies to every /api route except the exemptions above.
 */
export function jwtVerifyMiddleware(jwt: JwtService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (EXEMPT_EXACT.includes(req.path)) return next();
    if (!req.path.startsWith('/api/')) return next();

    const raw = req.cookies?.[SESSION_COOKIE_NAME];
    if (typeof raw !== 'string') {
      sendError(res, 'UNAUTHORIZED', 'Please log in to continue.');
      return;
    }
    const payload = jwt.verify(raw);
    if (payload === null) {
      sendError(res, 'UNAUTHORIZED', 'Please log in to continue.');
      return;
    }
    req.user = { id: payload.sub, email: payload.email };
    next();
  };
}
