import type { ApnsEnvironment } from "./env.js";

export interface DeviceRecord {
  token: string;
  environment: ApnsEnvironment;
  /** APNs topic (Bundle ID) this token belongs to. */
  topic: string;
  platform?: string;
  createdAt: string;
}

/**
 * Channel-scoped device registry.
 *
 * Devices are keyed by `dev:<channelId>:<token>`, so a caller only ever sees and fans out to its own
 * devices. `channelId` is the hash of the caller's channel secret; the raw secret is never stored.
 */
export interface DeviceStore {
  list(channelId: string): Promise<DeviceRecord[]>;
  put(channelId: string, record: DeviceRecord): Promise<void>;
  remove(channelId: string, token: string): Promise<boolean>;
}

export function createKvDeviceStore(kv: KVNamespace): DeviceStore {
  const recordKey = (channelId: string, token: string): string => `dev:${channelId}:${token}`;
  const prefix = (channelId: string): string => `dev:${channelId}:`;

  return {
    async list(channelId) {
      const records: DeviceRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await kv.list({ prefix: prefix(channelId), cursor });
        const values = await Promise.all(
          page.keys.map((key) => kv.get<DeviceRecord>(key.name, "json")),
        );
        for (const value of values) {
          if (value) {
            records.push(value);
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return records;
    },

    async put(channelId, record) {
      await kv.put(recordKey(channelId, record.token), JSON.stringify(record));
    },

    async remove(channelId, token) {
      const key = recordKey(channelId, token);
      const existing = await kv.get(key);
      if (existing === null) {
        return false;
      }
      await kv.delete(key);
      return true;
    },
  };
}
