/**
 * Fixed-window rate limiter for the Cloudflare Worker, running in a Durable Object.
 *
 * Cloudflare's declarative `[[ratelimits]]` binding is enforced per isolate, so a burst spread over
 * several isolates walks straight past it — measured in production: 120 concurrent requests against
 * a 60/window budget were all allowed. A Durable Object is a single-threaded actor with one instance
 * per name across the whole network, so a counter kept here is shared by every isolate and every
 * Cloudflare location. That makes the budget as strict as the Node gateway's, which is what lets a
 * client move between the two deployments without noticing.
 *
 * Counters live in memory only. A shard eviction resets its windows early (fails open) rather than
 * blocking anyone; a shard serving steady traffic is not evicted mid-window.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may retry; 0 when allowed. */
  retryAfter: number;
  /** Requests left in the current window. */
  remaining: number;
  limit: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Distinct keys tolerated per shard before expired windows are swept. */
const MAX_KEYS = 10_000;

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class RateLimiterShard {
  private readonly windows = new Map<string, Window>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    const limit = positiveInt(url.searchParams.get("limit"), 60);
    const windowMs = positiveInt(url.searchParams.get("windowMs"), 60_000);
    return Response.json(this.consume(key, limit, windowMs, Date.now()));
  }

  /** Same algorithm, defaults and return shape as the Node gateway's `RateLimiter.check`. */
  consume(key: string, limit: number, windowMs: number, now: number): RateLimitDecision {
    if (this.windows.size > MAX_KEYS) {
      for (const [candidate, window] of this.windows) {
        if (window.resetAt <= now) {
          this.windows.delete(candidate);
        }
      }
    }
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0, remaining: limit - 1, limit };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
        remaining: 0,
        limit,
      };
    }
    current.count += 1;
    return {
      allowed: true,
      retryAfter: 0,
      remaining: Math.max(0, limit - current.count),
      limit,
    };
  }
}
