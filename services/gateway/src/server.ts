import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PushSender } from "./apns.js";
import type { ApnsEnvironment } from "./config.js";
import type { DeviceStore } from "./devices.js";
import { buildApnsPayload, type NotifyPayload } from "./payload.js";

export interface GatewayDeps {
  store: DeviceStore;
  sender: PushSender;
  gatewayToken: string;
  deviceToken: string;
  logger?: (message: string, meta?: unknown) => void;
  /** Defaults applied when a device registration omits environment/topic. */
  defaultEnvironment: ApnsEnvironment;
  defaultTopic: string;
  maxBodyBytes?: number;
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

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

function authorized(request: IncomingMessage, expected: string): boolean {
  if (!expected) {
    return true;
  }
  return bearerToken(request) === expected;
}

function asEnvironment(value: unknown, fallback: ApnsEnvironment): ApnsEnvironment {
  if (value === "production" || value === "development") {
    return value;
  }
  return fallback;
}

export function createServer(deps: GatewayDeps) {
  const log = deps.logger ?? (() => {});
  const maxBodyBytes = deps.maxBodyBytes ?? 64 * 1024;

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
      sendJson(response, 200, { ok: true, devices: deps.store.list().length });
      return;
    }

    if (method === "POST" && url.pathname === "/api/notify") {
      if (!authorized(request, deps.gatewayToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = (await readJsonBody(request, maxBodyBytes)) as NotifyPayload;
      const result = await deliver(body);
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/devices") {
      if (!authorized(request, deps.deviceToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = (await readJsonBody(request, maxBodyBytes)) as {
        token?: string;
        environment?: string;
        topic?: string;
        platform?: string;
      };
      const token = body.token?.trim();
      if (!token) {
        sendJson(response, 400, { error: "token is required" });
        return;
      }
      const record = deps.store.upsert({
        token,
        environment: asEnvironment(body.environment, deps.defaultEnvironment),
        topic: body.topic?.trim() || deps.defaultTopic,
        platform: body.platform?.trim(),
      });
      sendJson(response, 201, record);
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/api/devices/")) {
      if (!authorized(request, deps.deviceToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const token = decodeURIComponent(url.pathname.slice("/api/devices/".length));
      const removed = deps.store.remove(token);
      sendJson(response, removed ? 200 : 404, { removed });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  async function deliver(payload: NotifyPayload): Promise<NotifyResponse> {
    const devices = deps.store.list();
    if (devices.length === 0) {
      log("no registered devices; dropping notification");
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
          deps.store.remove(device.token);
        }
        log("push failed", { token: device.token.slice(0, 8), status: result.status, reason: result.reason ?? result.error });
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
