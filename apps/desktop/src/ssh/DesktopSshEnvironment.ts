import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshEnvironmentLogs,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { resolveSshTarget, targetConnectionKey } from "@t3tools/ssh/command";
import { redactConnectionLog } from "@t3tools/shared/connectionLogs";
import { discoverSshHosts } from "@t3tools/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";
import { createSshLogCache } from "./SshLogCache.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly readLogs: (
      target: DesktopSshEnvironmentTarget,
      refreshRemote?: boolean,
    ) => Effect.Effect<DesktopSshEnvironmentLogs>;
    readonly clearLogs: (target: DesktopSshEnvironmentTarget) => Effect.Effect<void>;
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteT3RunnerOptions>;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "T3 Code window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

/** @public */
export const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));
  const logs = createSshLogCache();

  const capture = <A, E, R>(
    target: DesktopSshEnvironmentTarget,
    operation: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const entry = logs.get(targetConnectionKey(target), yield* Clock.currentTimeMillis);
      const logger = Logger.make((options) => {
        const record = Logger.formatStructured.log(options);
        logs.append(
          entry,
          `${record.timestamp} ${record.level} ${typeof record.message === "string" ? record.message : JSON.stringify(record.message)}${record.cause ? `\n${record.cause}` : ""}`,
          options.date.getTime(),
        );
      });
      return yield* operation.pipe(
        Effect.tapCause((cause) => Effect.logError("SSH operation failed", Cause.pretty(cause))),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: true })),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    });

  return DesktopSshEnvironment.of({
    readLogs: Effect.fn("desktop.ssh.readLogs")(function* (target, refreshRemote = false) {
      const entry = logs.get(targetConnectionKey(target), yield* Clock.currentTimeMillis);
      if (refreshRemote) {
        const revision = entry.revision;
        const result = yield* manager
          .readServerLogs(target)
          .pipe(
            Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
            Effect.provide(runtimeContext),
            Effect.result,
          );
        if (entry.revision === revision) {
          if (result._tag === "Success") {
            entry.remote = redactConnectionLog(result.success);
            entry.remoteError = null;
          } else {
            entry.remoteError = redactConnectionLog(String(result.failure));
          }
          entry.updatedAt = yield* Clock.currentTimeMillis;
        }
      }
      return {
        capturedAt: yield* Clock.currentTimeMillis,
        local: entry.local,
        remote: entry.remote,
        remoteError: entry.remoteError,
      };
    }),
    clearLogs: Effect.fn("desktop.ssh.clearLogs")(function* (target) {
      logs.clear(targetConnectionKey(target), yield* Clock.currentTimeMillis);
    }),
    discoverHosts: Effect.fn("desktop.ssh.discoverHosts")(function* (input) {
      return yield* discoverDesktopSshHostsEffect(input);
    }, Effect.provide(runtimeContext)),
    resolveHost: Effect.fn("desktop.ssh.resolveHost")(function* (alias) {
      return yield* resolveSshTarget(alias.trim());
    }, Effect.provide(runtimeContext)),
    ensureEnvironment: Effect.fn("desktop.ssh.ensureEnvironment")(
      function* (target, ensureOptions) {
        return yield* capture(
          target,
          manager.ensureEnvironment(target, ensureOptions).pipe(
            Effect.tap((bootstrap) =>
              Effect.gen(function* () {
                logs.bind(
                  targetConnectionKey(bootstrap.target),
                  logs.get(targetConnectionKey(target), yield* Clock.currentTimeMillis),
                );
              }),
            ),
          ),
        );
      },
      Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
      Effect.provide(runtimeContext),
    ),
    disconnectEnvironment: Effect.fn("desktop.ssh.disconnectEnvironment")(
      function* (target) {
        return yield* capture(target, manager.disconnectEnvironment(target));
      },
      Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
      Effect.provide(runtimeContext),
    ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer(
        options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner },
      ),
    ),
  );
