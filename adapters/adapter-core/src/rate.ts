/**
 * Rate limiting (threats: flood of writes / endless queued work). A fixed-window
 * counter per (caller, route class). Fail closed: over the limit answers 429
 * `rate_limited` with a `retryAfterSeconds` hint; an internal error never blocks
 * a request (that is a policy decision, not an adapter bug).
 *
 * Defaults mirror the reference deployment: data 1200/min, ops 300/min. Reads
 * and writes both count against the data budget.
 */
export type RouteClass = "data" | "ops";

export interface RateLimits {
  /** requests per window against the records/data surface. */
  data: number;
  /** requests per window against the operations surface. */
  ops: number;
  /** window length in ms. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { data: 1200, ops: 300, windowMs: 60_000 };

interface Window {
  count: number;
  start: number;
}

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  limit: number;
}

export class RateLimiter {
  private readonly limits: RateLimits;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();

  constructor(limits: RateLimits, now: () => number = () => Date.now()) {
    this.limits = limits;
    this.now = now;
  }

  /** Count one request from `caller` against `cls`; decide if it is allowed. */
  check(caller: string, cls: RouteClass): RateDecision {
    const limit = cls === "ops" ? this.limits.ops : this.limits.data;
    if (limit <= 0) return { allowed: true, retryAfterSeconds: 0, limit }; // disabled
    const key = cls + " " + caller;
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.limits.windowMs) {
      w = { count: 0, start: t };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count > limit) {
      const retryMs = this.limits.windowMs - (t - w.start);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)), limit };
    }
    return { allowed: true, retryAfterSeconds: 0, limit };
  }
}
