import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped configuration for paseo-notify.
 *
 * NOTE: settings documents are ordinary plaintext JSON on the daemon host. They are not a
 * credential vault. `authToken` is stored in plaintext; prefer the environment variable
 * `PASEO_NOTIFY_AUTH_TOKEN` on the daemon when a secret is required.
 */
export const notifySettings = defineSettings({
  id: "notify",
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * Gateway base URL. Pre-filled with the public gateway and shared with the phone/watch apps,
     * which all use the same address. The plugin appends `/api/notify` itself.
     */
    gatewayUrl: z.string().trim().default("https://notify.romejiang.top"),
    /** Optional bearer token sent as `Authorization: Bearer <token>`. */
    authToken: z.string().default(""),
    /** Quiet window (ms) used to coalesce repeated turns into one "finished" notification. */
    quietWindowMs: z.number().int().min(0).max(600_000).default(15_000),
    /** Notify when a turn ends with `outcome.kind === "failed"`. */
    notifyOnFailure: z.boolean().default(true),
    /** Notify for subagents (`parentAgentId != null`). */
    notifySubagents: z.boolean().default(false),
    /** Notify immediately when a permission or question becomes pending. */
    notifyOnPermission: z.boolean().default(true),
  }),
});

export type NotifySettings = z.output<typeof notifySettings.schema>;

/** Defaults produced by parsing `{}` against the schema. */
export function defaultNotifySettings(): NotifySettings {
  return notifySettings.schema.parse({});
}
