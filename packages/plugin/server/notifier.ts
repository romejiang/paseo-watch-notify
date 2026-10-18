import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  NOTIFY_SOURCE,
  type NotifyReason,
  type PaseoNotifyPayload,
} from "../shared/notification";
import type { NotifySettings } from "../shared/settings";
import { QuietDebouncer, type TimerHandle } from "./debouncer";
import { buildFinishedPreview, buildPermissionPreview } from "./summary";
import type { PostResult } from "./notify";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
type TurnStartedEvent = PluginLifecycleEvents["agent.turn_started"];
type PermissionRequestedEvent = PluginLifecycleEvents["agent.permission_requested"];
type PermissionResolvedEvent = PluginLifecycleEvents["agent.permission_resolved"];

interface PendingFinish {
  agent: PluginHookAgent;
  reason: NotifyReason;
  preview: string | null;
}

export interface NotifierDeps {
  getSettings: () => NotifySettings;
  send: (payload: PaseoNotifyPayload, settings: NotifySettings) => Promise<PostResult>;
  /** Injectable for deterministic tests. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, delayMs: number) => TimerHandle;
  /** Injectable for deterministic tests. Defaults to `clearTimeout`. */
  cancel?: (handle: TimerHandle) => void;
  now?: () => Date;
  log?: (message: string, meta?: unknown) => void;
}

const defaultSchedule = (fn: () => void, delayMs: number): TimerHandle => setTimeout(fn, delayMs);
const defaultCancel = (handle: TimerHandle): void => {
  if (handle !== null && handle !== undefined) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

/**
 * Turns Paseo lifecycle events into gateway POSTs.
 *
 * `agent.turn_ended` fires on every turn (every user message produces one), so it does NOT mean the
 * task is finished. Paseo's own "finished" semantics live in the daemon: an agent transitions
 * `running -> idle` (agent-manager `checkAndSetAttention`). We reconstruct that here with a per-agent
 * quiet window: a completed/failed turn arms a timer; a follow-up turn cancels it; only a window
 * that expires with no further activity is treated as a real finish.
 */
export class Notifier {
  private readonly pending = new Map<string, PendingFinish>();
  private readonly announcedPermissions = new Set<string>();
  private readonly quiet: QuietDebouncer<string>;
  private readonly now: () => Date;
  private readonly log: (message: string, meta?: unknown) => void;

  constructor(private readonly deps: NotifierDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.quiet = new QuietDebouncer<string>({
      windowMs: () => this.deps.getSettings().quietWindowMs,
      schedule: deps.schedule ?? defaultSchedule,
      cancel: deps.cancel ?? defaultCancel,
      onQuiet: (agentId) => this.flushQuiet(agentId),
    });
  }

  onTurnStarted(event: TurnStartedEvent): void {
    const { id } = event.agent;
    if (this.pending.delete(id)) {
      this.log("turn resumed before quiet window expired; canceled pending notification", id);
    }
    this.quiet.cancel(id);
  }

  onTurnEnded(event: TurnEndedEvent): void {
    const settings = this.deps.getSettings();
    const agent = event.agent;

    if (agent.parentAgentId !== null && !settings.notifySubagents) {
      return;
    }

    if (event.outcome.kind === "canceled") {
      return;
    }

    if (event.outcome.kind === "failed" && !settings.notifyOnFailure) {
      return;
    }

    const reason: NotifyReason = event.outcome.kind === "failed" ? "failed" : "finished";
    this.pending.set(agent.id, {
      agent,
      reason,
      preview: reason === "finished" ? buildFinishedPreview(event.timeline) : null,
    });
    this.quiet.arm(agent.id);
  }

  onPermissionRequested(event: PermissionRequestedEvent): void {
    const settings = this.deps.getSettings();
    if (!settings.notifyOnPermission) {
      return;
    }
    if (event.agent.parentAgentId !== null && !settings.notifySubagents) {
      return;
    }

    const requestId = event.request.id;
    if (this.announcedPermissions.has(requestId)) {
      return;
    }
    this.announcedPermissions.add(requestId);

    const payload = this.buildPayload({
      type: "agent.permission_requested",
      reason: "permission",
      agent: event.agent,
      preview: buildPermissionPreview(event.request),
    });
    void this.dispatch(payload, settings, `permission ${requestId}`);
  }

  onPermissionResolved(event: PermissionResolvedEvent): void {
    // Free the dedupe slot; we intentionally do NOT notify on resolution.
    this.announcedPermissions.delete(event.requestId);
  }

  dispose(): void {
    this.quiet.dispose();
    this.pending.clear();
    this.announcedPermissions.clear();
  }

  private flushQuiet(agentId: string): void {
    const pending = this.pending.get(agentId);
    if (!pending) {
      return;
    }
    this.pending.delete(agentId);

    const settings = this.deps.getSettings();
    const payload = this.buildPayload({
      type: "agent.finished",
      reason: pending.reason,
      agent: pending.agent,
      preview: pending.preview,
    });
    void this.dispatch(payload, settings, `finish ${agentId} (${pending.reason})`);
  }

  private buildPayload(input: {
    type: PaseoNotifyPayload["type"];
    reason: NotifyReason;
    agent: PluginHookAgent;
    preview: string | null;
  }): PaseoNotifyPayload {
    return {
      source: NOTIFY_SOURCE,
      type: input.type,
      reason: input.reason,
      agentId: input.agent.id,
      agentTitle: input.agent.title,
      workspaceId: input.agent.workspaceId,
      provider: input.agent.provider,
      cwd: input.agent.cwd,
      preview: input.preview,
      timestamp: this.now().toISOString(),
    };
  }

  private async dispatch(
    payload: PaseoNotifyPayload,
    settings: NotifySettings,
    context: string,
  ): Promise<void> {
    if (!settings.gatewayUrl.trim()) {
      this.log(`gateway URL not configured; skipping notification for ${context}`);
      return;
    }
    try {
      const result = await this.deps.send(payload, settings);
      if (result.ok) {
        this.log(`sent notification for ${context}`);
      } else {
        this.log(`notification failed for ${context}`, result.error);
      }
    } catch (error) {
      this.log(
        `notification threw for ${context}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
