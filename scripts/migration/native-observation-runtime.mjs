import assert from "node:assert/strict";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { nativeReleaseBuild } from "../native-build.mjs";
import { captureExecutionArtifacts } from "../performance/execution-artifacts.mjs";
import { runStep } from "./process.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Build one immutable production runtime for all native observations in a paired series. */
export async function prepareNativeObservationRuntime(
  context,
  execute = runStep,
  { application = false } = {},
) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const source = await sourceProvenance(root);
  const build = [];
  const appPath = application ? join(output, "app") : undefined;
  const webDirectory = appPath ? join(appPath, "dist") : join(output, "web");
  for (const command of [
    nativeReleaseBuild("native-observation-renderer-build"),
    { id: "native-observation-electron-build", file: "pnpm", args: ["electron:compile"] },
    {
      id: "native-observation-web-build",
      file: application ? "pnpm" : "node",
      args: application
        ? ["exec", "vite", "build", "--outDir", webDirectory]
        : ["scripts/performance/build.mjs", webDirectory],
    },
  ]) {
    const step = await execute(command, {
      ...context,
      env: { ...context.env, NODE_ENV: "production" },
    });
    build.push(step);
    assert.equal(step.status, "passed", `${command.id} failed`);
  }
  assert(
    (
      await stat(join(webDirectory, application ? "index.html" : "tests/performance/harness.html"))
    ).isFile(),
  );
  const execution = await captureExecutionArtifacts(root, { webDirectory, runDirectory: output });
  const binary = join(output, "aster-render-cli.exe");
  await copyFile(join(root, "target/release/aster-render-cli.exe"), binary);
  const nativeRuntime = {
    binary,
    compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
    ffprobe: join(root, "build/ffmpeg/ffprobe.exe"),
    runtimeDirectory: join(root, execution.snapshot.runtime.directory, "dist-electron"),
    bridgePath: join(root, execution.snapshot.runtime.directory, "bridge/aster-desktop-bridge.exe"),
  };
  const binaries = await Promise.all(
    [binary, nativeRuntime.compiler, nativeRuntime.ffprobe].map(async (path) => ({
      path,
      sha256: await hashFile(path),
    })),
  );
  const assertUnchanged = async () => {
    await execution.assertUnchanged();
    for (const entry of binaries)
      assert.equal(await hashFile(entry.path), entry.sha256, "Prepared native runtime changed");
    assert.equal(
      (await sourceProvenance(root)).source_sha256,
      source.source_sha256,
      "Prepared native source changed",
    );
  };
  await assertUnchanged();
  return { source, build, appPath, webDirectory, execution, nativeRuntime, assertUnchanged };
}
