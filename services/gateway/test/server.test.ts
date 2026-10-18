import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { DeliveryResult, PushSender, PushTarget } from "../src/apns.js";
import { channelIdFromSecret, DeviceStore } from "../src/devices.js";
import { createServer, listen } from "../src/server.js";

interface Captured {
  target: PushTarget;
  payload: unknown;
}

function fakeSender(result: DeliveryResult | ((target: PushTarget) => DeliveryResult)) {
  const captured: Captured[] = [];
  const sender: PushSender = {
    async send(target, payload) {
      captured.push({ target, payload });
      return typeof result === "function" ? result(target) : result;
    },
  };
  return { sender, captured };
}

async function startGateway(options?: {
  result?: DeliveryResult | ((target: PushTarget) => DeliveryResult);
  rateLimit?: { enabled: boolean; perChannel: number; perIp: number; windowMs: number };
  defaultEnvironment?: "development" | "production";
}) {
  const store = new DeviceStore(join(mkdtempSync(join(tmpdir(), "gw-srv-")), "devices.json"));
  const { sender, captured } = fakeSender(options?.result ?? { token: "x", ok: true, status: 200 });
  const server = createServer({
    store,
    sender,
    defaultEnvironment: options?.defaultEnvironment ?? "development",
    defaultTopic: "com.example.paseonotify",
    rateLimit: options?.rateLimit,
  });
  const port = await listen(server, 0);
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return { store, captured, port, close, base: `http://127.0.0.1:${port}` };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close();
  }
});

const CHANNEL = "pn_test_channel_a";
const OTHER = "pn_test_channel_b";

describe("gateway server", () => {
  test("healthz reports ok", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    gateway.store.upsert(channelIdFromSecret(CHANNEL), {
      token: "t1",
      environment: "development",
      topic: "a",
    });
    const response = await fetch(`${gateway.base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("registers a device and forwards a notification to it", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);

    const register = await fetch(`${gateway.base}/api/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "device-1", platform: "watch" }),
    });
    expect(register.status).toBe(201);
    expect((await register.json()) as { topic: string }).toMatchObject({
      topic: "com.example.paseonotify",
    });

    const notify = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ source: "paseo-notify", reason: "finished", preview: "Done." }),
    });
    expect(notify.status).toBe(200);
    expect(await notify.json()).toMatchObject({ delivered: 1, failed: 0, devices: 1 });
    expect(gateway.captured).toHaveLength(1);
    expect(gateway.captured[0]?.target.token).toBe("device-1");
    expect(gateway.captured[0]?.payload).toMatchObject({ source: "paseo-notify" });
  });

  test("isolates channels: another secret sees no devices", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);

    await fetch(`${gateway.base}/api/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "device-1" }),
    });

    const notify = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${OTHER}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "finished" }),
    });
    expect(await notify.json()).toEqual({ delivered: 0, failed: 0, devices: 0 });
    expect(gateway.captured).toHaveLength(0);
  });

  test("rejects API calls without a bearer token", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    const response = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "finished" }),
    });
    expect(response.status).toBe(401);
    expect(gateway.captured).toHaveLength(0);
  });

  test("drops a device when APNs reports 410", async () => {
    const gateway = await startGateway({
      result: { token: "device-1", ok: false, status: 410, reason: "Unregistered" },
    });
    open.push(gateway.close);

    await fetch(`${gateway.base}/api/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "device-1" }),
    });

    const response = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "finished" }),
    });
    expect(await response.json()).toMatchObject({ delivered: 0, failed: 1 });
    expect(gateway.store.list(channelIdFromSecret(CHANNEL))).toEqual([]);
  });

  test("rate limits a channel after its budget is used", async () => {
    const gateway = await startGateway({
      rateLimit: { enabled: true, perChannel: 2, perIp: 100, windowMs: 60_000 },
    });
    open.push(gateway.close);

    const notify = () =>
      fetch(`${gateway.base}/api/notify`, {
        method: "POST",
        headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "finished" }),
      });

    expect((await notify()).status).toBe(200);
    expect((await notify()).status).toBe(200);
    const blocked = await notify();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  test("rate limit is per channel, not global", async () => {
    const gateway = await startGateway({
      rateLimit: { enabled: true, perChannel: 1, perIp: 100, windowMs: 60_000 },
    });
    open.push(gateway.close);

    const notify = (secret: string) =>
      fetch(`${gateway.base}/api/notify`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "finished" }),
      });

    expect((await notify(CHANNEL)).status).toBe(200);
    expect((await notify(CHANNEL)).status).toBe(429);
    // A different channel still has its own budget.
    expect((await notify(OTHER)).status).toBe(200);
  });

  test("honors the device-reported environment", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    const response = await fetch(`${gateway.base}/api/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "t1", environment: "production" }),
    });
    expect((await response.json()) as { environment: string }).toMatchObject({
      environment: "production",
      updatedAt: expect.any(String),
    });
  });

  test("treats sandbox as development even when the default is production", async () => {
    const gateway = await startGateway({ defaultEnvironment: "production" });
    open.push(gateway.close);
    const response = await fetch(`${gateway.base}/api/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "t1", environment: "sandbox" }),
    });
    expect((await response.json()) as { environment: string }).toMatchObject({ environment: "development" });
  });

  test("rejects an invalid JSON body with 400", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    const response = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid JSON body" });
  });

  test("rejects an oversized body with 413", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    const response = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ preview: "x".repeat(70 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "request body too large" });
  });

  test("rejects a malformed device token encoding with 400", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    const response = await fetch(`${gateway.base}/api/devices/%ZZ`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${CHANNEL}` },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid device token" });
  });

  test("deletes a registered device", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);

    await fetch(`${gateway.base}/api/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHANNEL}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "device-1" }),
    });
    const response = await fetch(`${gateway.base}/api/devices/device-1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${CHANNEL}` },
    });
    expect(response.status).toBe(200);
    expect(gateway.store.list(channelIdFromSecret(CHANNEL))).toEqual([]);
  });
});
