import { createHash, timingSafeEqual } from 'node:crypto';

/** Length-safe constant-time comparison via SHA-256 digests. */
export function timingSafeCompare(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
