import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

const MEDIA_EXTENSIONS =
  /\.(mp4|mov|mkv|webm|avi|m4v|wav|mp3|aac|m4a|ogg|flac|png|jpg|jpeg|webp)$/i;

export async function localMediaPath(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || !MEDIA_EXTENSIONS.test(value))
    throw new Error("Reference must be an absolute path to a supported local media file");
  const path = await realpath(value);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > 16 * 1024 ** 3)
    throw new Error("Reference media must be a nonempty file no larger than 16 GiB");
  return path;
}

export function runMediaProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  maxBytes = 12 * 1024 * 1024,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill();
    };
    const abort = () => stop(new Error("Reference media request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("Reference media request timed out")), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new Error("Reference media exceeded its output budget"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`Media decoder failed (${code}): ${stderr.slice(-2000)}`));
      else resolve({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}

export class ReferenceMediaService {
  constructor(
    readonly ffmpeg: string,
    readonly ffprobe: string,
  ) {}

  async probe(pathValue: unknown, signal: AbortSignal) {
    const path = await localMediaPath(pathValue);
    const result = await runMediaProcess(
      this.ffprobe,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        path,
      ],
      signal,
      1024 * 1024,
    );
    return { path, ...JSON.parse(result.stdout.toString("utf8")) };
  }

  async frames(input: Record<string, unknown>, signal: AbortSignal) {
    const path = await localMediaPath(input.path);
    const times = input.times as number[];
    const dimension = (input.maxDimension as number | undefined) ?? 384;
    if (
      !Array.isArray(times) ||
      times.length < 1 ||
      times.length > 12 ||
      times.some((t) => !Number.isFinite(t) || t < 0 || t > 86_400)
    )
      throw new Error("Reference samples require 1 through 12 bounded times");
    if (!Number.isSafeInteger(dimension) || dimension < 64 || dimension > 2048)
      throw new Error("Reference dimensions must be between 64 and 2048");
    const frames = [];
    let total = 0;
    for (const time of times) {
      const result = await runMediaProcess(
        this.ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          path,
          "-map",
          "0:v:0",
          "-vf",
          `select=gte(t\\,${time}),showinfo,scale=${dimension}:${dimension}:force_original_aspect_ratio=decrease`,
          "-frames:v",
          "1",
          "-fps_mode",
          "passthrough",
          "-f",
          "image2pipe",
          "-c:v",
          "png",
          "pipe:1",
        ],
        signal,
      );
      const timestamp = result.stderr.match(/\bn:\s*0\s+pts:.*?pts_time:([\d.e+-]+)/)?.[1];
      if (
        !timestamp ||
        result.stdout.length < 24 ||
        result.stdout.subarray(1, 4).toString() !== "PNG"
      )
        throw new Error(`No video frame at or after ${time}s`);
      total += result.stdout.length;
      if (total > 12 * 1024 * 1024)
        throw new Error("Reference samples exceeded 12 MiB; reduce resolution or sample count");
      frames.push({
        time,
        actualTime: Number(timestamp),
        mimeType: "image/png" as const,
        width: result.stdout.readUInt32BE(16),
        height: result.stdout.readUInt32BE(20),
        data: result.stdout.toString("base64"),
      });
    }
    return {
      path,
      timestampPolicy: "first-frame-at-or-after-request",
      colorPolicy: "FFmpeg display RGB conversion; no automatic HDR matching",
      frames,
    };
  }

  async audio(input: Record<string, unknown>, signal: AbortSignal) {
    const path = await localMediaPath(input.path);
    const start = input.start as number;
    const duration = input.duration as number;
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      start > 86_400 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 30
    )
      throw new Error("Audio requires a bounded start time and duration up to 30 seconds");
    const result = await runMediaProcess(
      this.ffmpeg,
      [
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        path,
        "-ss",
        String(start),
        "-t",
        String(duration),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      signal,
      2 * 1024 * 1024,
    );
    if (result.stdout.length <= 80) throw new Error("Reference audio range is empty");
    return {
      path,
      start,
      requestedDuration: duration,
      sampleRate: 16000,
      channels: 1,
      audio: { mimeType: "audio/wav", data: result.stdout.toString("base64") },
    };
  }
}

export function mediaMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
        ".svg": "image/svg+xml",
        ".psd": "image/vnd.adobe.photoshop",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}
