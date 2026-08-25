import { Router } from 'express';

import type { NegativeSlugCache } from '../../../infrastructure/persistence/cache/negative-slug-cache';
import type { PrismaClient } from '@prisma/client';
import { sendError, sendSuccess } from '../middleware/error-handler';

export interface PublicFormDeps {
  prisma: PrismaClient;
  negativeSlugCache: NegativeSlugCache;
}

/**
 * GET /api/public/form/:slug — no auth, rate-limited upstream. Unknown slugs
 * are served from the bounded negative cache (30s TTL, cleared on form
 * creation); a miss still hits MySQL exactly once before being cached.
 */
export function publicFormRoutes(deps: PublicFormDeps): Router {
  const router = Router();

  router.get('/form/:slug', async (req, res) => {
    const slug = String(req.params.slug ?? '');

    if (deps.negativeSlugCache.has(slug)) {
      sendError(res, 'NOT_FOUND', 'Form not found.');
      return;
    }

    const form = await deps.prisma.form.findUnique({
      where: { slug },
      select: { name: true, slug: true },
    });

    if (form === null) {
      deps.negativeSlugCache.add(slug);
      sendError(res, 'NOT_FOUND', 'Form not found.');
      return;
    }

    sendSuccess(res, 200, { name: form.name, slug: form.slug });
  });

  return router;
}
