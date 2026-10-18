import { readFileSync } from "node:fs";

export type ApnsEnvironment = "development" | "production";

export interface GatewayConfig {
  port: number;
  /** When true, log pushes instead of contacting APNs. No Apple credentials required. */
  dryRun: boolean;
  /** Bearer token the plugin must present on POST /api/notify. Empty disables auth (dev only). */
  gatewayToken: string;
  /** Optional separate bearer token for device registration. Falls back to gatewayToken. */
  deviceToken: string;
  /** Path where registered device tokens are persisted. */
  devicesFile: string;
  apns: {
    /** Contents of the .p8 signing key. Empty in dry-run mode. */
    keyPem: string;
    keyId: string;
    teamId: string;
    /** Default APNs topic (Bundle ID) when a device record does not carry its own. */
    topic: string;
    environment: ApnsEnvironment;
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function readKey(env: NodeJS.ProcessEnv): string {
  const inline = env.APNS_KEY_P8?.trim();
  if (inline) {
    return inline.replace(/\\n/g, "\n");
  }
  const path = requireEnv(env, "APNS_KEY_PATH");
  return readFileSync(path, "utf8");
}

function parseEnvironment(value: string | undefined): ApnsEnvironment {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production") {
    return "production";
  }
  if (normalized === "development" || normalized === "sandbox" || !normalized) {
    return "development";
  }
  throw new Error(`APNS_ENV must be "development" or "production", got ${value}`);
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const dryRun = isTruthy(env.DRY_RUN);
  return {
    port: Number.parseInt(env.PORT?.trim() || "8787", 10),
    dryRun,
    gatewayToken: env.PASEO_NOTIFY_GATEWAY_TOKEN?.trim() || "",
    deviceToken: env.PASEO_NOTIFY_DEVICE_TOKEN?.trim() || env.PASEO_NOTIFY_GATEWAY_TOKEN?.trim() || "",
    devicesFile: env.DEVICES_FILE?.trim() || "devices.json",
    apns: {
      keyPem: dryRun ? "" : readKey(env),
      keyId: env.APNS_KEY_ID?.trim() || "",
      teamId: env.APNS_TEAM_ID?.trim() || "",
      topic: env.APNS_TOPIC?.trim() || "com.example.paseonotify",
      environment: parseEnvironment(env.APNS_ENV),
    },
  };
}
