import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

if (process.platform === "darwin") {
  const architecture = process.env.ASTER_NATIVE_ARCH ?? process.arch;
  const target = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" }[architecture];
  if (!target) throw new Error("Unsupported macOS native architecture");
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "-p",
      "aster-macos",
      "--features",
      "node-addon",
      "--target",
      target,
    ],
    { stdio: "inherit" },
  );
  mkdirSync("dist-electron/native", { recursive: true });
  copyFileSync(
    join(process.env.CARGO_TARGET_DIR ?? "target", target, "release", "libaster_macos.dylib"),
    "dist-electron/native/macos-surface.node",
  );
}
