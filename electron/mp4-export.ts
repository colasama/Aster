import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

const MAX_DIMENSION = 16_384;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_COUNT = 10_000_000;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const ENCODER_PROBE_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 5_000;

export type Mp4PixelFormat = "bgra" | "rgba";
export type Mp4Encoder = "h264_nvenc" | "libx264";

export interface Mp4ExportStartRequest {
  outputPath: string;
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  frameCount: number;
  pixelFormat: Mp4PixelFormat;
}

export interface Mp4ExportStarted {
  jobId: string;
  encoder: Mp4Encoder;
}

export interface Mp4ExportReport extends Mp4ExportStarted {
  outputPath: string;
  frameCount: number;
  bytesWritten: number;
  elapsedMs: number;
}

interface ValidatedRequest extends Mp4ExportStartRequest {
  frameBytes: number;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class Mp4ExportManager {
  readonly #ffmpegExecutable: string;
  #encoderProbe?: Promise<Mp4Encoder>;
  #active?: Mp4ExportSession;

  constructor(ffmpegExecutable: string) {
    this.#ffmpegExecutable = ffmpegExecutable;
  }

  async start(value: unknown, ownerId: number): Promise<Mp4ExportStarted> {
    if (this.#active) throw new Error("Another MP4 export is already active");
    const request = await validateMp4ExportRequest(value);
    if (!this.#encoderProbe) this.#encoderProbe = selectEncoder(this.#ffmpegExecutable);
    const encoder = await this.#encoderProbe;
    const session = new Mp4ExportSession(this.#ffmpegExecutable, request, encoder, ownerId);
    this.#active = session;
    return { jobId: session.jobId, encoder };
  }

  async write(jobId: unknown, pixels: unknown, ownerId: number): Promise<void> {
    const session = this.#ownedSession(jobId, ownerId);
    if (!(pixels instanceof ArrayBuffer)) throw new Error("MP4 frame must be an ArrayBuffer");
    await session.write(pixels);
  }

  async finish(jobId: unknown, ownerId: number): Promise<Mp4ExportReport> {
    const session = this.#ownedSession(jobId, ownerId);
    try {
      return await session.finish();
    } finally {
      if (this.#active === session) this.#active = undefined;
    }
  }

  async cancel(jobId: unknown, ownerId: number): Promise<void> {
    const session = this.#ownedSession(jobId, ownerId);
    try {
      await session.cancel();
    } finally {
      if (this.#active === session) this.#active = undefined;
    }
  }

  async cancelOwner(ownerId: number): Promise<void> {
    if (!this.#active || this.#active.ownerId !== ownerId) return;
    const session = this.#active;
    this.#active = undefined;
    await session.cancel();
  }

  async dispose(): Promise<void> {
    const session = this.#active;
    this.#active = undefined;
    await session?.cancel();
  }

  #ownedSession(jobId: unknown, ownerId: number): Mp4ExportSession {
    if (typeof jobId !== "string" || !this.#active || this.#active.jobId !== jobId)
      throw new Error("MP4 export job is unavailable");
    if (this.#active.ownerId !== ownerId)
      throw new Error("MP4 export job belongs to another renderer");
    return this.#active;
  }
}

class Mp4ExportSession {
  readonly jobId = randomUUID();
  readonly ownerId: number;
  readonly #request: ValidatedRequest;
  readonly #encoder: Mp4Encoder;
  readonly #temporaryPath: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<ProcessExit>;
  readonly #startedAt = performance.now();
  #stderr = Buffer.alloc(0);
  #stderrTruncated = false;
  #receivedFrames = 0;
  #closed = false;
  #exited?: ProcessExit;

  constructor(executable: string, request: ValidatedRequest, encoder: Mp4Encoder, ownerId: number) {
    this.ownerId = ownerId;
    this.#request = request;
    this.#encoder = encoder;
    this.#temporaryPath = join(
      dirname(request.outputPath),
      `.aster-export-${process.pid}-${this.jobId}.mp4`,
    );
    this.#child = spawn(executable, buildExportArguments(request, encoder, this.#temporaryPath), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.resume();
    this.#child.stdin.on("error", () => undefined);
    this.#child.stderr.on("data", (chunk: Buffer) => this.#collectStderr(chunk));
    this.#exit = new Promise<ProcessExit>((resolveExit, rejectExit) => {
      this.#child.once("error", rejectExit);
      this.#child.once("exit", (code, signal) => {
        const result = { code, signal };
        this.#exited = result;
        resolveExit(result);
      });
    });
  }

  async write(pixels: ArrayBuffer): Promise<void> {
    if (this.#closed) throw new Error("MP4 export input is already closed");
    if (this.#receivedFrames >= this.#request.frameCount)
      throw new Error("MP4 export received more frames than declared");
    if (pixels.byteLength !== this.#request.frameBytes)
      throw new Error(
        `MP4 frame ${this.#receivedFrames} contained ${pixels.byteLength} bytes; expected ${this.#request.frameBytes}`,
      );
    this.#assertRunning();
    await writeChunk(this.#child, Buffer.from(pixels));
    this.#assertRunning();
    this.#receivedFrames += 1;
  }

  async finish(): Promise<Mp4ExportReport> {
    if (this.#closed) throw new Error("MP4 export input is already closed");
    if (this.#receivedFrames !== this.#request.frameCount)
      throw new Error(
        `MP4 export received ${this.#receivedFrames} frames; expected ${this.#request.frameCount}`,
      );
    this.#closed = true;
    try {
      await closeInput(this.#child);
      const exit = await this.#exit;
      if (exit.code !== 0) throw this.#processError(exit);
      const metadata = await stat(this.#temporaryPath);
      await publishOutput(this.#temporaryPath, this.#request.outputPath);
      return {
        jobId: this.jobId,
        encoder: this.#encoder,
        outputPath: this.#request.outputPath,
        frameCount: this.#receivedFrames,
        bytesWritten: metadata.size,
        elapsedMs: performance.now() - this.#startedAt,
      };
    } catch (error) {
      if (this.#exited === undefined) this.#child.kill();
      await this.#removeTemporary();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#child.stdin.destroy();
      if (this.#exited === undefined) this.#child.kill();
    }
    await Promise.race([
      this.#exit.catch(() => undefined),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, CANCEL_TIMEOUT_MS)),
    ]);
    if (this.#exited === undefined) this.#child.kill("SIGKILL");
    await this.#removeTemporary();
  }

  #assertRunning(): void {
    if (this.#exited !== undefined) throw this.#processError(this.#exited);
  }

  #collectStderr(chunk: Buffer): void {
    if (this.#stderr.length >= MAX_STDERR_BYTES) {
      this.#stderrTruncated = true;
      return;
    }
    const remaining = MAX_STDERR_BYTES - this.#stderr.length;
    this.#stderr = Buffer.concat([this.#stderr, chunk.subarray(0, remaining)]);
    if (chunk.length > remaining) this.#stderrTruncated = true;
  }

  #processError(exit: ProcessExit): Error {
    const details = this.#stderr.toString("utf8").trim();
    const truncated = this.#stderrTruncated ? " [stderr truncated]" : "";
    return new Error(
      `FFmpeg MP4 export failed (${exit.signal ?? `code ${String(exit.code)}`}): ${details || "no diagnostics"}${truncated}`,
    );
  }

  async #removeTemporary(): Promise<void> {
    await rm(this.#temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function validateMp4ExportRequest(value: unknown): Promise<ValidatedRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MP4 export options must be an object");
  const candidate = value as Partial<Mp4ExportStartRequest>;
  const outputPath = candidate.outputPath;
  if (typeof outputPath !== "string" || outputPath.length === 0 || outputPath.includes("\0"))
    throw new Error("MP4 output path is invalid");
  if (extname(outputPath).toLowerCase() !== ".mp4")
    throw new Error("MP4 output path must use the .mp4 extension");
  const width = boundedInteger(candidate.width, "width", 2, MAX_DIMENSION);
  const height = boundedInteger(candidate.height, "height", 2, MAX_DIMENSION);
  if (width % 2 !== 0) throw new Error("MP4 width must be even");
  if (height % 2 !== 0) throw new Error("MP4 height must be even");
  const frameRateNumerator = boundedInteger(
    candidate.frameRateNumerator,
    "frame-rate numerator",
    1,
    1_000_000,
  );
  const frameRateDenominator = boundedInteger(
    candidate.frameRateDenominator,
    "frame-rate denominator",
    1,
    1_000_000,
  );
  const framesPerSecond = frameRateNumerator / frameRateDenominator;
  if (framesPerSecond < 1 || framesPerSecond > 240)
    throw new Error("MP4 frame rate must be between 1 and 240 fps");
  const frameCount = boundedInteger(candidate.frameCount, "frame count", 1, MAX_FRAME_COUNT);
  if (frameCount / framesPerSecond > MAX_DURATION_SECONDS)
    throw new Error("MP4 duration exceeds 24 hours");
  if (candidate.pixelFormat !== "bgra" && candidate.pixelFormat !== "rgba")
    throw new Error("MP4 input pixel format must be BGRA or RGBA");
  const frameBytes = width * height * 4;
  if (!Number.isSafeInteger(frameBytes) || frameBytes > MAX_FRAME_BYTES)
    throw new Error("MP4 frame size exceeds the configured bound");
  const parent = await stat(dirname(outputPath)).catch(() => undefined);
  if (!parent?.isDirectory()) throw new Error("MP4 output parent must be an existing directory");
  const existing = await lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isFile()) throw new Error("MP4 output must be a regular file");
  return {
    outputPath,
    width,
    height,
    frameRateNumerator,
    frameRateDenominator,
    frameCount,
    pixelFormat: candidate.pixelFormat,
    frameBytes,
  };
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`MP4 ${label} must be an integer within ${minimum}..=${maximum}`);
  return value as number;
}

async function selectEncoder(executable: string): Promise<Mp4Encoder> {
  if (await probeEncoder(executable, "h264_nvenc")) return "h264_nvenc";
  if (await probeEncoder(executable, "libx264")) return "libx264";
  throw new Error("FFmpeg has no working H.264 NVENC or libx264 encoder");
}

async function probeEncoder(executable: string, encoder: Mp4Encoder): Promise<boolean> {
  const child = spawn(
    executable,
    [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-video_size",
      "256x256",
      "-framerate",
      "1",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-an",
      "-c:v",
      encoder,
      ...encoderOptions(encoder),
      "-pix_fmt",
      "yuv420p",
      "-f",
      "null",
      "-",
    ],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  const success = new Promise<boolean>((resolveProbe) => {
    child.once("error", () => resolveProbe(false));
    child.once("exit", (code) => resolveProbe(code === 0));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(Buffer.alloc(256 * 256 * 4));
  const timeout = setTimeout(() => child.kill(), ENCODER_PROBE_TIMEOUT_MS);
  try {
    return await success;
  } finally {
    clearTimeout(timeout);
  }
}

function buildExportArguments(
  request: ValidatedRequest,
  encoder: Mp4Encoder,
  temporaryPath: string,
): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-f",
    "rawvideo",
    "-pix_fmt",
    request.pixelFormat,
    "-video_size",
    `${request.width}x${request.height}`,
    "-framerate",
    `${request.frameRateNumerator}/${request.frameRateDenominator}`,
    "-i",
    "pipe:0",
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-c:v",
    encoder,
    ...encoderOptions(encoder),
    "-pix_fmt",
    "yuv420p",
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-bsf:v",
    "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    "-frames:v",
    request.frameCount.toString(),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-n",
    temporaryPath,
  ];
}

function encoderOptions(encoder: Mp4Encoder): string[] {
  return encoder === "h264_nvenc"
    ? ["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
    : ["-preset", "veryfast", "-crf", "18"];
}

function writeChunk(child: ChildProcessWithoutNullStreams, chunk: Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    child.stdin.write(chunk, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function closeInput(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    const onError = (error: Error) => rejectClose(error);
    child.stdin.once("error", onError);
    child.stdin.end(() => {
      child.stdin.off("error", onError);
      resolveClose();
    });
  });
}

async function publishOutput(temporaryPath: string, outputPath: string): Promise<void> {
  const backupPath = `${temporaryPath}.previous`;
  let backedUp = false;
  try {
    await rename(outputPath, backupPath);
    backedUp = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (backedUp) await rename(backupPath, outputPath).catch(() => undefined);
    throw error;
  }
  if (backedUp) await rm(backupPath, { force: true }).catch(() => undefined);
}
