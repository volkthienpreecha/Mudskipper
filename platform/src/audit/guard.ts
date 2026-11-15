/**
 * Abuse limits for POST /api/audit (DECISIONS.md K-316). Two problems on the free plan:
 *
 * - Workers KV allows 1,000 writes per day, and every new audit is a write. Nothing stopped one client from
 *   spending them all.
 * - Ranking costs CPU in proportion to the upload; the claim cap (limits.ts) bounds one request, the rate
 *   limit bounds a client.
 *
 * Pages Functions cannot use the Workers Rate Limiting binding (wrangler 4.162.0 rejects `ratelimits` in a
 * Pages config: it is not in `supportedPagesConfigFields`), so the limits are:
 *
 * 1. `RateLimiter`: a token bucket per client IP (`cf-connecting-ip`) per isolate. Cheap and good enough
 *    against a single script; an isolate is per data centre, so it is a per-location limit like the binding's.
 * 2. `StoreBudget`: a daily store budget shared through KV. Each isolate counts its own stores and adds them to
 *    a per-day counter key every `flushEvery` stores (one extra write per `flushEvery` audits), and re-reads
 *    the counter at most once a minute. Over the budget, the API still ranks but does not store: 200 with
 *    `x-audit-stored: false` and no Location. Concurrent flushes can lose an increment (KV has no atomic add),
 *    so the budget sits well under the quota; a KV write refused for the daily limit degrades the same way.
 */

export interface RateDecision {
  ok: boolean;
  /** Seconds until one more request would be allowed (when !ok). */
  retryAfter: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  readonly capacity: number;
  readonly perSecond: number;
  private readonly maxKeys: number;

  /** `capacity` requests at once, refilled at `perSecond`; at most `maxKeys` clients are tracked. */
  constructor(capacity: number, perSecond: number, maxKeys = 10_000) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.maxKeys = maxKeys;
  }

  take(key: string, nowMs: number): RateDecision {
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.capacity, b.tokens + ((nowMs - b.at) / 1000) * this.perSecond);
      b.at = nowMs;
      this.buckets.delete(key); // re-insert: the map's order is least recently seen first
    } else {
      b = { tokens: this.capacity, at: nowMs };
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / this.perSecond)) };
  }
}

/** POST /api/audit: 20 at once per client, then one every 3 seconds. */
export const defaultRateLimiter = () => new RateLimiter(20, 1 / 3);

export interface BudgetStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export class StoreBudget {
  readonly perDay: number;
  private readonly flushEvery: number;
  private readonly refreshMs: number;
  private day = "";
  private shared = 0;
  private sharedAt = -Infinity;
  private local = 0;

  /** At most `perDay` stores per UTC day across isolates (approximately: see the module comment). */
  constructor(perDay: number, flushEvery = 10, refreshMs = 60_000) {
    this.perDay = perDay;
    this.flushEvery = flushEvery;
    this.refreshMs = refreshMs;
  }

  private key(day: string): string {
    return `budget:audits:${day}`;
  }

  private async sync(kv: BudgetStore, nowMs: number): Promise<void> {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.local = 0;
      this.sharedAt = -Infinity;
    }
    if (nowMs - this.sharedAt >= this.refreshMs) {
      this.shared = Number((await kv.get(this.key(day))) ?? 0) || 0;
      this.sharedAt = nowMs;
    }
  }

  /** May one more audit be stored today? */
  async allows(kv: BudgetStore, nowMs: number): Promise<boolean> {
    await this.sync(kv, nowMs);
    return this.shared + this.local < this.perDay;
  }

  /** Count a store; every `flushEvery` stores, add this isolate's count to the shared counter. */
  async stored(kv: BudgetStore, nowMs: number): Promise<void> {
    await this.sync(kv, nowMs);
    this.local += 1;
    if (this.local < this.flushEvery) return;
    const current = Number((await kv.get(this.key(this.day))) ?? 0) || 0;
    const next = current + this.local;
    await kv.put(this.key(this.day), String(next), { expirationTtl: 2 * 86_400 });
    this.shared = next;
    this.sharedAt = nowMs;
    this.local = 0;
  }
}

/** 800 stored audits per day leaves room under KV's 1,000 daily writes for the counter and for publishing. */
export const defaultStoreBudget = () => new StoreBudget(800);
