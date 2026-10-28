import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  piProbeDiagnostics,
  piProbeErrorMessage,
  sanitizePiProbeText,
} from "./probeDiagnostics.ts";
import { PiRpcError } from "./rpc.ts";

describe("Pi probe diagnostics", () => {
  it.effect(
    "reproduces literal arguments, working directory, and server PATH with shell quoting",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-probe-" });
        const cwd = `${root}/workspace's directory`;
        const command = `${root}/agent's executable`;
        yield* fs.makeDirectory(cwd);
        yield* fs.writeFileString(
          command,
          '#!/bin/sh\nprintf "%s\\n" "$PWD" "$PATH" "$HOME" "$@"\n',
        );
        yield* fs.chmod(command, 0o755);
        const args = ["--version", "literal 'quote' $HOME `echo unexpected` $(echo unexpected)"];
        const environment = { PATH: "/bin:/server-only/bin", HOME: `${root}/home` };
        const diagnostics = piProbeDiagnostics({
          phase: "version",
          command,
          args,
          environment,
          cwd,
          hostname: "pi-a6000",
          platform: "linux",
          timeoutMs: 4000,
        });
        const result = yield* spawnAndCollect(
          "sh",
          ChildProcess.make("sh", ["-c", diagnostics.reproduce]),
        );
        assert.equal(result.code, 0);
        assert.deepEqual(result.stdout.trimEnd().split("\n"), [
          cwd,
          environment.PATH,
          environment.HOME,
          ...args,
        ]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("redacts secret arguments, environment credentials, and prompt text before logging", () => {
    const environment = { PATH: "/bin", API_KEY: "environment-secret" };
    const diagnostics = piProbeDiagnostics({
      phase: "rpc-discovery",
      command: "omp",
      args: [
        "--mode",
        "rpc",
        "--no-session",
        "--no-prompt-templates",
        "--model",
        "provider/model",
        "--api-key",
        "argument-secret",
        "--vendor-token=equals-secret",
        "--system-prompt",
        "private prompt text",
      ],
      environment,
      cwd: "/project",
      hostname: "server",
      platform: "linux",
      timeoutMs: 15000,
    });
    const serialized = JSON.stringify(diagnostics);
    assert.notInclude(serialized, "argument-secret");
    assert.notInclude(serialized, "equals-secret");
    assert.notInclude(serialized, "environment-secret");
    assert.notInclude(serialized, "private prompt text");
    assert.include(serialized, "[REDACTED]");
    assert.include(diagnostics.args, "--model");
    assert.include(diagnostics.args, "provider/model");
    const message = sanitizePiProbeText(
      "failed environment-secret; token=other-secret\n" + "x".repeat(5000),
      environment,
    );
    assert.isAtMost(message.length, 4096);
    assert.notInclude(message, "environment-secret");
    assert.notInclude(message, "other-secret");
    assert.notInclude(
      sanitizePiProbeText("spawn failed argument-secret private prompt text", environment, [
        "--api-key",
        "argument-secret",
        "--system-prompt",
        "private prompt text",
      ]),
      "argument-secret",
    );
  });

  it("keeps the underlying spawn error when RPC wraps it", () => {
    const error = new PiRpcError({ operation: "spawn", cause: new Error("spawn omp ENOENT") });
    const message = piProbeErrorMessage(error, {});
    assert.include(message, "Pi RPC spawn failed");
    assert.include(message, "spawn omp ENOENT");
  });

  it("formats Windows reproduction for PowerShell using the server's profile", () => {
    const diagnostics = piProbeDiagnostics({
      phase: "version",
      command: "C:\\agent's bin\\omp.cmd",
      args: ["--version"],
      environment: { Path: "C:\\server bin", USERPROFILE: "C:\\Users\\operator" },
      cwd: "C:\\work space",
      hostname: "windows",
      platform: "win32",
      timeoutMs: 4000,
    });
    assert.include(diagnostics.reproduce, "$env:USERPROFILE = 'C:\\Users\\operator'");
    assert.include(diagnostics.reproduce, "& 'C:\\agent''s bin\\omp.cmd' '--version'");
  });
});
