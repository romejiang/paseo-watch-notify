import { createApnsSender, type ApnsSender } from "./apns.js";
import { createKvDeviceStore, type DeviceStore } from "./devices.js";
import {
  isDryRun,
  resolveApnsConfig,
  resolveRateLimitConfig,
  type ApnsEnvironment,
  type Env,
  type RateLimitConfig,
} from "./env.js";
import { buildApnsPayload, type NotifyPayload } from "./payload.js";
import { clientAddress, RateLimiter, type RateLimitDecision } from "./ratelimit.js";
import { RateLimiterShard } from "./ratelimit-object.js";

// Durable Object classes must be exported from the Worker entry module.
export { RateLimiterShard };

export interface HandlerDeps {
  devices: DeviceStore;
  sender: ApnsSender;
  dryRun: boolean;
  defaultTopic: string;
  defaultEnvironment: ApnsEnvironment;
  rateLimit?: RateLimitConfig;
  /** Durable Object namespace holding the authoritative budgets; falls back to memory when absent. */
  rateLimitShards?: DurableObjectNamespace;
  logger?: (message: string, meta?: unknown) => void;
}

const JSON_HEADERS = { "content-type": "application/json" };
/** Matches the Node gateway's body limit. */
const MAX_BODY_BYTES = 64 * 1024;

// Module scope so the budget survives across requests inside the isolate. Limiters are rebuilt
// only if the configured limits change.
let cachedConfig: RateLimitConfig | null = null;
let channelLimiter: RateLimiter | null = null;
let ipLimiter: RateLimiter | null = null;

function limitersFor(config: RateLimitConfig): { channel: RateLimiter; ip: RateLimiter } {
  if (
    !cachedConfig ||
    !channelLimiter ||
    !ipLimiter ||
    cachedConfig.perChannel !== config.perChannel ||
    cachedConfig.perIp !== config.perIp ||
    cachedConfig.windowMs !== config.windowMs
  ) {
    cachedConfig = config;
    channelLimiter = new RateLimiter(config.perChannel, config.windowMs);
    ipLimiter = new RateLimiter(config.perIp, config.windowMs);
  }
  return { channel: channelLimiter, ip: ipLimiter };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Hash the channel secret so the raw secret is never persisted. */
async function channelId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

async function readJson(request: Request): Promise<BodyResult> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "request body too large" };
  }
  if (text.trim() === "") {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
}

/** Honor the device's reported environment; fall back to the deployment default. */
/**
 * Map a device-reported environment onto an APNs host.
 *
 * `"sandbox"` is Apple's older name for the development environment, so it maps deterministically
 * instead of falling through to the deployment default. Anything unrecognised uses the default.
 */
function asEnvironment(value: unknown, fallback: ApnsEnvironment): ApnsEnvironment {
  if (value === "production") {
    return "production";
  }
  if (value === "development" || value === "sandbox") {
    return "development";
  }
  return fallback;
}

function tooMany(decision: RateLimitDecision): Response {
  return json(
    429,
    { error: "rate limited", retryAfter: decision.retryAfter },
    {
      "retry-after": String(decision.retryAfter),
      "x-ratelimit-limit": String(decision.limit),
      "x-ratelimit-remaining": "0",
    },
  );
}

/** Shard the budget by key so no single Durable Object has to serve the whole world. */
const SHARD_COUNT = 8;

function shardName(scope: "channel" | "ip", key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return `${scope}:${Math.abs(hash) % SHARD_COUNT}`;
}

/**
 * Spend one token from a budget.
 *
 * The Durable Object is authoritative because a per-isolate counter cannot hold a budget across the
 * many isolates a real Worker runs in. Without the binding (tests, local dev) the in-isolate
 * limiter answers instead, using the identical fixed-window algorithm.
 */
