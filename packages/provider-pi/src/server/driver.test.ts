import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { PiSettings } from "../settings.ts";
import { PiDriver } from "./driver.ts";

const layerTest = Layer.mergeAll(
  TestProviderHost.layer({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected HTTP")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();
const personalSkill = {
  name: "skill:personal",
  source: "skill",
  sourceInfo: { scope: "user", path: "/home/.pi/agent/skills/personal/SKILL.md" },
};

const makePiSpawner = Effect.fnUntraced(function* (
  discovery: { readonly state?: unknown; readonly models?: ReadonlyArray<unknown> } = {},
) {
  const pendingCommand = yield* Deferred.make<void>();
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const authCheck = command.args[0] === "auth" && command.args[1] === "check";
      const oneShot = version || authCheck;
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const cwd = command.options.cwd;
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so transport cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: oneShot ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!oneShot),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          if (cwd === "/pending" && request.type === "get_commands") {
            return Deferred.succeed(pendingCommand, undefined).pipe(Effect.asVoid);
          }
          const failed = cwd === "/failed" && request.type === "get_commands";
          const data =
            request.type === "get_commands"
              ? {
                  commands: [
                    personalSkill,
                    ...(cwd === "/machine"
                      ? []
                      : [
                          {
                            name: `skill:${cwd?.slice(1)}`,
                            source: "skill",
                            sourceInfo: {
                              scope: "project",
                              path: `${cwd}/.agents/skills/SKILL.md`,
                            },
                          },
                          { name: `prompt-${cwd?.slice(1)}`, source: "prompt" },
                        ]),
                  ],
                }
              : request.type === "get_available_models"
                ? { models: discovery.models ?? [{ provider: "test", id: "model" }] }
                : request.type === "get_state"
                  ? (discovery.state ?? {})
                  : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, success: !failed, data, ...(failed ? { error: "commands unavailable" } : {}) })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: version
          ? Stream.succeed(encoder.encode("pi 1.0.2\n"))
          : authCheck
            ? Stream.succeed(encoder.encode('{"reason":"credentials_not_configured"}\n'))
            : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches, pendingCommand };
});

const create = (config: Partial<PiSettings> = {}, enabled = true, displayName = "My Pi") =>
  PiDriver.create({
    instanceId: ProviderInstanceId.make("pi-workspace-test"),
    displayName,
    accentColor: "#abcdef",
    environment: [{ name: "PI_CODING_AGENT_DIR", value: "/isolated-pi", sensitive: false }],
    enabled,
    config: { ...PiDriver.defaultConfig(), binaryPath: "custom-pi", ...config },
  });

