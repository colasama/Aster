import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Keep Cargo feature unification identical for packaged and verified native executables. */
export function nativeReleaseBuild(id) {
  return {
    id,
    file: "cargo",
    args: ["build", "--release", "-p", "aster-desktop-bridge", "-p", "aster-render-cli"],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = nativeReleaseBuild("native-release-build");
  const result = spawnSync(command.file, command.args, { stdio: "inherit", windowsHide: true });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
