import { describe, expect, it } from "vite-plus/test";
import { CONNECTION_LOG_MAX_CHARS, redactConnectionLog } from "./connectionLogs.ts";

describe("connection log redaction", () => {
  it("keeps diagnostic context while removing pairing and bearer credentials", () => {
    const output = redactConnectionLog(
      [
        "\u001b[31mSSH devbox port 2222 failed\u001b[0m",
        "Authorization: Bearer bearer-secret",
        "http://localhost:3773/#token=pairing-secret&host=devbox",
        "https://example.com?bootstrapToken=bootstrap-secret&code=code-secret",
        '{"credential":"json-secret","port":2222}',
        String.raw`{"bearerToken":"escaped-secret","port":2222}`,
        "Pairing URL: https://example.com/private-link",
      ].join("\n"),
    );
    expect(output).toContain("SSH devbox port 2222 failed");
    expect(output).toContain("&host=devbox");
    expect(output).toContain('"port":2222');
    expect(output).not.toMatch(/secret|private-link/);
    expect(output).not.toContain("\u001b");
    expect(output).toContain("[redacted]");
  });

  it("retains the latest output within a fixed memory limit", () => {
    const output = redactConnectionLog(`${"x".repeat(CONNECTION_LOG_MAX_CHARS)}\nlatest failure`);
    expect(output).toHaveLength(CONNECTION_LOG_MAX_CHARS);
    expect(output).toMatch(/latest failure$/);
  });
});
