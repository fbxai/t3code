import { describe, expect, it } from "vite-plus/test";
import {
  CONNECTION_LOG_MAX_AGE_MS,
  CONNECTION_LOG_MAX_CHARS,
} from "@t3tools/shared/connectionLogs";
import {
  clearConnectionLogCache,
  readConnectionLogCache,
  writeConnectionLogCache,
} from "./connectionLogStorage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const snapshot = (capturedAt: number) => ({
  capturedAt,
  local: "ssh failed",
  remote: "daemon started",
  remoteError: null,
});

describe("connection log session storage", () => {
  it("restores diagnostics after closing the view, until expiry or clear", () => {
    const storage = memoryStorage();
    const getStorage = () => storage;
    writeConnectionLogCache("host", snapshot(100), "Client not supported", getStorage);
    expect(readConnectionLogCache("host", 101, getStorage)).toEqual({
      logs: snapshot(100),
      clientError: "Client not supported",
    });
    expect(readConnectionLogCache("host", 100 + CONNECTION_LOG_MAX_AGE_MS, getStorage)).toBeNull();
    writeConnectionLogCache("host", snapshot(200), null, getStorage);
    writeConnectionLogCache("other", snapshot(201), null, getStorage);
    clearConnectionLogCache("host", 202, getStorage);
    expect(readConnectionLogCache("host", 202, getStorage)).toBeNull();
    expect(readConnectionLogCache("other", 202, getStorage)?.logs).toEqual(snapshot(201));
  });

  it("redacts and bounds output before storage, retaining only ten recent hosts", () => {
    const storage = memoryStorage();
    const getStorage = () => storage;
    for (let i = 0; i < 11; i++) {
      writeConnectionLogCache(
        `host-${i}`,
        {
          ...snapshot(i),
          local: `${"x".repeat(CONNECTION_LOG_MAX_CHARS)} credential=private`,
          remote: '{"token":"private"}',
          remoteError: "Bearer private",
        },
        "https://example.com/#token=private",
        getStorage,
      );
    }
    expect(readConnectionLogCache("host-0", 12, getStorage)).toBeNull();
    const cached = readConnectionLogCache("host-10", 12, getStorage);
    expect(cached?.logs.local).toHaveLength(CONNECTION_LOG_MAX_CHARS);
    expect(JSON.stringify(cached)).not.toContain("private");
  });

  it("recovers from malformed storage and tolerates blocked storage", () => {
    const storage = memoryStorage();
    storage.setItem("t3code:connection-logs:v1", "malformed");
    expect(readConnectionLogCache("host", 100, () => storage)).toBeNull();
    writeConnectionLogCache("host", snapshot(100), null, () => storage);
    expect(readConnectionLogCache("host", 101, () => storage)?.logs).toEqual(snapshot(100));
    const blocked = () => {
      throw new Error("Storage disabled");
    };
    expect(() => writeConnectionLogCache("host", snapshot(100), null, blocked)).not.toThrow();
    expect(readConnectionLogCache("host", 101, blocked)).toBeNull();
    expect(() => clearConnectionLogCache("host", 101, blocked)).not.toThrow();
  });
});