async function enforceLimit(
  shards: DurableObjectNamespace | undefined,
  fallback: RateLimiter,
  scope: "channel" | "ip",
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitDecision> {
  if (shards) {
    const stub = shards.get(shards.idFromName(shardName(scope, key)));
    const query = new URLSearchParams({ key, limit: String(limit), windowMs: String(windowMs) });
    const response = await stub.fetch(`https://rate-limit/?${query.toString()}`);
    return (await response.json()) as RateLimitDecision;
  }
  return fallback.check(key);
}

export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  if (method === "GET" && url.pathname === "/healthz") {
    return json(200, { ok: true });
  }

  const limitConfig = deps.rateLimit ?? { enabled: false, perChannel: 60, perIp: 120, windowMs: 60_000 };
  const limiters = limitConfig.enabled ? limitersFor(limitConfig) : null;

  // Unauthenticated flood guard, applied to every API route.
  if (limiters) {
    const decision = await enforceLimit(
      deps.rateLimitShards,
      limiters.ip,
      "ip",
      clientAddress(request),
      limitConfig.perIp,
      limitConfig.windowMs,
    );
    if (!decision.allowed) {
      deps.logger?.("rate limited", { scope: "ip" });
      return tooMany(decision);
    }
  }

  // Every API route is scoped to a channel identified by the bearer secret.
  const secret = bearer(request);
  if (!secret) {
    return json(401, { error: "missing bearer token" });
  }
  const channel = await channelId(secret);

  // Per-user budget, so one noisy user cannot affect others.
  if (limiters) {
    const decision = await enforceLimit(
      deps.rateLimitShards,
      limiters.channel,
      "channel",
      channel,
      limitConfig.perChannel,
      limitConfig.windowMs,
    );
    if (!decision.allowed) {
      deps.logger?.("rate limited", { scope: "channel" });
      return tooMany(decision);
    }
  }

  if (method === "POST" && url.pathname === "/api/devices") {
    const body = await readJson(request);
    if (!body.ok) {
      return json(body.status, { error: body.error });
    }
    const input = body.value as {
      token?: string;
      environment?: string;
      topic?: string;
      platform?: string;
    };
    const token = input.token?.trim();
    if (!token) {
      return json(400, { error: "token is required" });
    }
    const record = {
      token,
      environment: asEnvironment(input.environment, deps.defaultEnvironment),
      topic: input.topic?.trim() || deps.defaultTopic,
      platform: input.platform?.trim(),
      updatedAt: new Date().toISOString(),
    };
    await deps.devices.put(channel, record);
    return json(201, record);
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/devices/")) {
    let token: string;
    try {
      token = decodeURIComponent(url.pathname.slice("/api/devices/".length));
    } catch {
      return json(400, { error: "invalid device token" });
    }
    const removed = await deps.devices.remove(channel, token);
    return json(removed ? 200 : 404, { removed });
  }

  if (method === "POST" && url.pathname === "/api/notify") {
    const body = await readJson(request);
    if (!body.ok) {
      return json(body.status, { error: body.error });
    }
    const payload = body.value as NotifyPayload;
    const devices = await deps.devices.list(channel);
    if (devices.length === 0) {
      deps.logger?.("no registered devices for channel; dropping notification");
      return json(200, { delivered: 0, failed: 0, devices: 0 });
    }

    const apnsPayload = buildApnsPayload(payload);
    let delivered = 0;
    let failed = 0;

    await Promise.all(
      devices.map(async (device) => {
        if (deps.dryRun) {
          deps.logger?.(
            "DRY RUN would push:",
            JSON.stringify(
              { token: device.token.slice(0, 8), topic: device.topic, payload: apnsPayload },
              null,
              2,
            ),
          );
          delivered += 1;
          return;
        }
        const result = await deps.sender.send(
          { token: device.token, environment: device.environment, topic: device.topic },
          apnsPayload,
        );
        if (result.ok) {
          delivered += 1;
          return;
        }
        failed += 1;
        if (result.status === 410) {
          await deps.devices.remove(channel, device.token);
        }
        deps.logger?.("push failed", {
          token: device.token.slice(0, 8),
          status: result.status,
          reason: result.reason ?? result.error,
        });
      }),
    );

    return json(200, { delivered, failed, devices: devices.length });
  }

  return json(404, { error: "not found" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = resolveApnsConfig(env);
    const deps: HandlerDeps = {
      devices: createKvDeviceStore(env.DEVICES),
      sender: createApnsSender({
        keyPem: config.keyPem,
        keyId: config.keyId,
        teamId: config.teamId,
      }),
      dryRun: isDryRun(env),
      defaultTopic: config.topic,
      defaultEnvironment: config.environment,
      rateLimit: resolveRateLimitConfig(env),
      rateLimitShards: env.RATE_LIMIT_SHARDS,
      logger: (message, meta) => console.log(`[gateway] ${message}`, meta ?? ""),
    };
    return handle(request, deps);
  },
} satisfies ExportedHandler<Env>;

