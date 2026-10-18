import type { IncomingMessage } from "node:http";

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
 * Fixed-window in-memory rate limiter.
 *
 * Zero dependencies and bounded memory: expired windows are swept when the map grows past a
 * threshold. Fixed windows allow a burst at a boundary, which is fine for a notification relay;
 * the per-channel budget is what actually protects users from each other.
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

/**
 * Client address for the per-IP limiter. Behind a reverse proxy the first `x-forwarded-for` entry
 * is the real client; a caller that can reach the gateway directly could spoof it, which is why the
 * per-channel limit exists as well.
 */
export function clientAddress(request: IncomingMessage, trustProxy = true): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
    const realIp = request.headers["x-real-ip"];
    const realValue = Array.isArray(realIp) ? realIp[0] : realIp;
    if (realValue?.trim()) {
      return realValue.trim();
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}
