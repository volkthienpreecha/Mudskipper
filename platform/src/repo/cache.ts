/**
 * Per-isolate memo for parsed JSON. Workers isolates live for many requests, so a parsed fields list or
 * manifest is reused instead of re-fetched and re-parsed (the free plan allows 10 ms CPU per request).
 * Entries are promises, so concurrent requests share one fetch; a rejected promise is evicted.
 */
export class IsolateCache {
  private readonly entries = new Map<string, { value: Promise<unknown>; expires: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries = 64) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: now + ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const FOREVER = Number.POSITIVE_INFINITY;
