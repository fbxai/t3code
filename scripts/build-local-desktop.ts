// @effect-diagnostics globalDate:off - Build IDs use the current UTC timestamp outside the app runtime.
// @effect-diagnostics nodeBuiltinImport:off - Build orchestration runs outside the application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import serverPackage from "../apps/server/package.json" with { type: "json" };
import rootPackage from "../package.json" with { type: "json" };
import { releasePackageFiles } from "./update-release-package-versions.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const run = (command: string, args: string[], env = process.env) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd: root,
    env: {
      ...env,
      PATH: `${NodePath.dirname(process.execPath)}${NodePath.delimiter}${env.PATH ?? ""}`,
    },
    stdio: "inherit",
  });

export function localDesktopVersion(version: string, date: Date): string {
  return `${version.split("-")[0]}-preview.${date.toISOString().slice(0, 10).replaceAll("-", "")}.${Math.floor(date.getTime() / 1000)}`;
}

export function resourceMonitorLinkerScript(target: string): string {
  // shortcut: Zig lacks the Cortex-A53 linker mitigation; use native Linux builds for affected CPUs.
  // Match cargo-zigbuild's Zig compatibility filter: rust-cross/cargo-zigbuild#452.
  return `#!/bin/sh
original=$#
for argument do
  if [ "$argument" != "-Wl,--fix-cortex-a53-843419" ]; then set -- "$@" "$argument"; fi
done
shift "$original"
exec "$T3_BUILD_ZIG" cc -target ${target} "$@"
`;
}

