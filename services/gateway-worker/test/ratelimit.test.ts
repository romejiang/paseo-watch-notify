import { describe, expect, test } from "vitest";
import { RateLimiterShard } from "../src/ratelimit-object.js";

const WINDOW = 60_000;

describe("rate limiter shard", () => {
  test("allows the budget then reports the retry window", () => {
    const shard = new RateLimiterShard();
    const now = 1_000_000;

    expect(shard.consume("chan", 2, WINDOW, now)).toMatchObject({ allowed: true, remaining: 1, limit: 2 });
    expect(shard.consume("chan", 2, WINDOW, now)).toMatchObject({ allowed: true, remaining: 0, limit: 2 });
    expect(shard.consume("chan", 2, WINDOW, now)).toMatchObject({ allowed: false, retryAfter: 60, remaining: 0 });
  });

  test("separates budgets per key and resets after the window", () => {
    const shard = new RateLimiterShard();
    const now = 1_000_000;

    shard.consume("a", 1, WINDOW, now);
    expect(shard.consume("a", 1, WINDOW, now).allowed).toBe(false);
    // A different key has its own budget.
    expect(shard.consume("b", 1, WINDOW, now).allowed).toBe(true);
    // The next window starts fresh.
    expect(shard.consume("a", 1, WINDOW, now + WINDOW).allowed).toBe(true);
  });

  test("counts down the retry hint as the window drains", () => {
    const shard = new RateLimiterShard();
    shard.consume("a", 1, WINDOW, 0);

    expect(shard.consume("a", 1, WINDOW, 30_000).retryAfter).toBe(30);
    expect(shard.consume("a", 1, WINDOW, 59_500).retryAfter).toBe(1);
  });

  test("exposes the decision over fetch, defaulting bad input", async () => {
    const shard = new RateLimiterShard();

    const allowed = await shard.fetch(new Request("https://rate-limit/?key=chan&limit=1&windowMs=60000"));
    expect(await allowed.json()).toMatchObject({ allowed: true, remaining: 0, limit: 1 });

    const blocked = await shard.fetch(new Request("https://rate-limit/?key=chan&limit=1&windowMs=60000"));
    expect(await blocked.json()).toMatchObject({ allowed: false, limit: 1 });

    // Garbage limit/window fall back to the gateway defaults instead of NaN.
    const fallback = await shard.fetch(new Request("https://rate-limit/?key=other&limit=abc&windowMs=nope"));
    expect(await fallback.json()).toMatchObject({ allowed: true, limit: 60 });
  });
});
