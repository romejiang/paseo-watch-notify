/**
 * Behavioural parity harness for the two gateway implementations.
 *
 * The Node gateway is started as a real HTTP server and the Cloudflare Worker handler is invoked
 * in-process with an in-memory store, then the exact same request sequence is replayed against both
 * and every status / header / body is compared. If this passes, a client can talk to either
 * deployment interchangeably.
 *
 * Run with: npm --prefix services/gateway run parity
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../gateway/src/devices.js";
import { createServer, listen } from "../gateway/src/server.js";
import type { DeliveryResult, PushSender, PushTarget } from "../gateway/src/apns.js";
import { handle, type HandlerDeps } from "../gateway-worker/src/index.js";

const DEFAULT_TOPIC = "com.example.paseonotify";
/** Both deployments use the same fallback, so an environment-less device behaves identically. */
const DEFAULT_ENVIRONMENT = "production";
const RATE_LIMIT = { enabled: true, perChannel: 6, perIp: 100_000, windowMs: 600_000 };

interface Step {
  label: string;
  method: string;
  path: string;
  secret?: string;
  body?: string;
}

interface Observed {
  status: number;
  contentType: string | null;
  retryAfter: string | null;
  body: unknown;
}

interface Surface {
  send(step: Step): Promise<Observed>;
  pushed(): string[];
  close(): Promise<void>;
}

/** Deterministic fake APNs: every token succeeds except ones prefixed with `stale`. */
function fakeSender(): { sender: PushSender; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sender: {
      async send(target: PushTarget): Promise<DeliveryResult> {
        calls.push(target.token);
        if (target.token.startsWith("stale")) {
          return { token: target.token, ok: false, status: 410, reason: "Unregistered" };
        }
        return { token: target.token, ok: true, status: 200 };
      },
    },
  };
}

