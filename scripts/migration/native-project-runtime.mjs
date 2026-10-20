import assert from "node:assert/strict";
import { copyFile, cp, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import electron from "electron";
import { nativeReleaseBuild } from "../native-build.mjs";
import { captureExecutionArtifacts } from "../performance/execution-artifacts.mjs";
import { runStep } from "./process.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Preserve the native project executables and the isolated, raster-only Electron service. */
export async function prepareNativeProjectRuntime(context, execute = runStep) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const source = await sourceProvenance(root);
  if (context.source) assert.equal(source.source_sha256, context.source.source_sha256);
  const build = [];
  for (const command of [
    nativeReleaseBuild("project-native-build"),
    { id: "project-electron-build", file: "pnpm", args: ["electron:compile"] },
    { id: "project-raster-build", file: "node", args: ["scripts/build-native-raster.mjs"] },
  ]) {
    const step = await execute(command, context);
    build.push(step);
    assert.equal(step.status, "passed", command.id);
  }
  const webDirectory = join(output, "web");
  await cp(join(root, "dist/native-raster"), webDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const execution = await captureExecutionArtifacts(root, { webDirectory, runDirectory: output });
  const binary = join(output, "aster-render-cli.exe");
  await copyFile(join(root, "target/release/aster-render-cli.exe"), binary);
  const rasterProvider = {
    executable: electron,
    arguments: [
      join(
        root,
        execution.snapshot.runtime.directory,
        "dist-electron/electron/native-raster-host.js",
      ),
    ],
    bundle: join(webDirectory, "native-raster.html"),
    bridge: join(root, execution.snapshot.runtime.directory, "bridge/aster-desktop-bridge.exe"),
    timeoutMs: 120000,
  };
  const binaries = [];
  for (const path of [
    binary,
    electron,
    join(root, "build/ffmpeg/ffmpeg.exe"),
    join(root, "build/ffmpeg/ffprobe.exe"),
    join(root, "node_modules/electron/dist/dxcompiler.dll"),
  ]) {
    binaries.push({
      path: relative(root, path).replaceAll("\\", "/"),
      sha256: await hashFile(path),
    });
  }
  const assertUnchanged = async () => {
    await execution.assertUnchanged();
    for (const file of binaries) assert.equal(await hashFile(join(root, file.path)), file.sha256);
    assert.equal((await sourceProvenance(root)).source_sha256, source.source_sha256);
  };
  await assertUnchanged();
  return { source, build, binary, binaries, execution, rasterProvider, assertUnchanged };
}
