import { describe, expect, test } from "vitest";
import { buildApnsPayload, type NotifyPayload } from "../src/payload.js";

function aps(payload: NotifyPayload) {
  return buildApnsPayload(payload).aps as Record<string, unknown>;
}

describe("buildApnsPayload", () => {
  test("maps a finished notification with an agent title", () => {
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

  test("defaults the source when missing", () => {
    const payload = buildApnsPayload({ reason: "finished" });
    expect(payload.source).toBe("paseo-notify");
    expect((payload.aps as Record<string, unknown>)["thread-id"]).toBe("paseo-notify");
  });
});
