import { describe, expect, test } from "vitest";
import { RateLimiter } from "../src/ratelimit.js";

describe("RateLimiter", () => {
  test("allows up to the limit inside the window", () => {
    let now = 1_000;
    const limiter = new RateLimiter(3, 60_000, () => now);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    const third = limiter.check("a");
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  test("blocks past the limit and reports retryAfter", () => {
    let now = 1_000;
    const limiter = new RateLimiter(2, 60_000, () => now);
    limiter.check("a");
    limiter.check("a");
    const blocked = limiter.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    now += 60_000;
    expect(limiter.check("a").allowed).toBe(true);
  });

  test("keeps separate budgets per key", () => {
    const limiter = new RateLimiter(1, 60_000, () => 1_000);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });
});
