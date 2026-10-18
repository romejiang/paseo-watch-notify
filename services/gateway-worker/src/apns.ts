import type { ApnsEnvironment } from "./env.js";
import { signProviderToken } from "./jwt.js";

export interface PushTarget {
  token: string;
  environment: ApnsEnvironment;
  topic: string;
}

export interface DeliveryResult {
  token: string;
  ok: boolean;
  status?: number;
  reason?: string;
  error?: string;
}

export interface ApnsSender {
  send(target: PushTarget, payload: unknown): Promise<DeliveryResult>;
}

export interface ApnsSenderConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (seconds since epoch) for tests. */
  now?: () => number;
}

const HOST: Record<ApnsEnvironment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** APNs provider tokens may be reused for up to an hour. */
const TOKEN_TTL_SECONDS = 2400;

/**
 * APNs sender backed by the Worker runtime's `fetch`, which negotiates HTTP/2 with Apple's servers
 * on the Cloudflare edge.
 */
export function createApnsSender(config: ApnsSenderConfig): ApnsSender {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  let cached: { value: string; issuedAt: number } | null = null;

  async function token(seconds: number): Promise<string> {
    if (!cached || seconds - cached.issuedAt > TOKEN_TTL_SECONDS) {
      cached = {
        value: await signProviderToken({
          keyPem: config.keyPem,
          keyId: config.keyId,
          teamId: config.teamId,
          issuedAtSeconds: seconds,
        }),
        issuedAt: seconds,
      };
    }
    return cached.value;
  }

  return {
    async send(target, payload) {
      try {
        const authorization = `bearer ${await token(now())}`;
        const response = await fetchImpl(`${HOST[target.environment]}/3/device/${target.token}`, {
          method: "POST",
          headers: {
            authorization,
            "apns-topic": target.topic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          return { token: target.token, ok: true, status: response.status };
        }

        let reason: string | undefined;
        try {
          reason = ((await response.json()) as { reason?: string }).reason;
        } catch {
          reason = await response.text().catch(() => undefined);
        }
        return { token: target.token, ok: false, status: response.status, reason };
      } catch (error) {
        return {
          token: target.token,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
