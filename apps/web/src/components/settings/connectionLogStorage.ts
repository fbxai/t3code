import {
  DesktopSshEnvironmentLogsSchema,
  type DesktopSshEnvironmentLogs,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { CONNECTION_LOG_MAX_AGE_MS, redactConnectionLog } from "@t3tools/shared/connectionLogs";
import * as Schema from "effect/Schema";

const STORAGE_KEY = "t3code:connection-logs:v1";
const CachedLog = Schema.Struct({
  logs: DesktopSshEnvironmentLogsSchema,
  clientError: Schema.NullOr(Schema.String),
});
const decodeCache = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, CachedLog)),
);
type CachedLog = typeof CachedLog.Type;
type LogStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function sshLogCacheKey(target: DesktopSshEnvironmentTarget): string {
  return JSON.stringify([target.alias, target.hostname, target.username, target.port]);
}

function readCache(storage: LogStorage, now: number) {
  const raw = storage.getItem(STORAGE_KEY);
  const entries = raw === null ? {} : decodeCache(raw);
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([, value]) => now - value.logs.capturedAt < CONNECTION_LOG_MAX_AGE_MS,
    ),
  );
}

export function readConnectionLogCache(
  key: string,
  now = Date.now(),
  getStorage: () => LogStorage = () => window.sessionStorage,
): CachedLog | null {
  try {
    const storage = getStorage();
    const cache = readCache(storage, now);
    storage.setItem(STORAGE_KEY, JSON.stringify(cache));
    return cache[key] ?? null;
  } catch {
    return null;
  }
}

export function writeConnectionLogCache(
  key: string,
  logs: DesktopSshEnvironmentLogs,
  clientError: string | null,
  getStorage: () => LogStorage = () => window.sessionStorage,
): void {
  try {
    const storage = getStorage();
    let cache: Record<string, CachedLog>;
    try {
      cache = readCache(storage, logs.capturedAt);
    } catch {
      cache = {};
    }
    cache[key] = {
      logs: {
        ...logs,
        local: redactConnectionLog(logs.local),
        remote: redactConnectionLog(logs.remote),
        remoteError: logs.remoteError === null ? null : redactConnectionLog(logs.remoteError),
      },
      clientError: clientError === null ? null : redactConnectionLog(clientError),
    };
    const bounded = Object.fromEntries(
      Object.entries(cache)
        .sort(([, a], [, b]) => b.logs.capturedAt - a.logs.capturedAt)
        .slice(0, 10),
    );
    storage.setItem(STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    /* The live view and main-process cache also work when storage is unavailable. */
  }
}

export function clearConnectionLogCache(
  key: string,
  now = Date.now(),
  getStorage: () => LogStorage = () => window.sessionStorage,
): void {
  try {
    const storage = getStorage();
    const cache = readCache(storage, now);
    delete cache[key];
    storage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* Clearing an unavailable session cache is harmless. */
  }
}
