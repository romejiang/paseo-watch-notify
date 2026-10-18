import { createApnsSender, type ApnsSender } from "./apns.js";
import { createKvDeviceStore, type DeviceStore } from "./devices.js";
import { isDryRun, resolveApnsConfig, type ApnsEnvironment, type Env } from "./env.js";
import { buildApnsPayload, type NotifyPayload } from "./payload.js";

export interface HandlerDeps {
  devices: DeviceStore;
  sender: ApnsSender;
  dryRun: boolean;
  defaultTopic: string;
  defaultEnvironment: ApnsEnvironment;
  logger?: (message: string, meta?: unknown) => void;
}

const JSON_HEADERS = { "content-type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  if (method === "GET" && url.pathname === "/healthz") {
    return json(200, { ok: true });
  }

  // Every API route is scoped to a channel identified by the bearer secret.
  const secret = bearer(request);
  if (!secret) {
    return json(401, { error: "missing bearer token" });
  }
  const channel = await channelId(secret);

  if (method === "POST" && url.pathname === "/api/devices") {
    const body = (await readJson(request)) as {
      token?: string;
      environment?: string;
      topic?: string;
      platform?: string;
    };
    const token = body.token?.trim();
    if (!token) {
      return json(400, { error: "token is required" });
    }
    const record = {
      token,
      environment: (body.environment === "production" ? "production" : deps.defaultEnvironment) as ApnsEnvironment,
      topic: body.topic?.trim() || deps.defaultTopic,
      platform: body.platform?.trim(),
      createdAt: new Date().toISOString(),
    };
    await deps.devices.put(channel, record);
    return json(201, record);
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/devices/")) {
    const token = decodeURIComponent(url.pathname.slice("/api/devices/".length));
    const removed = await deps.devices.remove(channel, token);
    return json(removed ? 200 : 404, { removed });
  }

  if (method === "POST" && url.pathname === "/api/notify") {
    const payload = (await readJson(request)) as NotifyPayload;
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
          deps.logger?.("DRY RUN would push:", JSON.stringify({ token: device.token.slice(0, 8), topic: device.topic, payload: apnsPayload }, null, 2));
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
      logger: (message, meta) => console.log(`[gateway] ${message}`, meta ?? ""),
    };
    return handle(request, deps);
  },
} satisfies ExportedHandler<Env>;
