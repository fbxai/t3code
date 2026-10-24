import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { pinInstalledDependencies } from "./stage-dependencies.ts";

it.effect("stages installed versions while retaining explicit cross-platform native packages", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-dependencies-" });
    yield* fs.makeDirectory(`${root}/server/node_modules/node-pty`, { recursive: true });
    yield* fs.writeFileString(
      `${root}/server/node_modules/node-pty/package.json`,
      JSON.stringify({ version: "1.2.0-beta.15" }),
    );
    yield* fs.makeDirectory(`${root}/desktop/node_modules/ffi-rs`, { recursive: true });
    yield* fs.writeFileString(
      `${root}/desktop/node_modules/ffi-rs/package.json`,
      JSON.stringify({ version: "1.3.0" }),
    );
    assert.deepEqual(
      yield* pinInstalledDependencies(
        {
          "node-pty": "^1.2.0-beta.15",
          "ffi-rs": "^1.3.0",
          "@ff-labs/fff-bin-linux-arm64": "0.6.0",
        },
        [`${root}/desktop`, `${root}/server`],
      ),
      {
        "node-pty": "1.2.0-beta.15",
        "ffi-rs": "1.3.0",
        "@ff-labs/fff-bin-linux-arm64": "0.6.0",
      },
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
