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
  devices: DeviceRecord[];
}

/**
 * Minimal file-backed device registry. APNs device tokens are opaque and rotate, so an iOS app
 * re-registers on every launch; upsert by token keeps the file small.
 */
export class DeviceStore {
  private devices = new Map<string, DeviceRecord>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      for (const record of parsed.devices ?? []) {
        if (record?.token) {
          this.devices.set(record.token, record);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  private persist(): void {
    const payload: StoreFile = { devices: [...this.devices.values()] };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(temp, this.filePath);
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()];
  }

  get(token: string): DeviceRecord | undefined {
    return this.devices.get(token);
  }

  upsert(record: Omit<DeviceRecord, "updatedAt"> & { updatedAt?: string }): DeviceRecord {
    const next: DeviceRecord = { ...record, updatedAt: record.updatedAt ?? new Date().toISOString() };
    this.devices.set(next.token, next);
    this.persist();
    return next;
  }

  remove(token: string): boolean {
    const removed = this.devices.delete(token);
    if (removed) {
      this.persist();
    }
    return removed;
  }
}
