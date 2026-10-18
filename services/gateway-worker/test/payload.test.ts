import { describe, expect, test } from "vitest";
import { buildApnsPayload, type NotifyPayload } from "../src/payload.js";

function aps(payload: NotifyPayload) {
  return buildApnsPayload(payload).aps as Record<string, unknown>;
}

describe("buildApnsPayload", () => {
  test("a finished notification uses the gentle sound and active level", () => {
    const payload = buildApnsPayload({
      source: "paseo-notify",
      type: "agent.finished",
      reason: "finished",
      agentTitle: "Fix the bug",
      preview: "All done.",
    });
    expect(payload.aps).toMatchObject({
      alert: { title: "Fix the bug finished", body: "All done." },
      sound: "paseo-finished.wav",
      "interruption-level": "active",
      "thread-id": "paseo-notify",
      "mutable-content": 1,
    });
  });

  test("a permission request uses the attention sound and time-sensitive level", () => {
    const payload = buildApnsPayload({ reason: "permission", agentTitle: null, preview: null });
    expect(payload.aps).toMatchObject({
      sound: "paseo-permission.wav",
      "interruption-level": "time-sensitive",
    });
  });

  test("a failed turn is treated as attention-worthy", () => {
    expect(buildApnsPayload({ reason: "failed" })).toMatchObject({
      aps: { sound: "paseo-permission.wav", "interruption-level": "time-sensitive" },
    });
  });

  test("uses permission wording and a fallback body", () => {
    const alert = aps({ reason: "permission", agentTitle: null, preview: null }).alert as Record<
      string,
      string
    >;
    expect(alert.title).toBe("Agent needs permission");
    expect(alert.body).toBe("Permission requested.");
  });

  test("uses failed wording", () => {
    const alert = aps({ reason: "failed", agentTitle: "Build", preview: "" }).alert as Record<
      string,
      string
    >;
    expect(alert.title).toBe("Build failed");
    expect(alert.body).toBe("Encountered an error.");
  });

  test("options override the reason-derived style", () => {
    const payload = buildApnsPayload({ reason: "finished" }, { sound: "default", interruptionLevel: "passive" });
    expect(payload.aps).toMatchObject({ sound: "default", "interruption-level": "passive" });
  });

  test("defaults the source when missing", () => {
    const payload = buildApnsPayload({ reason: "finished" });
    expect(payload.source).toBe("paseo-notify");
    expect((payload.aps as Record<string, unknown>)["thread-id"]).toBe("paseo-notify");
  });
});
