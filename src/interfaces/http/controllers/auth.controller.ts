import { Router, type Request, type Response } from 'express';

import { loginInputSchema } from '../../../contracts';
import { AppError } from '../../../domain/errors/app-error';
import { maskEmail } from '../../../infrastructure/observability/logger';
import {
  SESSION_COOKIE_NAME,
} from '../../../infrastructure/security/jwt.service';
import type { JwtService } from '../../../infrastructure/security/jwt.service';
import { verifyPassword } from '../../../infrastructure/security/bcrypt.service';
import type { Logger } from '../../../infrastructure/observability/logger';
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../../../config/env';
import { sendError, sendSuccess } from '../middleware/error-handler';

export interface AuthDeps {
  env: Env;
  log: Logger;
  prisma: PrismaClient;
  jwt: JwtService;
}

/**
 * POST /api/auth/login — bcrypt compare (NEVER in middleware), generic 401 on
 * any mismatch (no user enumeration), audit events with masked emails.
 * GET  /api/auth/me    — served from req.user (JWT already verified upstream).
 * POST /api/auth/logout — clears the cookie; no server-side revocation.
 */
export function authRoutes(deps: AuthDeps): Router {
  const router = Router();

  router.post('/login', async (req: Request, res: Response) => {
    const input = loginInputSchema.parse(req.body);

    const user = await deps.prisma.user.findUnique({
      where: { email: input.email },
    });
    const ok =
      user !== null && (await verifyPassword(input.password, user.passwordHash));

    if (!ok || user === null) {
      deps.log.info('auth.login.failed', 'Login failed', {
        emailMasked: maskEmail(input.email),
      });
      sendError(res, 'UNAUTHORIZED', 'Please log in to continue.');
      return;
    }

    const token = deps.jwt.sign({ sub: user.id, email: user.email });
    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: deps.jwt.maxAgeSeconds * 1000,
      secure: deps.env.isProduction,
    });
    deps.log.info('auth.login.succeeded', 'Login succeeded', {
      userId: user.id,
      emailMasked: maskEmail(user.email),
    });
    sendSuccess(res, 200, { user: { id: user.id, email: user.email } });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: deps.env.isProduction,
      expires: new Date(0),
    });
    deps.log.info('auth.logout');
    sendSuccess(res, 200, { loggedOut: true });
  });

  router.get('/me', (req: Request, res: Response) => {
    if (req.user === undefined) {
      throw new AppError('UNAUTHORIZED', 'Please log in to continue.');
    }
    sendSuccess(res, 200, { id: req.user.id, email: req.user.email });
  });

  return router;
}