if (import.meta.main) {
  // Every supported SSH host gets the checkout's executable and native dependencies.
  // Zig links Linux helpers from macOS without a Linux VM or a compiler on the host.
  const zig = NodeChildProcess.execFileSync("mise", ["which", "zig", "--tool", "zig@0.15.2"], {
    encoding: "utf8",
  }).trim();
  run(zig, ["version"]);
  // rustup installs targets for its compiler, which may differ from Homebrew's Rust on PATH.
  const cargo = NodeChildProcess.execFileSync("rustup", ["which", "cargo"], {
    encoding: "utf8",
  }).trim();
  const rustc = NodeChildProcess.execFileSync("rustup", ["which", "rustc"], {
    encoding: "utf8",
  }).trim();
  run("docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
  const version = localDesktopVersion(serverPackage.version, new Date());
  const manifests = releasePackageFiles.map((file) => {
    const path = NodePath.join(root, file);
    return [path, NodeFS.readFileSync(path)] as const;
  });
  const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-ssh-"));
  const archives = NodePath.join(stage, "archives");
  NodeFS.mkdirSync(archives);
  try {
    run("node", ["scripts/update-release-package-versions.ts", version]);
    run("vp", ["run", "build:desktop"], { ...process.env, APP_VERSION: version });
    for (const [platform, arch, target, zigTarget] of [
      ["mac", "arm64", "aarch64-apple-darwin", ""],
      ["linux", "x64", "x86_64-unknown-linux-gnu", "x86_64-linux-gnu.2.28"],
      ["linux", "arm64", "aarch64-unknown-linux-gnu", "aarch64-linux-gnu.2.28"],
    ] as const) {
      run("rustup", ["target", "add", target]);
      const linker = NodePath.join(stage, `linker-${arch}.sh`);
      NodeFS.writeFileSync(linker, resourceMonitorLinkerScript(zigTarget));
      NodeFS.chmodSync(linker, 0o700);
      run(
        cargo,
        [
          "build",
          "--locked",
          "--release",
          "--manifest-path",
          "native/resource-monitor/Cargo.toml",
          "--target",
          target,
        ],
        {
          ...process.env,
          RUSTC: rustc,
          T3_BUILD_ZIG: zig,
          ...(zigTarget
            ? { [`CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_LINKER`]: linker }
            : {}),
        },
      );
      if (platform === "linux" && arch === "arm64") {
        // Upstream's ARM64 SEA injection needs Linux Node to preserve 16/64 KiB page support.
        run("vp", ["run", "--filter", "t3", "build:bundle"], {
          ...process.env,
          T3CODE_PACK_EXE: "bundle",
          T3CODE_PACK_EXE_TARGET: "",
        });
        run("docker", [
          "run",
          "--rm",
          "--platform",
          "linux/arm64",
          "--mount",
          `type=bind,src=${root},dst=/work,readonly`,
          "--mount",
          `type=bind,src=${NodePath.join(root, "apps/server/dist-exe")},dst=/work/apps/server/dist-exe`,
          "--workdir",
          "/work/scripts",
          `node:${rootPackage.engines.node}-bookworm-slim`,
          "node",
          "--input-type=module",
          "--eval",
          `
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { injectLinuxArm64Sea, assertLinuxArm64PageCompatibility } from "./lib/linux-arm64-sea.ts";
const outputPath = "/work/apps/server/dist-exe/t3-linux-arm64";
await Effect.runPromise(injectLinuxArm64Sea({
  bundlePath: "/work/apps/server/dist-exe/bin.mjs",
  outputPath,
  nodeVersion: ${JSON.stringify(rootPackage.engines.node)},
  verbose: true,
}).pipe(Effect.provide(NodeServices.layer)));
assertLinuxArm64PageCompatibility(readFileSync(outputPath));
`,
        ]);
      } else {
        run("node", [
          "apps/server/scripts/cli.ts",
          "build-exe",
          "--target",
          `${platform === "mac" ? "darwin" : platform}-${arch}`,
        ]);
      }
      const monitor = NodePath.join(stage, `monitor-${target}`);
      NodeFS.mkdirSync(monitor);
      NodeFS.copyFileSync(
        NodePath.join(
          root,
          "native/resource-monitor/target",
          target,
          "release/t3-resource-monitor",
        ),
        NodePath.join(monitor, "t3-resource-monitor"),
      );
      const archiveArgs = [
        "scripts/build-cli-archive.ts",
        "--platform",
        platform,
        "--arch",
        arch,
        "--version",
        version,
        "--output-dir",
        platform === "linux" ? "/stage/archives" : archives,
        "--resource-monitor-dir",
        platform === "linux" ? `/stage/monitor-${target}` : monitor,
      ];
      if (platform === "linux") {
        // Upstream archives bundle libatomic and patch RUNPATH on an Ubuntu build host.
        const image = `t3code-local-archive:${rootPackage.engines.node}-${arch}`;
        const dockerPlatform = `linux/${arch === "x64" ? "amd64" : "arm64"}`;
        run("docker", [
          "build",
          "--platform",
          dockerPlatform,
          "--build-arg",
          `NODE_VERSION=${rootPackage.engines.node}`,
          "--build-arg",
          `PNPM_VERSION=${rootPackage.packageManager.split("@").at(-1)}`,
          "--tag",
          image,
          "--file",
          "scripts/docker/local-desktop-linux.Dockerfile",
          "scripts/docker",
        ]);
        run("docker", [
          "run",
          "--rm",
          "--platform",
          dockerPlatform,
          "--mount",
          `type=bind,src=${root},dst=/work,readonly`,
          "--mount",
          `type=bind,src=${stage},dst=/stage`,
          "--workdir",
          "/work",
          image,
          "node",
          ...archiveArgs,
        ]);
      } else {
        run("node", archiveArgs);
      }
    }
    const checksums = ["darwin-arm64", "linux-x64", "linux-arm64"].map((platform) => {
      const file = `t3-${version}-${platform}.tar.gz`;
      return `${NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.join(archives, file)))
        .digest("hex")}  ${file}`;
    });
    NodeFS.writeFileSync(NodePath.join(archives, "SHA256SUMS"), `${checksums.join("\n")}\n`);
    run("vp", ["run", "dist:desktop:dmg:arm64", "--skip-build", "--build-version", version], {
      ...process.env,
      T3CODE_DESKTOP_SSH_RUNTIMES: archives,
    });
  } finally {
    for (const [path, contents] of manifests) NodeFS.writeFileSync(path, contents);
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }
}
