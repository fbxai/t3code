import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { checkPiProviderStatus, MINIMUM_PI_VERSION } from "./status.ts";

const encoder = new TextEncoder();
const decodeRpcRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

/** Fails the test if status runs `pi auth check` without `authCheck` or with other arguments. */
const piDiscoverySpawner = (
  inventory: unknown,
  options: {
    readonly version?: string;
    readonly state?: unknown;
    readonly authCheck?: string | undefined;
  } = {},
) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    let stdinBuffer = "";
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        stdinBuffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = stdinBuffer.indexOf("\n");
          if (newline === -1) return;
          const line = stdinBuffer.slice(0, newline);
          stdinBuffer = stdinBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          const request = decodeRpcRequest(line);
          const data =
            request.type === "get_available_models"
              ? inventory
              : request.type === "get_commands"
                ? { commands: [] }
                : request.type === "get_state"
                  ? (options.state ?? {})
                  : {};
          yield* Queue.offer(
            stdout,
            encoder.encode(
              `${encodeJsonLine({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
            ),
          );
        }
      }),
    );
    return ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      if (args.includes("--version")) {
        return Effect.succeed(processHandle({ stdout: `pi ${options.version ?? "0.84.3"}\n` }));
      }
      if (args[0] === "auth") {
        const expected = ["auth", "check", "--provider", "openai", "--json", "--no-refresh"];
        return options.authCheck === undefined || args.join(" ") !== expected.join(" ")
          ? Effect.die(`Unexpected pi ${args.join(" ")}`)
          : Effect.succeed(processHandle({ stdout: options.authCheck, exitCode: 1 }));
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          ...processHandle({}),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          stdin,
          stdout: Stream.fromQueue(stdout),
        }),
      );
    });
  });

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("records a version timeout with its reproduction command", () => {
    const records: string[] = [];
    const logger = Logger.make((options) =>
      records.push(JSON.stringify(Logger.formatStructured.log(options))),
    );
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const check = yield* Effect.forkChild(
        checkPiProviderStatus({ ...settings, binaryPath: "omp" }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("4 seconds");
      const snapshot = yield* Fiber.join(check);
      assert.equal(snapshot.status, "error");
      assert.include(snapshot.message ?? "", "omp --version");
      const log = records.join("\n");
      assert.include(log, "Pi provider probe timed out.");
      assert.include(log, '"timeoutMs":4000');
      assert.include(log, "reproduce");
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("logs enough server context to reproduce a missing custom executable", () => {
    const records: string[] = [];
    const logger = Logger.make((options) =>
      records.push(JSON.stringify(Logger.formatStructured.log(options))),
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "spawn omp ENOENT",
        }),
      ),
    );
    return Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        { ...settings, binaryPath: "omp" },
        {
          PATH: "/server-only/bin",
          HOME: "/home/operator",
          API_KEY: "never-log-this-secret",
        },
      );
      const log = records.join("\n");
      assert.include(log, "Pi provider probe failed.");
      assert.include(log, "spawn omp ENOENT");
      assert.include(log, '"phase":"version"');
      assert.include(log, '"cwd":"/server cwd"');
      assert.include(log, '"PATH":"/server-only/bin"');
      assert.include(log, '"timeoutMs":4000');
      assert.include(log, '"hostname":"pi-a6000"');
      assert.notInclude(log, "never-log-this-secret");
      assert.include(snapshot.message ?? "", "Reproduce on pi-a6000:");
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.WorkingDirectory, "/server cwd"),
      Effect.provideService(HostProcess.Hostname, "pi-a6000"),
    );
  });

  it.effect("logs version-command stderr and RPC reproduction without logging secrets", () => {
    const records: string[] = [];
    const logger = Logger.make((options) =>
      records.push(JSON.stringify(Logger.formatStructured.log(options))),
    );
    return Effect.gen(function* () {
      const environment = { PATH: "/server/bin", API_KEY: "bare-secret" };
      yield* checkPiProviderStatus(settings, environment).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              processHandle({
                stderr: "invalid config: bare-secret api_key=other-secret",
                exitCode: 2,
              }),
            ),
          ),
        ),
      );
      const failureLog = records.join("\n");
      assert.include(failureLog, '"exitCode":2');
      assert.include(failureLog, "invalid config");
      assert.notInclude(failureLog, "bare-secret");
      assert.notInclude(failureLog, "other-secret");
      records.length = 0;
      yield* checkPiProviderStatus(
        { ...settings, binaryPath: "omp" },
        environment,
        "/project",
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      const rpcLog = records.join("\n");
      assert.include(rpcLog, '"phase":"rpc-discovery"');
      assert.include(rpcLog, '"args":["--mode","rpc","--no-session"]');
      assert.include(rpcLog, '"cwd":"/project"');
      assert.include(rpcLog, "get_state");
      assert.include(rpcLog, "get_available_models");
      assert.include(rpcLog, "get_commands");
      assert.include(rpcLog, "Pi RPC discovery failed.");
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect.each(["pi", "/custom/Oh My Pi/omp"])(
    "reports the executable actually checked when %s is missing",
    (binaryPath) =>
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make((command) => {
          assert.isTrue(ChildProcess.isStandardCommand(command));
          if (ChildProcess.isStandardCommand(command)) {
            assert.equal(command.command, binaryPath);
            assert.deepEqual(command.args, ["--version"]);
          }
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          );
        });
        const snapshot = yield* checkPiProviderStatus({ ...settings, binaryPath }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        assert.equal(snapshot.installed, false);
        assert.equal(snapshot.status, "error");
        assert.include(snapshot.message ?? "", `Pi CLI (\`${binaryPath}\`)`);
        if (binaryPath === "pi") {
          assert.include(snapshot.message ?? "", "npm install");
        } else {
          assert.include(snapshot.message ?? "", "Binary path");
          assert.notInclude(snapshot.message ?? "", "npm install");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "distinguishes a custom executable's failed version command from a missing install",
    () =>
      Effect.gen(function* () {
        const binaryPath = "/custom/bin/omp";
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(processHandle({ stderr: "configuration error", exitCode: 2 })),
        );
        const snapshot = yield* checkPiProviderStatus({ ...settings, binaryPath }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.status, "error");
        assert.include(snapshot.message ?? "", `${binaryPath} --version`);
        assert.include(snapshot.message ?? "", "exited with code 2");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a known unauthenticated inventory when Pi returns no usable models", () =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner({ models: [] });
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      label: "a pinned model without credentials",
      version: "1.4.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: '{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}',
      message: "Pi default (openai/gpt-5) has no credentials configured for openai.",
    },
    {
      label: "a pinned model with a runtime --api-key",
      version: "1.4.0",
      launchArgs: "--provider openai --model gpt-5 --api-key fake-key",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: undefined,
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
    },
    {
      label: "a pinned model whose provider auth check cannot find",
      version: "1.4.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: '{"status":"not_ready","provider":"openai","reason":"provider_not_found"}',
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
    },
    {
      label: "a pinned model on Pi without auth check",
      version: MINIMUM_PI_VERSION,
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: undefined,
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
    },
    {
      label: "an uncatalogued model id of a provider with credentials",
      version: "1.4.0",
      activeModel: { provider: "anthropic", id: "claude-next" },
      authCheck: undefined,
      message: undefined,
    },
    {
      label: "an extension model Pi lists as available",
      version: "1.4.0",
      activeModel: { provider: "router", id: "auto" },
      authCheck: undefined,
      message: undefined,
    },
  ])("diagnoses Pi's active model readiness for $label", (row) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(
        {
          models: [
            { provider: "anthropic", id: "claude-sonnet-4" },
            { provider: "router", id: "auto" },
          ],
        },
        { version: row.version, state: { model: row.activeModel }, authCheck: row.authCheck },
      );
      const snapshot = yield* checkPiProviderStatus({
        ...settings,
        launchArgs: row.launchArgs ?? "",
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      if (row.message === undefined) assert.isUndefined(snapshot.message);
      else assert.include(snapshot.message ?? "", row.message);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // regression: #18498 a malformed model inventory must not restore stale Pi models
  it.effect.each([
    ["missing models", {}],
    ["missing model id", { models: [{ provider: "anthropic" }] }],
    [
      "mixed valid and invalid models",
      { models: [{ provider: "anthropic", id: "claude-sonnet-4" }, { provider: "openrouter" }] },
    ],
  ] as const)("reports unknown authentication when Pi discovery returns %s", (_label, inventory) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(inventory);
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
