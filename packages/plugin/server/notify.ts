import type { PaseoNotifyPayload } from "../shared/notification";

export interface PostResult {
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
  /** HTTP status when a response was received. */
  status?: number;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface PostNotificationOptions {
  fetchImpl?: FetchFn;
  /** Number of retries after the first attempt. Default 1. */
  retries?: number;
  /** Base delay between retries in ms. Default 500. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

function resolveFetch(override?: FetchFn): FetchFn {
  if (override) {
    return override;
  }
  const globalFetch = (globalThis as { fetch?: FetchFn }).fetch;
  if (!globalFetch) {
    throw new Error("global fetch is unavailable in this runtime");
  }
  return globalFetch.bind(globalThis);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const setTimer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown })
      .setTimeout;
    if (!setTimer) {
      resolve();
      return;
    }
    setTimer(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function resolveNotifyUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "gatewayUrl is not configured" };
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: `gatewayUrl must be http(s): ${trimmed}` };
  }
  // Accept the same base URL as the apps: append the plugin endpoint ourselves, and tolerate a
  // URL that already points at an endpoint.
  let url = trimmed.replace(/\/+$/, "");
  if (url.endsWith("/api/devices")) {
    url = url.slice(0, -"/api/devices".length);
  }
  if (!url.endsWith("/api/notify")) {
    url = `${url}/api/notify`;
  }
  try {
    void new URL(url);
  } catch {
    return { error: `gatewayUrl is not a valid URL: ${trimmed}` };
  }
  return { url };
}

/**
 * POST one payload to the gateway. Never throws: delivery failures are returned so the caller can
 * log them without bringing down the plugin subprocess.
 */
export async function postNotification(
  gatewayUrl: string,
  authToken: string,
  payload: PaseoNotifyPayload,
  options: PostNotificationOptions = {},
): Promise<PostResult> {
  const resolved = resolveNotifyUrl(gatewayUrl);
  if ("error" in resolved) {
    return { ok: false, error: resolved.error };
  }
  const endpoint = resolved.url;

  const fetchImpl = resolveFetch(options.fetchImpl);
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = authToken.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const body = JSON.stringify(payload);
  let lastError = "unknown error";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) {
      return { ok: false, error: "aborted" };
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body,
        signal: options.signal,
      });
      if (response.ok) {
        return { ok: true, status: response.status };
      }
      const detail = await response.text().catch(() => "");
      lastError = `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
      if (!isRetryableStatus(response.status)) {
        return { ok: false, error: lastError, status: response.status };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retries) {
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }

  return { ok: false, error: lastError };
}
