import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { channelIdFromSecret, DeviceStore } from "../src/devices.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "gw-devices-")), "devices.json");
}

const A = channelIdFromSecret("channel-a");
const B = channelIdFromSecret("channel-b");

describe("DeviceStore", () => {
  test("upserts and lists devices per channel", () => {
    const store = new DeviceStore(tempFile());
    store.upsert(A, { token: "t1", environment: "development", topic: "com.example.app" });
    store.upsert(A, { token: "t2", environment: "production", topic: "com.example.app" });

    expect(store.list(A).map((d) => d.token).sort()).toEqual(["t1", "t2"]);
    expect(store.get(A, "t1")?.environment).toBe("development");
    expect(store.totalCount()).toBe(2);
  });

  test("isolates devices between channels", () => {
    const store = new DeviceStore(tempFile());
    store.upsert(A, { token: "a-device", environment: "development", topic: "a" });
    expect(store.list(B)).toEqual([]);
    expect(store.get(B, "a-device")).toBeUndefined();
    expect(store.remove(B, "a-device")).toBe(false);
    expect(store.list(A)).toHaveLength(1);
  });

  test("upsert replaces an existing token in the same channel", () => {
    const store = new DeviceStore(tempFile());
    store.upsert(A, { token: "t1", environment: "development", topic: "a" });
    store.upsert(A, { token: "t1", environment: "production", topic: "b" });
    expect(store.list(A)).toHaveLength(1);
    expect(store.get(A, "t1")?.topic).toBe("b");
  });

  test("remove deletes and reports whether it existed", () => {
    const store = new DeviceStore(tempFile());
    store.upsert(A, { token: "t1", environment: "development", topic: "a" });
    expect(store.remove(A, "t1")).toBe(true);
    expect(store.remove(A, "t1")).toBe(false);
    expect(store.list(A)).toEqual([]);
  });

  test("persists to disk and reloads with channel scope intact", () => {
    const file = tempFile();
    const store = new DeviceStore(file);
    store.upsert(A, { token: "t1", environment: "production", topic: "a" });
    store.upsert(B, { token: "t2", environment: "production", topic: "a" });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
      devices: Array<{ token: string; channelId: string }>;
    };
    expect(onDisk.devices).toHaveLength(2);

    const reloaded = new DeviceStore(file);
    expect(reloaded.list(A).map((d) => d.token)).toEqual(["t1"]);
    expect(reloaded.list(B).map((d) => d.token)).toEqual(["t2"]);
    expect(reloaded.list(A)).toHaveLength(1);
  });
});
