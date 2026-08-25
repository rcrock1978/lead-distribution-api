import rateLimit from 'express-rate-limit';

import { sendError } from './error-handler';

/**
 * Middleware #5 — mounted on /api/public/* ONLY (research D3): per-IP window
 * of PUBLIC_RATE_LIMIT_PER_MIN submissions/minute (default ≥30, above the
 * concurrency-test burst of 20). Keyed by the EDGE-RESOLVED client IP
 * (X-Client-IP), which is trustworthy here because the internal-token guard
 * has already run and rejected spoofing attempts.
 */
export function createPublicRateLimiter(limitPerMin: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMin,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // The edge ALWAYS sets X-Client-IP (internal-token guard rejects spoofing
    // before this middleware runs), so the IPv6 fallback validation is noise.
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) =>
      req.header('x-client-ip') ?? req.ip ?? 'unknown',
    handler: (req, res) => {
      // Retry-After in whole seconds until the window resets.
      const resetSeconds = Math.max(
        1,
        Math.ceil(((res.getHeader('RateLimit-Reset') as number | undefined) ?? 60)),
      );
      res.setHeader('Retry-After', resetSeconds);
      sendError(res, 'RATE_LIMITED', 'Too many submissions. Please try again shortly.');
      void req;
    },
  });
}
