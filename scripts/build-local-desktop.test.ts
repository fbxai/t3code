import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { localDesktopVersion, resourceMonitorLinkerScript } from "./build-local-desktop.ts";

it("preserves linker arguments while filtering the flag Zig rejects", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-linker-"));
  try {
    const linker = NodePath.join(root, "linker.sh");
    const zig = NodePath.join(root, "zig.sh");
    NodeFS.writeFileSync(linker, resourceMonitorLinkerScript("aarch64-linux-gnu.2.28"));
    NodeFS.writeFileSync(zig, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    NodeFS.chmodSync(zig, 0o700);
    const output = NodeChildProcess.execFileSync(
      "sh",
      [
        linker,
        "-Wl,--fix-cortex-a53-843419",
        "-Wl,--as-needed",
        "object with spaces.o",
        "literal'quote.o",
      ],
      { env: { ...process.env, T3_BUILD_ZIG: zig }, encoding: "utf8" },
    );
    expect(output.trim().split("\n")).toEqual([
      "cc",
      "-target",
      "aarch64-linux-gnu.2.28",
      "-Wl,--as-needed",
      "object with spaces.o",
      "literal'quote.o",
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("local desktop version", () => {
  it("uses the repository version and produces a distinct unpublished build ID", () => {
    expect(localDesktopVersion("0.0.45", new Date("2026-10-22T21:23:16Z"))).toBe(
      "0.0.45-preview.20261022.1792704196",
    );
    expect(localDesktopVersion("0.0.46-preview.20261021.1", new Date("2026-10-22T21:23:17Z"))).toBe(
      "0.0.46-preview.20261022.1792704197",
    );
  });
});
