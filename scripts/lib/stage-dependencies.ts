import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

// Staging must use the installed lockfile versions, especially for patched packages.
export const pinInstalledDependencies = Effect.fn("pinInstalledDependencies")(function* (
  dependencies: Record<string, string>,
  packageDirectories: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pinned = { ...dependencies };
  for (const name of Object.keys(dependencies)) {
    for (const directory of packageDirectories) {
      const manifest = path.join(directory, "node_modules", name, "package.json");
      if (!(yield* fs.exists(manifest))) continue;
      pinned[name] = (yield* decodeManifest(yield* fs.readFileString(manifest))).version;
      break;
    }
  }
  return pinned;
});
