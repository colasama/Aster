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
  binary = "ffmpeg",
} = {}) {
  const variable = binary === "ffprobe" ? "ASTER_FFPROBE_PATH" : "ASTER_FFMPEG_PATH";
  const binaryName = platform === "win32" ? `${binary}.exe` : binary;
  const configured = environment[variable]?.trim();
  const candidates = configured
    ? [resolve(configured)]
    : (environment.PATH ?? "")
        .split(pathDelimiter)
        .filter(Boolean)
        .map((entry) => join(entry.replace(/^"|"$/g, ""), binaryName));
  for (const candidate of candidates) {
    try {
      if (stat(candidate).isFile()) return realpath(candidate);
    } catch {
      // Keep searching PATH entries. The final error names the supported configuration override.
    }
  }
  const requested = configured ? `${variable} (${configured})` : "PATH";
  throw new Error(
    `${binary} was not found via ${requested}. Install FFmpeg or set ${variable} to its executable before building an artifact.`,
  );
}

export function prepareFfmpegBundle({
  environment = process.env,
  platform = process.platform,
  projectRoot = PROJECT_ROOT,
  probe = spawnSync,
  runProbes = true,
} = {}) {
  const source = resolveFfmpegSource({ environment, platform });
  const probeName = platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const probeSource = resolveFfmpegSource({
    environment: {
      ...environment,
      PATH: `${dirname(source)}${delimiter}${environment.PATH ?? ""}`,
    },
    platform,
    binary: "ffprobe",
  });
  const provenance = {
    source,
    version: "not executed (cross-architecture staging)",
    build: "not executed (cross-architecture staging)",
    ffprobe: {
      source: probeSource,
      version: "not executed (cross-architecture staging)",
      build: "not executed (cross-architecture staging)",
    },
  };
  if (runProbes) {
    const probeResult = probe(probeSource, ["-hide_banner", "-version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (probeResult.error || probeResult.status !== 0)
      throw new Error(`FFprobe at ${probeSource} could not be executed`);
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
    provenance.version = result.stdout?.split(/\r?\n/, 1)[0]?.trim() || "unknown";
    provenance.build = result.stdout?.trim() || "unknown";
    provenance.ffprobe.version = probeResult.stdout?.split(/\r?\n/, 1)[0]?.trim() || "unknown";
    provenance.ffprobe.build = probeResult.stdout?.trim() || "unknown";
  }
  const destinationDirectory = join(projectRoot, "build", "ffmpeg");
  const destination = join(destinationDirectory, ffmpegBinaryName(platform));
  rmSync(destinationDirectory, { force: true, recursive: true });
  mkdirSync(destinationDirectory, { recursive: true });
  copyFileSync(source, destination);
  const probeDestination = join(destinationDirectory, probeName);
  copyFileSync(probeSource, probeDestination);
  if (platform !== "win32") chmodSync(probeDestination, statSync(probeDestination).mode | 0o111);
  if (platform !== "win32") chmodSync(destination, statSync(destination).mode | 0o111);
  writeFileSync(
    join(destinationDirectory, "ffmpeg-source.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
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
