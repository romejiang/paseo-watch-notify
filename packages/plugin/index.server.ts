import type { PluginServerContext } from "@getpaseo/plugin/server";
import { postNotification } from "./server/notify";
import { Notifier } from "./server/notifier";
import { NOTIFY_SOURCE, type PaseoNotifyPayload } from "./shared/notification";
import { defaultNotifySettings, notifySettings, type NotifySettings } from "./shared/settings";
import { sendTestNotification } from "./shared/test-rpc";

/** Prefer the daemon environment over the plaintext settings value when both are present. */
function resolveAuthToken(settings: NotifySettings): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const fromEnv = env?.PASEO_NOTIFY_AUTH_TOKEN?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : settings.authToken.trim();
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(notifySettings);

  let current: NotifySettings = defaultNotifySettings();
  const applyState = (state: { status: string; values?: NotifySettings }): void => {
    if (state.status === "ready" && state.values) {
      current = state.values;
      console.error(
        `[paseo-notify] settings ready (gateway ${current.gatewayUrl.trim() ? "configured" : "empty"})`,
      );
    }
  };

  void settings
    .read()
    .then(applyState)
    .catch((error: unknown) => {
      console.error("[paseo-notify] failed to read settings", error);
    });
  const unsubscribeSettings = settings.subscribe((state) => {
    applyState(state);
  });

  const notifier = new Notifier({
    getSettings: () => current,
    send: (payload, snapshot) =>
      postNotification(snapshot.gatewayUrl, resolveAuthToken(snapshot), payload),
    log: (message, meta) => {
      console.error(`[paseo-notify] ${message}`, meta ?? "");
    },
  });

  server.handle(sendTestNotification, async () => {
    const snapshot = current;
    if (!snapshot.gatewayUrl.trim()) {
      console.error("[paseo-notify] test skipped: gateway URL is not configured");
      return { ok: false, error: "Gateway URL is not configured." };
    }
    const payload: PaseoNotifyPayload = {
      source: NOTIFY_SOURCE,
      type: "agent.finished",
      reason: "finished",
      agentId: "test",
      agentTitle: "paseo-notify test",
      workspaceId: null,
      provider: "test",
      cwd: "",
      preview: "Test notification from paseo-notify. Your watch path is wired up.",
      timestamp: new Date().toISOString(),
    };
    const result = await postNotification(
      snapshot.gatewayUrl,
      resolveAuthToken(snapshot),
      payload,
    );
    console.error(
      `[paseo-notify] test notification ${result.ok ? "sent" : `failed: ${result.error ?? "unknown"}`}`,
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });

  const offTurnStarted = server.on("agent.turn_started", (event) => {
    notifier.onTurnStarted(event);
  });
  const offTurnEnded = server.on("agent.turn_ended", (event) => {
    notifier.onTurnEnded(event);
  });
  const offPermissionRequested = server.on("agent.permission_requested", (event) => {
    notifier.onPermissionRequested(event);
  });
  const offPermissionResolved = server.on("agent.permission_resolved", (event) => {
    notifier.onPermissionResolved(event);
  });

  return () => {
    offTurnStarted();
    offTurnEnded();
    offPermissionRequested();
    offPermissionResolved();
    unsubscribeSettings();
    notifier.dispose();
  };
}
