import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DeviceStore } from "../src/devices.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "gw-devices-")), "devices.json");
}

describe("DeviceStore", () => {
  test("upserts and lists devices", () => {
    const store = new DeviceStore(tempFile());
    store.upsert({ token: "t1", environment: "development", topic: "com.example.app" });
    store.upsert({ token: "t2", environment: "production", topic: "com.example.app" });

    expect(store.list().map((d) => d.token).sort()).toEqual(["t1", "t2"]);
    expect(store.get("t1")?.environment).toBe("development");
  });

  test("upsert replaces an existing token", () => {
    const store = new DeviceStore(tempFile());
    store.upsert({ token: "t1", environment: "development", topic: "a" });
    store.upsert({ token: "t1", environment: "production", topic: "b" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("t1")?.topic).toBe("b");
  });

  test("remove deletes and reports whether it existed", () => {
    const store = new DeviceStore(tempFile());
    store.upsert({ token: "t1", environment: "development", topic: "a" });
    expect(store.remove("t1")).toBe(true);
    expect(store.remove("t1")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("persists to disk and reloads", () => {
    const file = tempFile();
    const store = new DeviceStore(file);
    store.upsert({ token: "t1", environment: "production", topic: "a" });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { devices: Array<{ token: string }> };
    expect(onDisk.devices).toHaveLength(1);

    const reloaded = new DeviceStore(file);
    expect(reloaded.list().map((d) => d.token)).toEqual(["t1"]);
  });
});
