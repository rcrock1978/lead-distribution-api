import type { NextFunction, Request, Response } from 'express';

/**
 * Middleware #3 — cache headers per route class (contracts/api.md §Cache
 * headers). Principle V: everything authenticated is unstorable everywhere;
 * only the non-PII public form GET is shared-cacheable.
 */
export function cacheHeadersMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path.startsWith('/api/health')) {
      res.setHeader('Cache-Control', 'no-store');
    } else if (
      req.method === 'GET' &&
      /^\/api\/public\/form\/[^/]+$/.test(req.path)
    ) {
      res.setHeader(
        'Cache-Control',
        'public, max-age=60, stale-while-revalidate=300',
      );
    } else if (req.path.startsWith('/api/public')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      // Admin + ops + any authenticated surface.
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private',
      );
    }
    next();
  };
}
