/**
 * Bounded negative-slug cache (T030, Constitution V): caches ONLY known-miss
 * slug lookups for the public form endpoint — never anything
 * invariant-participating. LRU-bounded (500 entries) with a 30s TTL, and
 * cleared entirely whenever a form is created so a new public URL resolves
 * immediately.
 */
export class NegativeSlugCache {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(
    private readonly enabled: boolean,
    options: { maxEntries?: number; ttlMs?: number } = {},
  ) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  has(slug: string): boolean {
    if (!this.enabled) return false;
    const expiresAt = this.entries.get(slug);
    if (expiresAt === undefined) return false;
    if (expiresAt < Date.now()) {
      this.entries.delete(slug);
      return false;
    }
    // Refresh recency (LRU).
    this.entries.delete(slug);
    this.entries.set(slug, expiresAt);
    return true;
  }

  add(slug: string): void {
    if (!this.enabled) return;
    if (this.entries.size >= this.maxEntries) {
      // Evict the least recently used entry.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(slug, Date.now() + this.ttlMs);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
