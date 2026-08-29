import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");

export function ffmpegBinaryName(platform = process.platform) {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export function resolveFfmpegSource({
  environment = process.env,
  platform = process.platform,
  pathDelimiter = delimiter,
  stat = statSync,
  realpath = realpathSync,
} = {}) {
  const configured = environment.ASTER_FFMPEG_PATH?.trim();
  const candidates = configured
    ? [resolve(configured)]
    : (environment.PATH ?? "")
        .split(pathDelimiter)
        .filter(Boolean)
        .map((entry) => join(entry.replace(/^"|"$/g, ""), ffmpegBinaryName(platform)));
  for (const candidate of candidates) {
    try {
      if (stat(candidate).isFile()) return realpath(candidate);
    } catch {
      // Keep searching PATH entries. The final error names the supported configuration override.
    }
  }
  const requested = configured ? `ASTER_FFMPEG_PATH (${configured})` : "PATH";
  throw new Error(
    `FFmpeg was not found via ${requested}. Install FFmpeg or set ASTER_FFMPEG_PATH to its executable before building an artifact.`,
  );
}

export function prepareFfmpegBundle({
  environment = process.env,
  platform = process.platform,
  projectRoot = PROJECT_ROOT,
  probe = spawnSync,
} = {}) {
  const source = resolveFfmpegSource({ environment, platform });
  const result = probe(source, ["-hide_banner", "-version"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? result.stderr?.trim() ?? `exit ${String(result.status)}`;
    throw new Error(`FFmpeg at ${source} could not be executed: ${detail}`);
  }
  const destinationDirectory = join(projectRoot, "build", "ffmpeg");
  const destination = join(destinationDirectory, ffmpegBinaryName(platform));
  rmSync(destinationDirectory, { force: true, recursive: true });
  mkdirSync(destinationDirectory, { recursive: true });
  copyFileSync(source, destination);
  if (platform !== "win32") chmodSync(destination, statSync(destination).mode | 0o111);
  writeFileSync(
    join(destinationDirectory, "ffmpeg-source.json"),
    `${JSON.stringify(
      {
        source,
        version: result.stdout?.split(/\r?\n/, 1)[0]?.trim() || "unknown",
      },
      null,
      2,
    )}\n`,
  );
  return { destination, source };
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  try {
    const prepared = prepareFfmpegBundle();
    process.stdout.write(`Prepared FFmpeg bundle: ${prepared.source} -> ${prepared.destination}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