async function startNodeSurface(): Promise<Surface> {
  const dir = mkdtempSync(join(tmpdir(), "parity-"));
  const store = new DeviceStore(join(dir, "devices.json"));
  const { sender, calls } = fakeSender();
  const server = createServer({
    store,
    sender,
    defaultTopic: DEFAULT_TOPIC,
    defaultEnvironment: DEFAULT_ENVIRONMENT,
    rateLimit: RATE_LIMIT,
    logger: () => {},
  });
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;

  return {
    async send(step) {
      const response = await fetch(`${base}${step.path}`, {
        method: step.method,
        headers: {
          ...(step.secret ? { authorization: `Bearer ${step.secret}` } : {}),
          ...(step.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: step.body,
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        retryAfter: response.headers.get("retry-after"),
        body: JSON.parse(await response.text()) as unknown,
      };
    },
    pushed: () => calls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startWorkerSurface(): Surface {
  const channels = new Map<string, Map<string, { token: string }>>();
  const { sender, calls } = fakeSender();
  const deps: HandlerDeps = {
    devices: {
      async list(channelId) {
        return [...(channels.get(channelId)?.values() ?? [])] as never;
      },
      async put(channelId, record) {
        let map = channels.get(channelId);
        if (!map) {
          map = new Map();
          channels.set(channelId, map);
        }
        map.set(record.token, record);
      },
      async remove(channelId, token) {
        return channels.get(channelId)?.delete(token) ?? false;
      },
    },
    sender: { send: (target, payload) => sender.send(target, payload) },
    dryRun: false,
    defaultTopic: DEFAULT_TOPIC,
    defaultEnvironment: DEFAULT_ENVIRONMENT,
    rateLimit: RATE_LIMIT,
    logger: () => {},
  };

  return {
    async send(step) {
      const request = new Request(`https://gateway.example${step.path}`, {
        method: step.method,
        headers: {
          ...(step.secret ? { authorization: `Bearer ${step.secret}` } : {}),
          ...(step.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: step.body,
      });
      const response = await handle(request, deps);
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        retryAfter: response.headers.get("retry-after"),
        body: JSON.parse(await response.text()) as unknown,
      };
    },
    pushed: () => calls,
    async close() {},
  };
}

/** Timestamps and token hashes legitimately differ between deployments. */
function normalize(observed: Observed): Observed {
  const body = observed.body as Record<string, unknown> | null;
  if (body && typeof body === "object" && typeof body.updatedAt === "string") {
    body.updatedAt = "<time>";
  }
  return observed;
}

function bigBody(): string {
  return JSON.stringify({ preview: "x".repeat(70 * 1024) });
}

function steps(): Step[] {
  const A = "channel-a";
  const B = "channel-b";
  const RL = "channel-rl";
  const steps: Step[] = [
    { label: "healthz", method: "GET", path: "/healthz" },
    { label: "no bearer", method: "POST", path: "/api/notify", body: "{}" },
    { label: "register without token", method: "POST", path: "/api/devices", secret: A, body: "{}" },
    { label: "register", method: "POST", path: "/api/devices", secret: A, body: JSON.stringify({ token: "dev-1" }) },
    {
      label: "register with topic + production",
      method: "POST",
      path: "/api/devices",
      secret: A,
      body: JSON.stringify({ token: "dev-2", environment: "production", topic: "com.custom.topic", platform: "watch" }),
    },
    {
      label: "sandbox is an alias for development",
      method: "POST",
      path: "/api/devices",
      secret: A,
      body: JSON.stringify({ token: "dev-3", environment: "sandbox" }),
    },
    {
      label: "unknown environment uses the deployment default",
      method: "POST",
      path: "/api/devices",
      secret: A,
      body: JSON.stringify({ token: "dev-4", environment: "staging" }),
    },
    { label: "notify fans out", method: "POST", path: "/api/notify", secret: A, body: JSON.stringify({ reason: "finished" }) },
    { label: "re-register updates in place", method: "POST", path: "/api/devices", secret: A, body: JSON.stringify({ token: "dev-1" }) },
    { label: "delete", method: "DELETE", path: "/api/devices/dev-1", secret: A },
    { label: "delete again", method: "DELETE", path: "/api/devices/dev-1", secret: A },
    { label: "malformed token", method: "DELETE", path: "/api/devices/%ZZ", secret: A },
    { label: "channel isolation", method: "POST", path: "/api/notify", secret: B, body: JSON.stringify({ reason: "finished" }) },
    { label: "register stale", method: "POST", path: "/api/devices", secret: B, body: JSON.stringify({ token: "stale-1" }) },
    { label: "stale token fails", method: "POST", path: "/api/notify", secret: B, body: JSON.stringify({ reason: "finished" }) },
    { label: "stale token is dropped", method: "POST", path: "/api/notify", secret: B, body: JSON.stringify({ reason: "finished" }) },
    { label: "invalid json", method: "POST", path: "/api/notify", secret: A, body: "{not json" },
    { label: "oversized body", method: "POST", path: "/api/notify", secret: A, body: bigBody() },
    { label: "unknown route", method: "GET", path: "/api/nope", secret: A },
  ];
  // perChannel is 6, so requests 7..8 through the same secret are rejected.
  const rl = (n: number): Step => ({ label: `rate limit #${n}`, method: "POST", path: "/api/notify", secret: RL, body: "{}" });
  for (let n = 1; n <= 8; n += 1) {
    steps.push(rl(n));
  }
  // A second channel keeps its own budget.
  steps.push({ label: "other channel unaffected", method: "POST", path: "/api/notify", secret: "channel-rl-2", body: "{}" });
  return steps;
}

async function main(): Promise<void> {
  const node = await startNodeSurface();
  const worker = startWorkerSurface();
  const failures: string[] = [];
  let checked = 0;

  try {
    for (const step of steps()) {
      checked += 1;
      let nodeResult: Observed;
      let workerResult: Observed;
      try {
        nodeResult = normalize(await node.send(step));
      } catch (error) {
        failures.push(`${step.label}: node threw ${(error as Error).message}`);
        continue;
      }
      workerResult = normalize(await worker.send(step));

      const a = JSON.stringify(nodeResult);
      const b = JSON.stringify(workerResult);
      if (a !== b) {
        failures.push(`${step.label}:\n    node   = ${a}\n    worker = ${b}`);
      }
    }

    const pushedByNode = node.pushed().join(",");
    const pushedByWorker = worker.pushed().join(",");
    checked += 1;
    if (pushedByNode !== pushedByWorker) {
      failures.push(`pushed tokens differ:\n    node   = ${pushedByNode}\n    worker = ${pushedByWorker}`);
    }
  } finally {
    await node.close();
    await worker.close();
  }

  if (failures.length > 0) {
    console.error(`\nPARITY FAILED (${failures.length}/${checked} checks)\n`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`PARITY OK — ${checked}/${checked} checks matched across both gateways`);
}

await main();
