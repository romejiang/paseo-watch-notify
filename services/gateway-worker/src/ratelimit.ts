export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfter: number;
  /** Requests left in the current window. */
  remaining: number;
  limit: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter, identical in behaviour to the Node gateway's.
 *
 * In a Worker the map lives for the isolate's lifetime, so the budget is enforced per isolate
 * rather than globally: bursts spread over many isolates can exceed it. That is a deliberate
 * trade-off for a zero-configuration limiter; the client-visible behaviour (429 with `Retry-After`
 * once the budget is used) matches the Node deployment.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private static readonly MAX_KEYS = 10_000;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): RateLimitDecision {
    const t = this.now();
    if (this.windows.size > RateLimiter.MAX_KEYS) {
      this.sweep(t);
    }
    const current = this.windows.get(key);
    if (!current || current.resetAt <= t) {
      this.windows.set(key, { count: 1, resetAt: t + this.windowMs });
      return { allowed: true, retryAfter: 0, remaining: this.limit - 1, limit: this.limit };
    }
    if (current.count >= this.limit) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((current.resetAt - t) / 1000)),
        remaining: 0,
        limit: this.limit,
      };
    }
    current.count += 1;
    return {
      allowed: true,
      retryAfter: 0,
      remaining: Math.max(0, this.limit - current.count),
      limit: this.limit,
    };
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}

/** Cloudflare sets `CF-Connecting-IP`; fall back to the proxy headers for local dev. */
export function clientAddress(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct) {
    return direct;
  }
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) {
    return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
