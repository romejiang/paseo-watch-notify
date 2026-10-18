import { describe, expect, test } from "vitest";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { Notifier } from "./notifier";
import type { PaseoNotifyPayload } from "../shared/notification";
import { defaultNotifySettings, type NotifySettings } from "../shared/settings";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
type PermissionRequested = PluginLifecycleEvents["agent.permission_requested"];
type PermissionResolved = PluginLifecycleEvents["agent.permission_resolved"];

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    workspaceId: "w1",
    parentAgentId: null,
    provider: "claude",
    cwd: "/tmp/repo",
    title: "Fix the bug",
    ...overrides,
  } as unknown as TurnEnded["agent"];
}

function completedTurn(agent = makeAgent(), text = "All done."): TurnEnded {
  return {
    agent,
    turnId: "t1",
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text }],
  } as unknown as TurnEnded;
}

function failedTurn(agent = makeAgent()): TurnEnded {
  return {
    agent,
    turnId: "t1",
    outcome: { kind: "failed", error: { message: "boom" } },
    timeline: [],
  } as unknown as TurnEnded;
}

function canceledTurn(agent = makeAgent()): TurnEnded {
  return {
    agent,
    turnId: "t1",
    outcome: { kind: "canceled", reason: "user" },
    timeline: [],
  } as unknown as TurnEnded;
}

function startedTurn(agent = makeAgent()): TurnStarted {
  return { agent, turnId: "t2" } as unknown as TurnStarted;
}

function permissionRequested(agent = makeAgent(), id = "p1"): PermissionRequested {
  return {
    agent,
    request: {
      id,
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run git status",
      input: { command: "git status" },
    },
  } as unknown as PermissionRequested;
}

function permissionResolved(agent = makeAgent(), id = "p1"): PermissionResolved {
  return { agent, requestId: id, resolution: { behavior: "allow" } } as unknown as PermissionResolved;
}

function createHarness(overrides: Partial<NotifySettings> = {}) {
  let seq = 0;
  const timers = new Map<number, () => void>();
  const sent: PaseoNotifyPayload[] = [];
  let settings: NotifySettings = {
    ...defaultNotifySettings(),
    gatewayUrl: "https://gateway.example/paseo-notify",
    ...overrides,
  };

  const notifier = new Notifier({
    getSettings: () => settings,
    send: async (payload) => {
      sent.push(payload);
      return { ok: true };
    },
    schedule: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    log: () => {},
  });

  return {
    notifier,
    sent,
    updateSettings: (patch: Partial<NotifySettings>) => {
      settings = { ...settings, ...patch };
    },
    pending: () => timers.size,
    fireAll: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const fire of pending) fire();
    },
  };
}

describe("Notifier finished notifications", () => {
  test("a completed turn notifies only after the quiet window expires", () => {
    const h = createHarness({ quietWindowMs: 1000 });
    h.notifier.onTurnEnded(completedTurn(makeAgent(), "Shipped the fix."));

    expect(h.sent).toEqual([]);
    expect(h.pending()).toBe(1);

    h.fireAll();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      source: "paseo-notify",
      type: "agent.finished",
      reason: "finished",
      agentId: "a1",
      preview: "Shipped the fix.",
      timestamp: "2026-10-16T12:00:00.000Z",
    });
  });

  test("does not notify at all when gatewayUrl is empty", () => {
    const h = createHarness({ gatewayUrl: "" });
    h.notifier.onTurnEnded(completedTurn());
    h.fireAll();
    expect(h.sent).toEqual([]);
  });

  test("a new turn within the window cancels the pending finish", () => {
    const h = createHarness({ quietWindowMs: 1000 });
    h.notifier.onTurnEnded(completedTurn());
    expect(h.pending()).toBe(1);

    h.notifier.onTurnStarted(startedTurn());
    expect(h.pending()).toBe(0);
    h.fireAll();
    expect(h.sent).toEqual([]);
  });

  test("consecutive completed turns collapse into one notification with the latest preview", () => {
    const h = createHarness({ quietWindowMs: 1000 });
    h.notifier.onTurnEnded(completedTurn(makeAgent(), "First round."));
    h.notifier.onTurnEnded(completedTurn(makeAgent(), "Second round."));
    expect(h.pending()).toBe(1);

    h.fireAll();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.preview).toBe("Second round.");
  });

  test("canceled turns are ignored", () => {
    const h = createHarness();
    h.notifier.onTurnEnded(canceledTurn());
    expect(h.pending()).toBe(0);
    h.fireAll();
    expect(h.sent).toEqual([]);
  });

  test("failed turns notify when notifyOnFailure is enabled", () => {
    const h = createHarness({ notifyOnFailure: true });
    h.notifier.onTurnEnded(failedTurn());
    expect(h.pending()).toBe(1);
    h.fireAll();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ reason: "failed", type: "agent.finished", preview: null });
  });

  test("failed turns are skipped when notifyOnFailure is disabled", () => {
    const h = createHarness({ notifyOnFailure: false });
    h.notifier.onTurnEnded(failedTurn());
    expect(h.pending()).toBe(0);
    h.fireAll();
    expect(h.sent).toEqual([]);
  });

  test("subagents are ignored unless notifySubagents is enabled", () => {
    const subagent = makeAgent({ id: "sub", parentAgentId: "a1" });

    const h = createHarness();
    h.notifier.onTurnEnded(completedTurn(subagent));
    expect(h.pending()).toBe(0);

    const h2 = createHarness({ notifySubagents: true });
    h2.notifier.onTurnEnded(completedTurn(subagent));
    expect(h2.pending()).toBe(1);
    h2.fireAll();
    expect(h2.sent).toHaveLength(1);
    expect(h2.sent[0]?.agentId).toBe("sub");
  });

  test("debounce state is isolated per agent", () => {
    const h = createHarness();
    h.notifier.onTurnEnded(completedTurn(makeAgent({ id: "a1" }), "one"));
    h.notifier.onTurnEnded(completedTurn(makeAgent({ id: "a2" }), "two"));
    expect(h.pending()).toBe(2);

    h.fireAll();
    expect(h.sent.map((p) => p.agentId).sort()).toEqual(["a1", "a2"]);
  });
});

describe("Notifier permission notifications", () => {
  test("notifies immediately and dedupes by request id", () => {
    const h = createHarness();
    h.notifier.onPermissionRequested(permissionRequested(makeAgent(), "p1"));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: "agent.permission_requested",
      reason: "permission",
      agentId: "a1",
    });
    expect(h.sent[0]?.preview).toContain("Run git status");

    // Duplicate of the same request id must not notify again.
    h.notifier.onPermissionRequested(permissionRequested(makeAgent(), "p1"));
    expect(h.sent).toHaveLength(1);

    // A different request id notifies again.
    h.notifier.onPermissionRequested(permissionRequested(makeAgent(), "p2"));
    expect(h.sent).toHaveLength(2);
  });

  test("respects notifyOnPermission", () => {
    const h = createHarness({ notifyOnPermission: false });
    h.notifier.onPermissionRequested(permissionRequested());
    expect(h.sent).toEqual([]);
  });

  test("ignores subagent permission requests by default", () => {
    const h = createHarness();
    h.notifier.onPermissionRequested(permissionRequested(makeAgent({ parentAgentId: "a1" })));
    expect(h.sent).toEqual([]);
  });

  test("does not notify on resolution", () => {
    const h = createHarness();
    h.notifier.onPermissionRequested(permissionRequested(makeAgent(), "p1"));
    h.notifier.onPermissionResolved(permissionResolved(makeAgent(), "p1"));
    expect(h.sent).toHaveLength(1);
  });
});
