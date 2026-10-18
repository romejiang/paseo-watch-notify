export type ApnsEnvironment = "development" | "production";

export interface Env {
  /** KV namespace holding registered device tokens, keyed per channel. */
  DEVICES: KVNamespace;
  /** APNs signing key (.p8) contents. Set with `wrangler secret put APNS_KEY_P8`. */
  APNS_KEY_P8?: string;
  /** APNs Key ID. Set with `wrangler secret put APNS_KEY_ID`. */
  APNS_KEY_ID?: string;
  /** Apple Team ID. Set with `wrangler secret put APNS_TEAM_ID`. */
  APNS_TEAM_ID?: string;
  /** Default APNs topic (the iOS app's Bundle ID shared by all users). */
  APNS_TOPIC: string;
  /** Default APNs environment for devices that do not specify one. */
  APNS_ENV?: ApnsEnvironment;
  /** "1" logs pushes instead of contacting APNs; lets you test without Apple credentials. */
  DRY_RUN?: string;
}

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
  environment: ApnsEnvironment;
}

export function resolveApnsConfig(env: Env): ApnsConfig {
  return {
    keyPem: (env.APNS_KEY_P8 ?? "").replace(/\\n/g, "\n"),
    keyId: env.APNS_KEY_ID ?? "",
    teamId: env.APNS_TEAM_ID ?? "",
    topic: env.APNS_TOPIC,
    environment: env.APNS_ENV === "production" ? "production" : "development",
  };
}

export function isDryRun(env: Env): boolean {
  const value = (env.DRY_RUN ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
