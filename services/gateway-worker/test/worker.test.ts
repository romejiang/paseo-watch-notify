import { describe, expect, test } from "vitest";
import type { ApnsSender, DeliveryResult, PushTarget } from "../src/apns.js";
import type { DeviceRecord, DeviceStore } from "../src/devices.js";
import { handle, type HandlerDeps } from "../src/index.js";

class FakeStore implements DeviceStore {
  private readonly channels = new Map<string, Map<string, DeviceRecord>>();

  private channel(id: string): Map<string, DeviceRecord> {
    let map = this.channels.get(id);
    if (!map) {
      map = new Map();
      this.channels.set(id, map);
    }
    return map;
  }

  async list(channelId: string): Promise<DeviceRecord[]> {
    return [...this.channel(channelId).values()];
  }

  async put(channelId: string, record: DeviceRecord): Promise<void> {
    this.channel(channelId).set(record.token, record);
  }

  async remove(channelId: string, token: string): Promise<boolean> {
    return this.channel(channelId).delete(token);
  }
}

function fakeSender(result?: DeliveryResult | ((target: PushTarget) => DeliveryResult)) {
  const calls: Array<{ target: PushTarget; payload: unknown }> = [];
  const sender: ApnsSender = {
    async send(target, payload) {
      calls.push({ target, payload });
      return typeof result === "function" ? result(target) : (result ?? { token: target.token, ok: true, status: 200 });
    },
  };
  return { sender, calls };
}

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    devices: new FakeStore(),
    sender: fakeSender().sender,
    dryRun: false,
    defaultTopic: "com.example.paseonotify",
    defaultEnvironment: "development",
    logger: () => {},
    ...overrides,
  };
}

const base = "https://gateway.example";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${base}${path}`, init);
}

function authed(secret: string): HeadersInit {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

describe("gateway worker", () => {
  test("healthz", async () => {
    const response = await handle(req("/healthz"), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects API calls without a bearer token", async () => {
    const response = await handle(req("/api/notify", { method: "POST" }), deps());
    expect(response.status).toBe(401);
  });

  test("registers a device and fans out a notification to it", async () => {
    const store = new FakeStore();
    const sender = fakeSender();
    const d = deps({ devices: store, sender: sender.sender });

    const registered = await handle(
      req("/api/devices", { method: "POST", headers: authed("channel-a"), body: JSON.stringify({ token: "dev-1", platform: "ios" }) }),
      d,
    );
    expect(registered.status).toBe(201);
    expect((await registered.json()) as DeviceRecord).toMatchObject({ token: "dev-1", topic: "com.example.paseonotify" });

    const notified = await handle(
      req("/api/notify", { method: "POST", headers: authed("channel-a"), body: JSON.stringify({ source: "paseo-notify", reason: "finished", preview: "Done." }) }),
      d,
    );
    expect(await notified.json()).toMatchObject({ delivered: 1, failed: 0, devices: 1 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.target.token).toBe("dev-1");
    expect(sender.calls[0]?.payload).toMatchObject({ source: "paseo-notify" });
  });

  test("isolates devices per channel secret", async () => {
    const store = new FakeStore();
    const sender = fakeSender();
    const d = deps({ devices: store, sender: sender.sender });

    await handle(
      req("/api/devices", { method: "POST", headers: authed("channel-a"), body: JSON.stringify({ token: "a-device" }) }),
      d,
    );

    const notified = await handle(
      req("/api/notify", { method: "POST", headers: authed("channel-b"), body: JSON.stringify({ reason: "finished" }) }),
      d,
    );
    expect(await notified.json()).toEqual({ delivered: 0, failed: 0, devices: 0 });
    expect(sender.calls).toHaveLength(0);
  });

  test("drops a device when APNs reports 410", async () => {
    const store = new FakeStore();
    const sender = fakeSender((target) => ({ token: target.token, ok: false, status: 410, reason: "Unregistered" }));
    const d = deps({ devices: store, sender: sender.sender });

    await handle(
      req("/api/devices", { method: "POST", headers: authed("c"), body: JSON.stringify({ token: "gone" }) }),
      d,
    );
    const notified = await handle(
      req("/api/notify", { method: "POST", headers: authed("c"), body: JSON.stringify({ reason: "finished" }) }),
      d,
    );
    expect(await notified.json()).toMatchObject({ delivered: 0, failed: 1 });
    expect(await store.list("c")).toEqual([]);
  });

  test("dry run logs instead of sending", async () => {
    const sender = fakeSender();
    const d = deps({ sender: sender.sender, dryRun: true });
    await handle(
      req("/api/devices", { method: "POST", headers: authed("c"), body: JSON.stringify({ token: "t" }) }),
      d,
    );
    const notified = await handle(
      req("/api/notify", { method: "POST", headers: authed("c"), body: JSON.stringify({ reason: "finished" }) }),
      d,
    );
    expect(await notified.json()).toMatchObject({ delivered: 1, devices: 1 });
    expect(sender.calls).toHaveLength(0);
  });

  test("rejects a registration without a token", async () => {
    const response = await handle(
      req("/api/devices", { method: "POST", headers: authed("c"), body: JSON.stringify({}) }),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  test("deletes a registered device", async () => {
    const store = new FakeStore();
    const d = deps({ devices: store });
    await handle(
      req("/api/devices", { method: "POST", headers: authed("c"), body: JSON.stringify({ token: "t" }) }),
      d,
    );
    const removed = await handle(req("/api/devices/t", { method: "DELETE", headers: authed("c") }), d);
    expect(removed.status).toBe(200);
    expect(await store.list("c")).toEqual([]);
  });
});