it.layer(layerTest)("PiDriver workspace discovery", (it) => {
  it.effect.each([
    { customModels: [], expectedName: "OMP default" },
    {
      customModels: [{ slug: "default", name: "My preferred model" }],
      expectedName: "My preferred model",
    },
  ])(
    "uses the instance label for the default entry, preserving model name overrides: $expectedName",
    ({ customModels, expectedName }) =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner();
        const instance = yield* create({ customModels }, true, "OMP").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        assert.equal((yield* instance.snapshot.getSnapshot).models[0]?.name, expectedName);
        yield* instance.snapshot.refresh;
        assert.equal((yield* instance.snapshot.getSnapshot).models[0]?.name, expectedName);
        assert.equal((yield* instance.snapshotForCwd!("/first")).models[0]?.name, expectedName);
      }).pipe(Effect.scoped),
  );

  it.effect("expands a custom executable's home path for both health and RPC checks", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner();
      const instance = yield* create({ binaryPath: "~/.local/bin/omp" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
      );
      yield* instance.snapshot.refresh;
      assert.isTrue(launches.some((launch) => launch.args.includes("--version")));
      assert.isTrue(launches.some((launch) => launch.args.includes("rpc")));
      assert.isTrue(
        launches.every(
          (launch) => launch.command === expandHomePath("~/.local/bin/omp", "/test-home"),
        ),
      );
      assert.equal((yield* instance.snapshot.getSnapshot).displayName, "My Pi");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps each workspace's skills and commands separate from the machine catalog", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner();
      const instance = yield* create({ launchArgs: '--approve --skill "extra skill"' }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      assert.isDefined(instance.snapshotForCwd);
      const [first, second] = yield* Effect.all(
        [instance.snapshotForCwd!("/first"), instance.snapshotForCwd!("/second")],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        first.skills.map((skill) => skill.name),
        ["personal", "first"],
      );
      assert.deepEqual(
        second.skills.map((skill) => skill.name),
        ["personal", "second"],
      );
      assert.deepEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "prompt-first"],
      );
      const machine = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(
        machine.skills.map((skill) => skill.name),
        ["personal"],
      );
      assert.deepEqual(
        machine.slashCommands.map((command) => command.name),
        ["compact"],
      );
      assert.equal(first.instanceId, instance.instanceId);
      assert.equal(first.displayName, "My Pi");
      assert.equal(first.accentColor, "#abcdef");
      assert.deepEqual(first.models, machine.models);
      const workspaceLaunch = launches.find((launch) => launch.options.cwd === "/first");
      assert.isDefined(workspaceLaunch);
      assert.equal(workspaceLaunch!.command, "custom-pi");
      assert.includeMembers(
        [...workspaceLaunch!.args],
        ["--approve", "--skill", "extra skill", "--no-session"],
      );
      assert.equal(workspaceLaunch!.options.env?.PI_CODING_AGENT_DIR, "/isolated-pi");
    }).pipe(Effect.scoped),
  );

  it.effect("does not run a disabled provider's workspace probe", () =>
    Effect.gen(function* () {
      const instance = yield* create({}, false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Pi must not spawn")),
        ),
      );
      assert.isDefined(instance.snapshotForCwd);
      const workspace = yield* instance.snapshotForCwd!("/first");
      assert.isFalse(workspace.enabled);
      assert.deepEqual(workspace.skills, []);
    }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "limits discovered thinking defaults to the known active model, known=%s",
    (known) =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner({
          state: {
            thinkingLevel: "high",
            ...(known ? { model: { provider: "test", id: "model" } } : {}),
          },
          models: [
            { provider: "test", id: "model", reasoning: true },
            { provider: "other", id: "model", reasoning: true },
            { provider: "test", id: "other", reasoning: true },
          ],
        });
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.deepEqual(
          snapshot.models.map((model) => [
            model.slug,
            (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
              descriptor.type === "select"
                ? descriptor.options.filter((option) => option.isDefault).map((option) => option.id)
                : [],
            ),
          ]),
          [
            ["default", known ? ["high"] : []],
            ["test/model", known ? ["high"] : []],
            ["other/model", []],
            ["test/other", []],
          ],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("uses the active model's capabilities when it is absent from the catalog", () =>
    Effect.gen(function* () {
      const { spawner } = yield* makePiSpawner({
        state: {
          model: {
            provider: "private",
            id: "model",
            reasoning: true,
            thinkingLevelMap: { off: null, xhigh: "extra_high", max: null },
          },
          thinkingLevel: "xhigh",
        },
      });
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      const thinking = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
      assert.equal(thinking?.id, "thinking");
      assert.equal(thinking?.type, "select");
      if (thinking?.type !== "select") return;
      assert.deepEqual(
        thinking.options.map((option) => option.id),
        ["minimal", "low", "medium", "high", "xhigh"],
      );
      assert.equal(thinking.options.find((option) => option.isDefault)?.id, "xhigh");
      assert.deepEqual(snapshot.models[1]?.capabilities?.optionDescriptors, []);
    }).pipe(Effect.scoped),
  );

  it.effect("does not invent thinking support for a non-reasoning default model", () =>
    Effect.gen(function* () {
      const { spawner } = yield* makePiSpawner({
        state: {
          model: { provider: "test", id: "model", reasoning: false },
          thinkingLevel: "high",
        },
        models: [{ provider: "test", id: "model", reasoning: false }],
      });
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      assert.deepEqual(
        (yield* instance.snapshot.getSnapshot).models[0]?.capabilities?.optionDescriptors,
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails command discovery instead of returning an empty successful workspace catalog",
    () =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner();
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        assert.isDefined(instance.snapshotForCwd);
        const error = yield* Effect.flip(instance.snapshotForCwd!("/failed"));
        assert.equal(error._tag, "ProviderDriverError");
        assert.equal(error.instanceId, instance.instanceId);
        assert.deepEqual(
          (yield* instance.snapshot.getSnapshot).skills.map((skill) => skill.name),
          ["personal"],
        );
      }).pipe(Effect.scoped),
  );
});
