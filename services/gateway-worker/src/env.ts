export type ApnsEnvironment = "development" | "production";

export interface Env {
  /** KV namespace holding registered device tokens, keyed per channel. */
  DEVICES: KVNamespace;
  /** APNs signing key (.p8) contents. Set with `wrangler secret put APNS_KEY_P8`. */
  APNS_KEY_P8?: string;
  /** APNs Key ID. Set with `wrangler secret put APNS_KEY_ID`. */
  APNS_KEY_ID?: string;
  /** Apple Team ID. Set with `wrangler secret put APNS_TEAM_ID`. */
  APNS_TEAM_ID?: string;
  /** Default APNs topic (the iOS app's Bundle ID shared by all users). */
  APNS_TOPIC?: string;
  /** Default APNs environment for devices that do not specify one. */
  APNS_ENV?: string;
  /** "1" logs pushes instead of contacting APNs; lets you test without Apple credentials. */
  DRY_RUN?: string;
  /** Rate limiting, matching the Node gateway. `RATE_LIMIT_ENABLED` defaults to on. */
  RATE_LIMIT_ENABLED?: string;
  RATE_LIMIT_PER_CHANNEL?: string;
  RATE_LIMIT_PER_IP?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  /**
   * Durable Object namespace backing the rate limiter. Cloudflare's declarative `[[ratelimits]]`
   * binding is only enforced per isolate, which a burst can outrun, so the budget lives in a DO.
   * When absent (unit tests, `wrangler dev` without the binding) an in-isolate limiter is used.
   */
  RATE_LIMIT_SHARDS?: DurableObjectNamespace;
}

export interface RateLimitConfig {
  enabled: boolean;
  perChannel: number;
  perIp: number;
  windowMs: number;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Same defaults and semantics as the Node gateway. */
export function resolveRateLimitConfig(env: Env): RateLimitConfig {
  return {
    enabled: env.RATE_LIMIT_ENABLED === undefined ? true : isTruthy(env.RATE_LIMIT_ENABLED),
    perChannel: positiveInt(env.RATE_LIMIT_PER_CHANNEL, 60),
    perIp: positiveInt(env.RATE_LIMIT_PER_IP, 120),
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
  };
}

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
  environment: ApnsEnvironment;
}

/** Same accepted values and default as the Node gateway's `loadConfig`. */
function parseEnvironment(value: string | undefined): ApnsEnvironment {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production") {
    return "production";
  }
  if (normalized === "development" || normalized === "sandbox" || !normalized) {
    return "development";
  }
  throw new Error(`APNS_ENV must be "development" or "production", got ${value}`);
}

export function resolveApnsConfig(env: Env): ApnsConfig {
  return {
    keyPem: (env.APNS_KEY_P8 ?? "").trim().replace(/\\n/g, "\n"),
    keyId: env.APNS_KEY_ID?.trim() || "",
    teamId: env.APNS_TEAM_ID?.trim() || "",
    topic: env.APNS_TOPIC?.trim() || "com.example.paseonotify",
    environment: parseEnvironment(env.APNS_ENV),
  };
}

export function isDryRun(env: Env): boolean {
  const value = (env.DRY_RUN ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
