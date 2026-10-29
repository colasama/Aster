import { expect, test } from "vitest";
import { nativeRenderRuntime } from "./native-render-runtime";

const options = {
  appPath: "/aster",
  resourcesPath: "/app/Resources",
  packaged: true,
  executable: "/app/MacOS/Aster",
  temporaryDirectory: "/private/tmp",
  ffmpeg: "/app/Resources/bin/ffmpeg",
};

test("macOS resolves bundled native tools without a Windows compiler", () => {
  expect(nativeRenderRuntime(options, "darwin")).toEqual({
    binary: "/app/Resources/bin/aster-render-cli",
    compiler: undefined,
    ffprobe: "/app/Resources/bin/ffprobe",
    temporaryRoot: "/private/tmp/aster-native-export",
  });
  expect(nativeRenderRuntime({ ...options, packaged: false }, "darwin")?.binary).toBe(
    "/aster/target/release/aster-render-cli",
  );
  expect(nativeRenderRuntime(options, "linux")).toBeUndefined();
});

test("Windows retains its native runtime and compiler paths", () => {
  const runtime = nativeRenderRuntime(options, "win32");
  expect(runtime?.binary).toBe("/app/Resources/bin/aster-render-cli.exe");
  expect(runtime?.compiler).toBe("/app/MacOS/dxcompiler.dll");
  expect(runtime?.ffprobe).toBe("/app/Resources/bin/ffprobe.exe");
});
