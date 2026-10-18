/** Local mirror of the plugin's payload contract. */
export interface NotifyPayload {
  source?: string;
  type?: string;
  reason?: string;
  agentId?: string;
  agentTitle?: string | null;
  workspaceId?: string | null;
  provider?: string;
  cwd?: string;
  preview?: string | null;
  timestamp?: string;
}

export interface ApnsPayloadOptions {
  /** Overrides the reason-derived sound. */
  sound?: string;
  /** Overrides the reason-derived interruption level. */
  interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
  /** Notification category, letting the receiver app attach actions. */
  category?: string;
}

const SOURCE_FALLBACK = "paseo-notify";

/** Attention-grabbing for a decision that needs the user; gentle for a completion. */
export const PERMISSION_SOUND = "paseo-permission.wav";
export const FINISHED_SOUND = "paseo-finished.wav";

function resolveAlertStyle(reason: string | undefined): {
  sound: string;
  interruptionLevel: "active" | "time-sensitive";
} {
  if (reason === "permission" || reason === "failed") {
    return { sound: PERMISSION_SOUND, interruptionLevel: "time-sensitive" };
  }
  return { sound: FINISHED_SOUND, interruptionLevel: "active" };
}

function resolveTitle(payload: NotifyPayload): string {
  const title = payload.agentTitle?.trim();
  if (payload.reason === "permission") {
    return title ? `${title} needs permission` : "Agent needs permission";
  }
  if (payload.reason === "failed") {
    return title ? `${title} failed` : "Agent failed";
  }
  return title ? `${title} finished` : "Agent finished";
}

function resolveBody(payload: NotifyPayload): string {
  const preview = payload.preview?.trim();
  if (preview) {
    return preview;
  }
  if (payload.reason === "permission") {
    return "Permission requested.";
  }
  if (payload.reason === "failed") {
    return "Encountered an error.";
  }
  return "Finished working.";
}

/**
 * Build an APNs alert payload. The plugin fields ride alongside `aps` so a receiver app can route
 * on `source` and render richer content.
 */
export function buildApnsPayload(
  payload: NotifyPayload,
  options: ApnsPayloadOptions = {},
): Record<string, unknown> {
  const source = payload.source?.trim() || SOURCE_FALLBACK;
  const style = resolveAlertStyle(payload.reason);
  return {
    aps: {
      alert: {
        title: resolveTitle(payload),
        body: resolveBody(payload),
      },
      sound: options.sound ?? style.sound,
      "interruption-level": options.interruptionLevel ?? style.interruptionLevel,
      "thread-id": source,
      "mutable-content": 1,
      ...(options.category ? { category: options.category } : {}),
    },
    source,
    type: payload.type ?? null,
    reason: payload.reason ?? null,
    agentId: payload.agentId ?? null,
    agentTitle: payload.agentTitle ?? null,
    workspaceId: payload.workspaceId ?? null,
    provider: payload.provider ?? null,
    cwd: payload.cwd ?? null,
    timestamp: payload.timestamp ?? null,
  };
}
