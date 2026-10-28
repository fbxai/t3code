import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { formatProviderOutput } from "./providerOutput";

describe("provider output", () => {
  it("keeps the current diagnostic and orders structured and ordinary logs chronologically", () => {
    const log = { spanName: "probe", level: "WARN", traceId: "trace", spanId: "span" };
    const text = formatProviderOutput({
      headline: "Not found",
      detail: "Executable could not start",
      logs: [
        { ...log, seenAt: DateTime.makeUnsafe("2026-10-26T15:01:00Z"), message: "plain stderr" },
        {
          ...log,
          seenAt: DateTime.makeUnsafe("2026-10-26T15:00:00Z"),
          message: JSON.stringify(["probe failed", { reproduce: "omp --version" }]),
        },
      ],
    });
    expect(text).toContain("Not found\n\nExecutable could not start");
    expect(text.indexOf("probe failed")).toBeLessThan(text.indexOf("plain stderr"));
    expect(text).toContain('"reproduce": "omp --version"');
  });

  it("bounds the displayed and copied output while retaining recent failures", () => {
    const text = formatProviderOutput({
      headline: "Unavailable",
      detail: "old output\n".repeat(10_000) + "latest failure",
      logs: [],
    });
    expect(text).toMatch(/^\[Earlier output truncated\]/);
    expect(text).toMatch(/latest failure$/);
    expect(text.length).toBeLessThan(66_000);
  });
});
