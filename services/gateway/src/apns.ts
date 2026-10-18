import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { ApnsEnvironment } from "./config.js";
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

export interface PushSender {
  send(target: PushTarget, payload: unknown): Promise<DeliveryResult>;
}

/**
 * Logs instead of contacting APNs. Lets the plugin -> gateway path be verified end to end without
 * any Apple credentials.
 */
export class DryRunSender implements PushSender {
  constructor(private readonly log: (message: string, meta?: unknown) => void = () => {}) {}

  async send(target: PushTarget, payload: unknown): Promise<DeliveryResult> {
    this.log(
      "DRY RUN would push:",
      JSON.stringify({ token: target.token.slice(0, 8), topic: target.topic, payload }, null, 2),
    );
    return { token: target.token, ok: true, status: 200 };
  }
}

export interface ApnsSenderOptions {
  keyPem: string;
  keyId: string;
  teamId: string;
  /** Seconds since epoch; injectable for tests. */
  now?: () => number;
  /** Session factory; injectable for tests. */
  connectImpl?: (origin: string) => ClientHttp2Session;
}

const HOST: Record<ApnsEnvironment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** APNs provider tokens may be reused for up to an hour; refresh well before the limit. */
const TOKEN_TTL_SECONDS = 2400;

export class ApnsSender implements PushSender {
  private readonly now: () => number;
  private readonly connectImpl: (origin: string) => ClientHttp2Session;
  private cachedToken: { value: string; issuedAt: number } | null = null;

  constructor(private readonly options: ApnsSenderOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.connectImpl = options.connectImpl ?? ((origin) => connect(origin));
  }

  private token(seconds: number): string {
    if (!this.cachedToken || seconds - this.cachedToken.issuedAt > TOKEN_TTL_SECONDS) {
      this.cachedToken = {
        value: signProviderToken({
          keyPem: this.options.keyPem,
          keyId: this.options.keyId,
          teamId: this.options.teamId,
          issuedAtSeconds: seconds,
        }),
        issuedAt: seconds,
      };
    }
    return this.cachedToken.value;
  }

  async send(target: PushTarget, payload: unknown): Promise<DeliveryResult> {
    const origin = HOST[target.environment];
    const authorization = `bearer ${this.token(this.now())}`;
    const body = JSON.stringify(payload);

    return new Promise<DeliveryResult>((resolve) => {
      const session = this.connectImpl(origin);
      let settled = false;
      const finish = (result: DeliveryResult) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          session.close();
        } catch {
          // ignore close failures
        }
        resolve(result);
      };

      session.on("error", (error) => {
        finish({ token: target.token, ok: false, error: error.message });
      });

      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${target.token}`,
        [constants.HTTP2_HEADER_AUTHORITY]: new URL(origin).host,
        authorization,
        "apns-topic": target.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      });

      let status = 0;
      let responseBody = "";
      request.on("response", (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      request.on("error", (error) => {
        finish({ token: target.token, ok: false, error: error.message });
      });
      request.on("end", () => {
        if (status === 200) {
          finish({ token: target.token, ok: true, status });
          return;
        }
        let reason: string | undefined;
        try {
          reason = (JSON.parse(responseBody) as { reason?: string }).reason;
        } catch {
          reason = responseBody || undefined;
        }
        finish({ token: target.token, ok: false, status, reason });
      });

      request.end(body);
    });
  }
}
