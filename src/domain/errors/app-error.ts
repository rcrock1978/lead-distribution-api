/**
 * Application error carrying a closed-taxonomy code. HTTP status mapping lives
 * in the interfaces layer (error-handler middleware) — the domain does not
 * know it is on a server (Constitution II).
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORM_ALREADY_EXISTS',
  'FORM_REQUIRED',
  'DISTRIBUTION_ALREADY_EXISTS',
  'DUPLICATE_LEAD',
  'BROKER_CAPPED',
  'LEAD_NOT_ASSIGNABLE',
  'BROKER_HAS_LEADS',
  'SLUG_TAKEN',
  'RATE_LIMITED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
