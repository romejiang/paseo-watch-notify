import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApnsEnvironment } from "./config.js";

export interface DeviceRecord {
  token: string;
  environment: ApnsEnvironment;
  /** APNs topic (Bundle ID) the token belongs to. */
  topic: string;
  platform?: string;
  updatedAt: string;
}

interface StoreFile {
  devices: Array<DeviceRecord & { channelId: string }>;
}

/** Hash a caller's channel secret so the raw secret is never persisted. */
export function channelIdFromSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * File-backed device registry, scoped per channel.
 *
 * Every caller presents its own channel secret on each request; devices are stored under the hash
 * of that secret, so a caller only ever sees and fans out to its own devices. This is the same
 * model as the Cloudflare Worker gateway, so a channel secret works against either deployment.
 */
export class DeviceStore {
  private readonly channels = new Map<string, Map<string, DeviceRecord>>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      for (const record of parsed.devices ?? []) {
        if (!record?.token || !record.channelId) {
          continue;
        }
        const { channelId, ...device } = record;
        this.channel(channelId).set(device.token, device);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  private channel(channelId: string): Map<string, DeviceRecord> {
    let devices = this.channels.get(channelId);
    if (!devices) {
      devices = new Map();
      this.channels.set(channelId, devices);
    }
    return devices;
  }

  private persist(): void {
    const devices: StoreFile["devices"] = [];
    for (const [channelId, records] of this.channels) {
      for (const record of records.values()) {
        devices.push({ channelId, ...record });
      }
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify({ devices } satisfies StoreFile, null, 2), "utf8");
    renameSync(temp, this.filePath);
  }

  list(channelId: string): DeviceRecord[] {
    return [...(this.channels.get(channelId)?.values() ?? [])];
  }

  get(channelId: string, token: string): DeviceRecord | undefined {
    return this.channels.get(channelId)?.get(token);
  }

  /** Number of registered devices across every channel; used only by /healthz. */
  totalCount(): number {
    let total = 0;
    for (const records of this.channels.values()) {
      total += records.size;
    }
    return total;
  }

  upsert(
    channelId: string,
    record: Omit<DeviceRecord, "updatedAt"> & { updatedAt?: string },
  ): DeviceRecord {
    const next: DeviceRecord = {
      ...record,
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    };
    this.channel(channelId).set(next.token, next);
    this.persist();
    return next;
  }

  remove(channelId: string, token: string): boolean {
    const removed = this.channels.get(channelId)?.delete(token) ?? false;
    if (removed) {
      this.persist();
    }
    return removed;
  }
}
