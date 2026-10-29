import { dirname, isAbsolute, join } from "node:path";
import type { NativeRenderRuntime } from "./native-render-host-export.js";

/** Resolve only application-owned executables; the capability probe explains unavailable files. */
export function nativeRenderRuntime(
  options: {
    appPath: string;
    resourcesPath: string;
    packaged: boolean;
    executable: string;
    temporaryDirectory: string;
    ffmpeg: string;
  },
  platform: NodeJS.Platform = process.platform,
): NativeRenderRuntime | undefined {
  if (platform !== "win32" && platform !== "darwin") return undefined;
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    binary: options.packaged
      ? join(options.resourcesPath, "bin", `aster-render-cli${suffix}`)
      : join(options.appPath, "target", "release", `aster-render-cli${suffix}`),
    compiler:
      platform === "win32" ? join(dirname(options.executable), "dxcompiler.dll") : undefined,
    ffprobe: isAbsolute(options.ffmpeg)
      ? join(dirname(options.ffmpeg), `ffprobe${suffix}`)
      : `ffprobe${suffix}`,
    temporaryRoot: join(options.temporaryDirectory, "aster-native-export"),
  };
}
