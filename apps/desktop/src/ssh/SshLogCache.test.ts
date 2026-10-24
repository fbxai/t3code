import { describe, expect, it } from "vite-plus/test";
import {
  CONNECTION_LOG_MAX_AGE_MS,
  CONNECTION_LOG_MAX_CHARS,
} from "@t3tools/shared/connectionLogs";
import { createSshLogCache } from "./SshLogCache.ts";

describe("SSH log cache", () => {
  it("isolates hosts and clears aliases of the same connection", () => {
    const cache = createSshLogCache();
    const entry = cache.get("alias", 100);
    cache.append(entry, "failed credential=private", 100);
    entry.remote = "server failed";
    cache.bind("resolved", entry);
    expect(cache.get("other", 100).local).toBe("");
    expect(cache.get("resolved", 100).local).toBe("failed credential=[redacted]\n");
    cache.clear("resolved", 101);
    expect(cache.get("alias", 101)).toMatchObject({ local: "", remote: "", revision: 1 });
  });

  it("expires old output and bounds both text and the number of targets", () => {
    const cache = createSshLogCache();
    const entry = cache.get("host", 100);
    cache.append(entry, `${"x".repeat(CONNECTION_LOG_MAX_CHARS)}latest`, 100);
    expect(entry.local).toHaveLength(CONNECTION_LOG_MAX_CHARS);
    expect(entry.local).toMatch(/latest\n$/);
    expect(cache.get("host", 100 + CONNECTION_LOG_MAX_AGE_MS).local).toBe("");
    cache.append(entry, "old host", 100 + CONNECTION_LOG_MAX_AGE_MS);
    for (let i = 0; i < 32; i++) cache.get(`host-${i}`, 100 + CONNECTION_LOG_MAX_AGE_MS);
    expect(cache.get("host", 100 + CONNECTION_LOG_MAX_AGE_MS).local).toBe("");
  });
});
