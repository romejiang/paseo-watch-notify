import { describe, expect, test } from "vitest";
import { postNotification } from "./notify";
import type { PaseoNotifyPayload } from "../shared/notification";

const payload: PaseoNotifyPayload = {
  source: "paseo-notify",
  type: "agent.finished",
  reason: "finished",
  agentId: "a1",
  agentTitle: "Fix bug",
  workspaceId: "w1",
  provider: "claude",
  cwd: "/tmp/repo",
  preview: "Done.",
  timestamp: "2026-10-16T12:00:00.000Z",
};

const noSleep = async () => {};

describe("postNotification", () => {
  test("POSTs JSON with an optional bearer token", async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const result = await postNotification("https://gw.example/hook", "secret", payload, {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => "" };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gw.example/hook/api/notify");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ source: "paseo-notify", agentId: "a1" });
  });

  test("omits the authorization header when no token is configured", async () => {
    const result = await postNotification("https://gw.example/hook", "  ", payload, {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
    });
    expect(result.ok).toBe(true);
  });

  test("POSTs to /api/notify when given a base URL", async () => {
    const urls: string[] = [];
    const result = await postNotification("https://notify.example.top", "", payload, {
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(urls[0]).toBe("https://notify.example.top/api/notify");
  });

  test("keeps a full /api/notify URL and trims a trailing slash", async () => {
    const urls: string[] = [];
    await postNotification("https://notify.example.top/api/notify/", "", payload, {
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    expect(urls[0]).toBe("https://notify.example.top/api/notify");
  });

  test("rejects an unconfigured gateway without calling fetch", async () => {
    let called = false;
    const result = await postNotification("", "", payload, {
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
    expect(called).toBe(false);
  });

  test("rejects a non-http gateway", async () => {
    const result = await postNotification("ftp://gw.example", "", payload, {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
    });
    expect(result.ok).toBe(false);
  });

  test("retries on a 500 response and then succeeds", async () => {
    let attempts = 0;
    const result = await postNotification("https://gw.example/hook", "", payload, {
      sleep: noSleep,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false, status: 500, text: async () => "server error" };
        }
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("does not retry a 400 response", async () => {
    let attempts = 0;
    const result = await postNotification("https://gw.example/hook", "", payload, {
      sleep: noSleep,
      fetchImpl: async () => {
        attempts += 1;
        return { ok: false, status: 400, text: async () => "bad request" };
      },
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(result.error).toContain("400");
  });

  test("retries network errors and reports the last error", async () => {
    let attempts = 0;
    const result = await postNotification("https://gw.example/hook", "", payload, {
      sleep: noSleep,
      retries: 1,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(2);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
