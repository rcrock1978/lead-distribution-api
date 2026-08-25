/**
 * Normalized email form used for storage and duplicate comparison:
 * trim + lowercase (data-model.md §Lead).
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
