import { CONNECTION_LOG_MAX_AGE_MS, redactConnectionLog } from "@t3tools/shared/connectionLogs";

export function createSshLogCache() {
  const makeEntry = (now: number) => ({
    updatedAt: now,
    local: "",
    remote: "",
    remoteError: null as string | null,
    revision: 0,
  });
  const entries = new Map<string, ReturnType<typeof makeEntry>>();
  const put = (key: string, entry: ReturnType<typeof makeEntry>) => {
    entries.set(key, entry);
    while (entries.size > 32) entries.delete(entries.keys().next().value!);
  };
  const get = (key: string, now: number) => {
    let entry = entries.get(key);
    if (!entry) {
      entry = makeEntry(now);
      put(key, entry);
    }
    if (now - entry.updatedAt >= CONNECTION_LOG_MAX_AGE_MS) {
      Object.assign(entry, makeEntry(now), { revision: entry.revision + 1 });
    }
    return entry;
  };
  return {
    get,
    bind: (key: string, entry: ReturnType<typeof get>) => put(key, entry),
    append: (entry: ReturnType<typeof get>, text: string, now: number) => {
      entry.local = redactConnectionLog(`${entry.local}${text}\n`);
      entry.updatedAt = now;
    },
    clear: (key: string, now: number) => {
      const entry = get(key, now);
      Object.assign(entry, makeEntry(now), { revision: entry.revision + 1 });
    },
  };
}
