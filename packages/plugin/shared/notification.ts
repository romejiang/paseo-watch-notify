/**
 * The one payload shape the plugin POSTs to the configured gateway.
 *
 * `source` lets a generic receiver (for example a future watchOS app) accept notifications from
 * several producers. Today the only producer is `paseo-notify`.
 */
export const NOTIFY_SOURCE = "paseo-notify" as const;

export type NotifySource = typeof NOTIFY_SOURCE;

/** Why the notification fired. */
export type NotifyReason = "finished" | "failed" | "permission";

/** Paseo lifecycle event this notification corresponds to. */
export type NotifyType = "agent.finished" | "agent.permission_requested";

export interface PaseoNotifyPayload {
  source: NotifySource;
  type: NotifyType;
  reason: NotifyReason;
  agentId: string;
  agentTitle: string | null;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  /** Plain-text summary of the last assistant message, or permission details. */
  preview: string | null;
  /** ISO-8601 timestamp for the moment the notification was produced. */
  timestamp: string;
}
