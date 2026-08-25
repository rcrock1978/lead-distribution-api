import { RESERVED_SLUGS } from '../../contracts';
import { AppError } from '../../domain/errors/app-error';
import { bumpConfigVersion } from '../../services/config-version';

export interface FormRecord {
  id: number;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface FormRepositoryPort {
  findSingleton(): Promise<FormRecord | null>;
  findBySlug(slug: string): Promise<{ id: number } | null>;
  createWithVersionBump(name: string, slug: string): Promise<FormRecord>;
}/** Characters that cannot survive a URL path segment. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

const MAX_SLUG_ATTEMPTS = 50;

/**
 * Creates THE single form (INV: one form forever). The slug is auto-derived
 * from the name; collisions and reserved words are resolved by numeric
 * suffixing (SLUG_TAKEN retry). ConfigVersion bumps inside the same
 * transaction so cross-process caches invalidate immediately.
 */
export class CreateFormUseCase {
  constructor(private readonly forms: FormRepositoryPort) {}

  async execute(input: { name: string }): Promise<FormRecord> {
    const existing = await this.forms.findSingleton();
    if (existing !== null) {
      throw new AppError(
        'FORM_ALREADY_EXISTS',
        'A form already exists. Only one form can be created.',
      );
    }

    const base = slugify(input.name);
    if (base.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Validation failed.',
        { fields: { name: 'Name must contain usable characters.' } },
      );
    }

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const candidate =
        attempt === 0 ? base : `${base.slice(0, 50 - String(attempt + 1).length - 1)}-${attempt + 1}`;
      if (RESERVED_SLUGS.includes(candidate)) continue;

      const taken = await this.forms.findBySlug(candidate);
      if (taken !== null) continue;

      return this.forms.createWithVersionBump(input.name, candidate);
    }

    throw new AppError('SLUG_TAKEN', 'That URL slug is already in use.');
  }
}
