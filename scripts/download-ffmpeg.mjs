import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { prepareFfmpegBundle } from "./prepare-ffmpeg.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("ffmpeg-downloads.json", import.meta.url), "utf8"),
);

// Verify cached downloads too: a cache hit must not bypass the pinned digest.
export async function downloadAsset(url, sha256, cachePath) {
  let bytes = existsSync(cachePath) ? readFileSync(cachePath) : undefined;
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    // curl is present on all three runners and honors the host's proxy settings.
    const { stdout } = await promisify(execFile)(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--retry",
        "3",
        "--connect-timeout",
        "30",
        "--max-time",
        "120",
        url,
      ],
      { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, windowsHide: true },
    );
    bytes = stdout;
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error(`SHA-256 mismatch: ${url}`);
    }
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, bytes);
  }
  return url.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}

export function validateMediaBinary(bytes) {
  if (bytes.includes(Buffer.from("--enable-nonfree"))) {
    throw new Error("Refusing to bundle FFmpeg configured with --enable-nonfree");
  }
}

const archiveTypeFor = (target) => (target.startsWith("darwin-") ? "zip" : "gz");

async function main() {
  const universal = process.argv.includes("--universal");
  const platform = process.platform;
  const hostTarget = `${platform}-${process.arch}`;
  const targetIndex = process.argv.indexOf("--target");
  const requestedTarget = targetIndex === -1 ? undefined : process.argv[targetIndex + 1];
  if (targetIndex !== -1 && (!requestedTarget || requestedTarget.startsWith("-")))
    throw new Error("--target requires a <platform>-<arch> value");
  if (universal && requestedTarget) throw new Error("--universal and --target cannot be combined");
  if (requestedTarget && !requestedTarget.startsWith(`${platform}-`))
    throw new Error("--target must match the host platform");
  if (universal && platform !== "darwin") throw new Error("Universal builds require macOS");
  const targets = universal ? ["darwin-x64", "darwin-arm64"] : [requestedTarget ?? hostTarget];
  for (const target of targets) {
    if (!manifest.assets[`ffmpeg-${target}.${archiveTypeFor(target)}`])
      throw new Error(`Unsupported target: ${target}`);
  }
  const cache = join(projectRoot, ".aster-cache", "ffmpeg");
  const sourceDirectory = join(cache, universal ? "darwin-universal" : targets[0]);
  mkdirSync(sourceDirectory, { recursive: true });
  const assets = {};
  for (const target of targets) {
    const archiveType = archiveTypeFor(target);
    for (const name of [
      `ffmpeg-${target}.${archiveType}`,
      `ffprobe-${target}.${archiveType}`,
      `${target}.LICENSE`,
      `${target}.README`,
    ]) {
      const asset = manifest.assets[name];
      let bytes = await downloadAsset(asset.url, asset.sha256, join(cache, name));
      const binary = name.startsWith("ffmpeg-")
        ? "ffmpeg"
        : name.startsWith("ffprobe-")
          ? "ffprobe"
          : undefined;
      if (name.endsWith(".zip")) {
        bytes = execFileSync("tar", ["-xOf", join(cache, name), binary], {
          maxBuffer: 256 * 1024 * 1024,
        });
      }
      if (binary) validateMediaBinary(bytes);
      const destination = join(sourceDirectory, binary ? `${binary}-${target}` : name);
      writeFileSync(destination, bytes);
      assets[name] = asset;
    }
  }
  for (const binary of ["ffmpeg", "ffprobe"]) {
    const destination = join(sourceDirectory, platform === "win32" ? `${binary}.exe` : binary);
    if (universal) {
      execFileSync("lipo", [
        "-create",
        ...targets.map((target) => join(sourceDirectory, `${binary}-${target}`)),
        "-output",
        destination,
      ]);
      execFileSync("codesign", ["--force", "--sign", "-", destination]);
    } else {
      copyFileSync(join(sourceDirectory, `${binary}-${targets[0]}`), destination);
    }
    if (platform !== "win32") chmodSync(destination, 0o755);
  }
  const binaryName = (name) => join(sourceDirectory, platform === "win32" ? `${name}.exe` : name);
  const runnable = universal || targets[0] === hostTarget;
  const prepared = prepareFfmpegBundle({
    environment: {
      ...process.env,
      ASTER_FFMPEG_PATH: binaryName("ffmpeg"),
      ASTER_FFPROBE_PATH: binaryName("ffprobe"),
    },
    runProbes: runnable,
  });
  const staging = dirname(prepared.destination);
  for (const target of targets) {
    for (const extension of ["LICENSE", "README"]) {
      const name = `${target}.${extension}`;
      copyFileSync(join(sourceDirectory, name), join(staging, name));
    }
  }
  writeFileSync(
    join(staging, "ffmpeg-download.json"),
    `${JSON.stringify({ flavor: "gpl-preview", assets }, null, 2)}\n`,
  );
  process.stdout.write(`Prepared pinned FFmpeg and FFprobe for ${targets.join(" + ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
