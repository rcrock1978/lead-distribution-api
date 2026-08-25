import { Router } from 'express';

import { CreateFormUseCase } from '../../../application/use-cases/create-form.use-case';
import { formCreateInputSchema } from '../../../contracts';
import { bumpConfigVersion } from '../../../services/config-version';
import type { NegativeSlugCache } from '../../../infrastructure/persistence/cache/negative-slug-cache';
import type { Env } from '../../../config/env';
import type { Logger } from '../../../infrastructure/observability/logger';
import type { PrismaClient } from '@prisma/client';
import { sendSuccess } from '../middleware/error-handler';

export interface FormDeps {
  env: Env;
  log: Logger;
  prisma: PrismaClient;
  negativeSlugCache: NegativeSlugCache;
}

/**
 * GET  /api/form — current form or `{ form: null }` before onboarding.
 * POST /api/form — CreateFormUseCase; clears the negative-slug cache so a
 * freshly created public URL resolves instantly (T030 contract).
 */
export function formRoutes(deps: FormDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const form = await deps.prisma.form.findFirst({ orderBy: { id: 'asc' } });
    if (form === null) {
      sendSuccess(res, 200, { form: null });
      return;
    }
    sendSuccess(res, 200, {
      id: form.id,
      name: form.name,
      slug: form.slug,
      publicUrl: `/f/${form.slug}`,
      createdAt: form.createdAt,
    });
  });

  router.post('/', async (req, res) => {
    const input = formCreateInputSchema.parse(req.body);

    const useCase = new CreateFormUseCase({
      findSingleton: async () => {
        const found = await deps.prisma.form.findFirst({
          where: { singleton: { not: null } },
        });
        return found ?? null;
      },
      findBySlug: async (slug) =>
        deps.prisma.form.findUnique({ where: { slug }, select: { id: true } }),
      createWithVersionBump: async (name, slug) => {
        const created = await deps.prisma.$transaction(async (tx) => {
          const form = await tx.form.create({
            data: { name, slug, singleton: true },
          });
          await bumpConfigVersion(tx);
          return form;
        });
        deps.log.info('form.created', 'Form created', {
          formId: created.id,
          slug: created.slug,
        });
        deps.negativeSlugCache.clear();
        return created;
      },
    });

    const form = await useCase.execute(input);
    sendSuccess(res, 201, {
      id: form.id,
      name: form.name,
      slug: form.slug,
      publicUrl: `/f/${form.slug}`,
      createdAt: form.createdAt,
    });
  });

  return router;
}
