// @effect-diagnostics nodeBuiltinImport:off - Exercise the generated linker in a real shell.
// @effect-diagnostics globalDate:off - Fixed UTC dates make version generation deterministic.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { localDesktopVersion, resourceMonitorLinkerScript } from "./build-local-desktop.ts";
import { releasePackageFiles } from "./update-release-package-versions.ts";

const decodeObservedVersion = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ appVersion: Schema.String, versions: Schema.Array(Schema.String) }),
  ),
);

it("aligns the compiled preview version and restores manifests after a failed build", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-build-version-"));
  try {
    NodeFS.mkdirSync(NodePath.join(root, "scripts"));
    for (const file of ["build-local-desktop.ts", "update-release-package-versions.ts"]) {
      NodeFS.copyFileSync(new URL(file, import.meta.url), NodePath.join(root, "scripts", file));
    }
    NodeFS.symlinkSync(
      new URL("node_modules", import.meta.url).pathname,
      NodePath.join(root, "scripts/node_modules"),
    );
    NodeFS.copyFileSync(
      new URL("../package.json", import.meta.url),
      NodePath.join(root, "package.json"),
    );
    const original = '{"version":"0.1.3","private":true}\n';
    for (const file of releasePackageFiles) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), original);
    }
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    const commands = {
      mise: `console.log(${JSON.stringify(NodePath.join(bin, "zig"))});`,
      zig: 'console.log("0.15.2");',
      rustup: 'console.log("/unused/" + process.argv[3]);',
      docker: 'console.log("linux/aarch64");',
      vp: `
import * as fs from "node:fs";
fs.writeFileSync("observed.json", JSON.stringify({
  versions: ${JSON.stringify(releasePackageFiles)}.map(file => JSON.parse(fs.readFileSync(file)).version),
  appVersion: process.env.APP_VERSION,
}));
process.exit(42);
`,
    };
    for (const [command, script] of Object.entries(commands)) {
      NodeFS.writeFileSync(NodePath.join(bin, command), `#!/usr/bin/env node\n${script}`);
      NodeFS.chmodSync(NodePath.join(bin, command), 0o755);
    }
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["scripts/build-local-desktop.ts"],
      {
        cwd: root,
        env: { ...process.env, PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(NodeFS.existsSync(NodePath.join(root, "observed.json")), result.stderr).toBe(true);
    const observed = decodeObservedVersion(
      NodeFS.readFileSync(NodePath.join(root, "observed.json"), "utf8"),
    );
    expect(observed.appVersion).toMatch(/^0\.1\.3-preview\.\d{8}\.\d+$/);
    expect(observed.versions).toEqual(releasePackageFiles.map(() => observed.appVersion));
    for (const file of releasePackageFiles) {
      expect(NodeFS.readFileSync(NodePath.join(root, file), "utf8")).toBe(original);
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

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
