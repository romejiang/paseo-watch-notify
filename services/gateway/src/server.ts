import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PushSender } from "./apns.js";
import type { ApnsEnvironment } from "./config.js";
import { channelIdFromSecret, type DeviceStore } from "./devices.js";
import { buildApnsPayload, type NotifyPayload } from "./payload.js";
import { clientAddress, RateLimiter, type RateLimitDecision } from "./ratelimit.js";

export interface GatewayDeps {
  store: DeviceStore;
  sender: PushSender;
  logger?: (message: string, meta?: unknown) => void;
  /** Defaults applied when a device registration omits environment/topic. */
  defaultEnvironment: ApnsEnvironment;
  defaultTopic: string;
  maxBodyBytes?: number;
  rateLimit?: {
    enabled: boolean;
    perChannel: number;
    perIp: number;
    windowMs: number;
  };
}

interface NotifyResponse {
  delivered: number;
  failed: number;
  devices: number;
}

const JSON_HEADERS = { "content-type": "application/json" };

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      return { ok: false, status: 413, error: "request body too large" };
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return { ok: true, value: {} };
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
}

/** The bearer token is the caller's channel secret. */
function channelSecret(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

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

function sendTooMany(response: ServerResponse, decision: RateLimitDecision): void {
  const payload = JSON.stringify({ error: "rate limited", retryAfter: decision.retryAfter });
  response.writeHead(429, {
    ...JSON_HEADERS,
    "content-length": Buffer.byteLength(payload),
    "retry-after": String(decision.retryAfter),
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": "0",
  });
  response.end(payload);
}

export function createServer(deps: GatewayDeps) {
  const log = deps.logger ?? (() => {});
  const maxBodyBytes = deps.maxBodyBytes ?? 64 * 1024;
  const limitConfig = deps.rateLimit ?? { enabled: false, perChannel: 60, perIp: 120, windowMs: 60_000 };
  const channelLimiter = limitConfig.enabled
    ? new RateLimiter(limitConfig.perChannel, limitConfig.windowMs)
    : null;
  const ipLimiter = limitConfig.enabled ? new RateLimiter(limitConfig.perIp, limitConfig.windowMs) : null;

  return createHttpServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log("request failed", error instanceof Error ? error.message : String(error));
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal error" });
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    // Unauthenticated flood guard, applied to every API route.
    if (ipLimiter) {
      const decision = ipLimiter.check(clientAddress(request));
      if (!decision.allowed) {
        log("rate limited", { scope: "ip" });
        sendTooMany(response, decision);
        return;
      }
    }

    // Every API route is scoped to the caller's channel.
    const secret = channelSecret(request);
    if (!secret) {
      sendJson(response, 401, { error: "missing bearer token" });
      return;
    }
    const channelId = channelIdFromSecret(secret);

    // Per-user budget, so one noisy user cannot affect others.
    if (channelLimiter) {
      const decision = channelLimiter.check(channelId);
      if (!decision.allowed) {
        log("rate limited", { scope: "channel" });
        sendTooMany(response, decision);
        return;
      }
    }

    if (method === "POST" && url.pathname === "/api/notify") {
      const body = await readJsonBody(request, maxBodyBytes);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      const result = await deliver(channelId, body.value as NotifyPayload);
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/devices") {
      const body = await readJsonBody(request, maxBodyBytes);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      const input = body.value as {
        token?: string;
        environment?: string;
        topic?: string;
        platform?: string;
      };
      const token = input.token?.trim();
      if (!token) {
        sendJson(response, 400, { error: "token is required" });
        return;
      }
      const record = deps.store.upsert(channelId, {
        token,
        environment: asEnvironment(input.environment, deps.defaultEnvironment),
        topic: input.topic?.trim() || deps.defaultTopic,
        platform: input.platform?.trim(),
      });
      sendJson(response, 201, record);
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/api/devices/")) {
      let token: string;
      try {
        token = decodeURIComponent(url.pathname.slice("/api/devices/".length));
      } catch {
        sendJson(response, 400, { error: "invalid device token" });
        return;
      }
      const removed = deps.store.remove(channelId, token);
      sendJson(response, removed ? 200 : 404, { removed });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  async function deliver(channelId: string, payload: NotifyPayload): Promise<NotifyResponse> {
    const devices = deps.store.list(channelId);
    if (devices.length === 0) {
      log("no registered devices for channel; dropping notification");
      return { delivered: 0, failed: 0, devices: 0 };
    }
    const apnsPayload = buildApnsPayload(payload);
    let delivered = 0;
    let failed = 0;
    await Promise.all(
      devices.map(async (device) => {
        const result = await deps.sender.send(
          { token: device.token, environment: device.environment, topic: device.topic },
          apnsPayload,
        );
        if (result.ok) {
          delivered += 1;
          return;
        }
        failed += 1;
        // 410 means the token is no longer valid; drop it.
        if (result.status === 410) {
          deps.store.remove(channelId, device.token);
        }
        log("push failed", {
          token: device.token.slice(0, 8),
          status: result.status,
          reason: result.reason ?? result.error,
        });
      }),
    );
    return { delivered, failed, devices: devices.length };
  }
}

export function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}
