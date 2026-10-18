import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { DeliveryResult, PushSender, PushTarget } from "../src/apns.js";
import { DeviceStore } from "../src/devices.js";
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
  gatewayToken?: string;
  deviceToken?: string;
  result?: DeliveryResult | ((target: PushTarget) => DeliveryResult);
}) {
  const store = new DeviceStore(join(mkdtempSync(join(tmpdir(), "gw-srv-")), "devices.json"));
  const { sender, captured } = fakeSender(options?.result ?? { token: "x", ok: true, status: 200 });
  const server = createServer({
    store,
    sender,
    gatewayToken: options?.gatewayToken ?? "",
    deviceToken: options?.deviceToken ?? "",
    defaultEnvironment: "development",
    defaultTopic: "com.example.paseonotify",
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

describe("gateway server", () => {
  test("healthz reports device count", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    gateway.store.upsert({ token: "t1", environment: "development", topic: "a" });
    const response = await fetch(`${gateway.base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, devices: 1 });
  });

  test("registers a device and forwards a notification to it", async () => {
    const gateway = await startGateway({ gatewayToken: "secret", deviceToken: "secret" });
    open.push(gateway.close);

    const register = await fetch(`${gateway.base}/api/devices`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ token: "device-1", platform: "ios" }),
    });
    expect(register.status).toBe(201);
    expect((await register.json()) as { topic: string }).toMatchObject({ topic: "com.example.paseonotify" });

    const notify = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ source: "paseo-notify", reason: "finished", preview: "Done." }),
    });
    expect(notify.status).toBe(200);
    expect(await notify.json()).toMatchObject({ delivered: 1, failed: 0, devices: 1 });
    expect(gateway.captured).toHaveLength(1);
    expect(gateway.captured[0]?.target.token).toBe("device-1");
    expect(gateway.captured[0]?.payload).toMatchObject({ source: "paseo-notify" });
  });

  test("rejects notify without the bearer token", async () => {
    const gateway = await startGateway({ gatewayToken: "secret" });
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
    gateway.store.upsert({ token: "device-1", environment: "development", topic: "a" });

    const response = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "finished" }),
    });
    expect(await response.json()).toMatchObject({ delivered: 0, failed: 1 });
    expect(gateway.store.list()).toEqual([]);
  });

  test("accepts notify with no devices", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    const response = await fetch(`${gateway.base}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "finished" }),
    });
    expect(await response.json()).toEqual({ delivered: 0, failed: 0, devices: 0 });
  });

  test("deletes a registered device", async () => {
    const gateway = await startGateway();
    open.push(gateway.close);
    gateway.store.upsert({ token: "device-1", environment: "development", topic: "a" });
    const response = await fetch(`${gateway.base}/api/devices/device-1`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(gateway.store.list()).toEqual([]);
  });
});
