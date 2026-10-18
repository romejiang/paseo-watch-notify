import { describe, expect, test } from "vitest";
import { DryRunSender } from "../src/apns.js";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  test("dry run does not require APNs credentials", () => {
    const config = loadConfig({ DRY_RUN: "1", PORT: "9999" } as NodeJS.ProcessEnv);
    expect(config.dryRun).toBe(true);
    expect(config.port).toBe(9999);
    expect(config.apns.keyPem).toBe("");
  });

  test("requires APNs credentials when not in dry run", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/APNS_KEY_PATH/);
  });
});

describe("DryRunSender", () => {
  test("reports success and logs the payload", async () => {
    const logged: unknown[] = [];
    const sender = new DryRunSender((message, meta) => logged.push({ message, meta }));
    const result = await sender.send(
      { token: "abcdef123456", environment: "development", topic: "com.example.app" },
      { aps: { alert: { title: "hi" } } },
    );
    expect(result.ok).toBe(true);
    expect(logged).toHaveLength(1);
  });
});
