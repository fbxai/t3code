import * as NodeNet from "node:net";
// @effect-diagnostics-next-line nodeBuiltinImport:off - This fixture serves the public descriptor to a real CLI subprocess.
import * as NodeHttp from "node:http";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

describe("__ssh-helper check-protocol", () => {
  it.live.each([1, ORCHESTRATION_PROTOCOL_VERSION])(
    "checks protocol %s regardless of the environment label",
    (protocol) =>
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const server = NodeHttp.createServer((request, response) => {
              assert.equal(request.url, "/.well-known/t3/environment");
              response.end(
                JSON.stringify({
                  label: "anything-the-host-wants",
                  orchestrationProtocolVersion: protocol,
                }),
              );
            });
            server.once("error", (cause) => resume(Effect.die(cause)));
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
            }),
        );
        const port = (server.address() as NodeNet.AddressInfo).port;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            new URL("../bin.ts", import.meta.url).pathname,
            "__ssh-helper",
            "check-protocol",
            String(port),
          ]),
        );
        const [stderr, code] = yield* Effect.all(
          [
            child.stderr.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (all, chunk) => all + chunk,
              ),
            ),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(code, protocol === ORCHESTRATION_PROTOCOL_VERSION ? 0 : 1, stderr);
        if (code !== 0) assert.include(stderr, "It was left running");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
