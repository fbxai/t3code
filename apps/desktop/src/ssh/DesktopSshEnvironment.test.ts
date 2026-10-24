import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { SshLaunchError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
const promptsLayer = Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
  request: () => Effect.die("unexpected password prompt request"),
  resolve: () => Effect.die("unexpected password prompt resolution"),
});
const logTestLayer = (manager: SshTunnel.SshEnvironmentManagerShape) =>
  Layer.effect(DesktopSshEnvironment.DesktopSshEnvironment, DesktopSshEnvironment.make).pipe(
    Layer.provide(Layer.succeed(SshTunnel.SshEnvironmentManager, manager)),
    Layer.provide(promptsLayer),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(NetService.layer),
  );

describe("sshEnvironment", () => {
  it.effect(
    "retains setup diagnostics after a failed connection without retrying it to read logs",
    () => {
      let attempts = 0;
      const manager: SshTunnel.SshEnvironmentManagerShape = {
        ensureEnvironment: () =>
          Effect.gen(function* () {
            attempts++;
            yield* Effect.logDebug("ssh.environment.ensure.start", { hostname: "devbox" });
            return yield* new SshLaunchError({ message: "curl returned 404", stdout: "" });
          }),
        disconnectEnvironment: () => Effect.void,
        readServerLogs: () => Effect.succeed("daemon startup failed credential=private"),
      };
      return Effect.gen(function* () {
        const service = yield* DesktopSshEnvironment.DesktopSshEnvironment;
        yield* Effect.result(service.ensureEnvironment(target));
        const local = yield* service.readLogs(target);
        assert.include(local.local, "ssh.environment.ensure.start");
        assert.include(local.local, "curl returned 404");
        assert.equal(local.remote, "");
        const refreshed = yield* service.readLogs(target, true);
        assert.equal(refreshed.remote, "daemon startup failed credential=[redacted]");
        assert.equal(attempts, 1);
        yield* service.clearLogs(target);
        const cleared = yield* service.readLogs(target);
        assert.equal(cleared.local, "");
        assert.equal(cleared.remote, "");
      }).pipe(Effect.provide(logTestLayer(manager)));
    },
  );

  it.effect("preserves local diagnostics when remote log retrieval fails", () => {
    const manager: SshTunnel.SshEnvironmentManagerShape = {
      ensureEnvironment: () => new SshLaunchError({ message: "setup failed", stdout: "" }),
      disconnectEnvironment: () => Effect.void,
      readServerLogs: () =>
        new SshLaunchError({ message: "SSH offline token=private", stdout: "" }),
    };
    return Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      yield* Effect.result(service.ensureEnvironment(target));
      const logs = yield* service.readLogs(target, true);
      assert.include(logs.local, "setup failed");
      assert.include(logs.remoteError!, "SSH offline token=[redacted]");
    }).pipe(Effect.provide(logTestLayer(manager)));
  });

  it.effect("does not restore a pending remote fetch after clearing logs", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<string>();
      const manager: SshTunnel.SshEnvironmentManagerShape = {
        ensureEnvironment: () => Effect.die("unexpected setup"),
        disconnectEnvironment: () => Effect.void,
        readServerLogs: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(complete))),
      };
      yield* Effect.gen(function* () {
        const service = yield* DesktopSshEnvironment.DesktopSshEnvironment;
        const pending = yield* Effect.forkChild(service.readLogs(target, true));
        yield* Deferred.await(started);
        yield* service.clearLogs(target);
        yield* Deferred.succeed(complete, "stale remote output");
        const result = yield* Fiber.join(pending);
        assert.equal(result.remote, "");
        assert.equal((yield* service.readLogs(target)).remote, "");
      }).pipe(Effect.provide(logTestLayer(manager)));
    }),
  );
});
