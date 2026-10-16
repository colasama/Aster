import { dirname, isAbsolute, join } from "node:path";
import type { NativeRenderRuntime } from "./native-render-host-export.js";

/** Resolve only application-owned executables; the capability probe explains unavailable files. */
export function nativeRenderRuntime(options: {
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
  executable: string;
  temporaryDirectory: string;
  ffmpeg: string;
}): NativeRenderRuntime | undefined {
  if (process.platform !== "win32") return undefined;
  return {
    binary: options.packaged
      ? join(options.resourcesPath, "bin", "aster-render-cli.exe")
      : join(options.appPath, "target", "release", "aster-render-cli.exe"),
    compiler: join(dirname(options.executable), "dxcompiler.dll"),
    ffprobe: isAbsolute(options.ffmpeg)
      ? join(dirname(options.ffmpeg), "ffprobe.exe")
      : "ffprobe.exe",
    temporaryRoot: join(options.temporaryDirectory, "aster-native-export"),
  };
}
