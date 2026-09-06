import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, opendir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Writable } from "node:stream";

const MAX_DIMENSION = 16_384;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_COUNT = 10_000_000;
const MAX_AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const ENCODER_PROBE_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 5_000;
const MIN_VIDEO_BITRATE_BPS = 64_000;
const MAX_VIDEO_BITRATE_BPS = 1_000_000_000;
const PROBE_VIDEO_BITRATE_BPS = 2_000_000;
const MAX_STALE_EXPORT_SCAN_ENTRIES = 4_096;
const STALE_EXPORT_NAME =
  /^\.aster-export-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/i;

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
  videoBitrateBps: number;
  audio?: {
    sampleRate: number;
    channels: 2;
    frameCount: number;
  };
}

export interface Mp4ExportStarted {
  jobId: string;
  encoder: Mp4Encoder;
}

export interface Mp4ExportReport extends Mp4ExportStarted {
  outputPath: string;
  frameCount: number;
  audioFrameCount: number;
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
    await removeStaleMp4ExportFiles(dirname(request.outputPath));
    if (!this.#encoderProbe) this.#encoderProbe = selectEncoder(this.#ffmpegExecutable);
    let encoder: Mp4Encoder;
    try {
      encoder = await this.#encoderProbe;
    } catch (error) {
      this.#encoderProbe = undefined;
      throw error;
    }
    const session = new Mp4ExportSession(this.#ffmpegExecutable, request, encoder, ownerId);
    this.#active = session;
    return { jobId: session.jobId, encoder };
  }

  async write(jobId: unknown, pixels: unknown, ownerId: number): Promise<void> {
    const session = this.#ownedSession(jobId, ownerId);
    if (!(pixels instanceof ArrayBuffer)) throw new Error("MP4 frame must be an ArrayBuffer");
    await session.write(pixels);
  }

  async writeAudio(jobId: unknown, samples: unknown, ownerId: number): Promise<void> {
    const session = this.#ownedSession(jobId, ownerId);
    if (!(samples instanceof ArrayBuffer))
      throw new Error("MP4 audio samples must be an ArrayBuffer");
    await session.writeAudio(samples);
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

/** Removes bounded, recognizable encoder temporaries left by a terminated Aster process. */
export async function removeStaleMp4ExportFiles(
  directory: string,
  activeProcessId = process.pid,
): Promise<void> {
  const entries = await opendir(directory).catch(() => undefined);
  if (!entries) return;
  let scanned = 0;
  for await (const entry of entries) {
    scanned += 1;
    if (scanned > MAX_STALE_EXPORT_SCAN_ENTRIES) break;
    if (!entry.isFile()) continue;
    const match = STALE_EXPORT_NAME.exec(entry.name);
    if (!match || Number(match[1]) === activeProcessId) continue;
    await rm(join(directory, entry.name), { force: true }).catch(() => undefined);
  }
}

class Mp4ExportSession {
  readonly jobId = randomUUID();
  readonly ownerId: number;
  readonly #request: ValidatedRequest;
  readonly #encoder: Mp4Encoder;
  readonly #temporaryPath: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #audioInput?: Writable;
  readonly #exit: Promise<ProcessExit>;
  readonly #startedAt = performance.now();
  #stderr = Buffer.alloc(0);
  #stderrTruncated = false;
  #receivedFrames = 0;
  #receivedAudioFrames = 0;
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
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const auxiliaryInput = this.#child.stdio[3] as Writable;
    this.#audioInput = request.audio ? auxiliaryInput : undefined;
    if (!request.audio) auxiliaryInput.end();
    this.#child.stdout.resume();
    this.#child.stdin.on("error", () => undefined);
    this.#audioInput?.on("error", () => undefined);
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
    await writeChunk(this.#child.stdin, Buffer.from(pixels));
    this.#assertRunning();
    this.#receivedFrames += 1;
    if (this.#receivedFrames === this.#request.frameCount) this.#child.stdin.end();
  }

  async writeAudio(samples: ArrayBuffer): Promise<void> {
    if (this.#closed) throw new Error("MP4 export input is already closed");
    const audio = this.#request.audio;
    const input = this.#audioInput;
    if (!audio || !input) throw new Error("MP4 export was not configured for audio");
    if (
      samples.byteLength === 0 ||
      samples.byteLength > MAX_AUDIO_CHUNK_BYTES ||
      samples.byteLength % (audio.channels * Float32Array.BYTES_PER_ELEMENT) !== 0
    )
      throw new Error("MP4 audio chunk must contain bounded interleaved Float32 stereo samples");
    const frames = samples.byteLength / (audio.channels * Float32Array.BYTES_PER_ELEMENT);
    if (this.#receivedAudioFrames + frames > audio.frameCount)
      throw new Error("MP4 export received more audio frames than declared");
    this.#assertRunning();
    await writeChunk(input, Buffer.from(samples));
    this.#assertRunning();
    this.#receivedAudioFrames += frames;
    // FFmpeg may probe this input before draining video. Signal EOF as soon as the declared
    // samples arrive, rather than waiting for finish() and deadlocking short audiovisual exports.
    if (this.#receivedAudioFrames === audio.frameCount) input.end();
  }

  async finish(): Promise<Mp4ExportReport> {
    if (this.#closed) throw new Error("MP4 export input is already closed");
    if (this.#receivedFrames !== this.#request.frameCount)
      throw new Error(
        `MP4 export received ${this.#receivedFrames} frames; expected ${this.#request.frameCount}`,
      );
    if (this.#request.audio && this.#receivedAudioFrames !== this.#request.audio.frameCount)
      throw new Error(
        `MP4 export received ${this.#receivedAudioFrames} audio frames; expected ${this.#request.audio.frameCount}`,
      );
    this.#closed = true;
    try {
      await Promise.all([
        closeInput(this.#child.stdin),
        this.#audioInput ? closeInput(this.#audioInput) : Promise.resolve(),
      ]);
      const exit = await this.#exit;
      if (exit.code !== 0) throw this.#processError(exit);
      const metadata = await stat(this.#temporaryPath);
      await publishOutput(this.#temporaryPath, this.#request.outputPath);
      return {
        jobId: this.jobId,
        encoder: this.#encoder,
        outputPath: this.#request.outputPath,
        frameCount: this.#receivedFrames,
        audioFrameCount: this.#receivedAudioFrames,
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
      this.#audioInput?.destroy();
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
  const videoBitrateBps = boundedInteger(
    candidate.videoBitrateBps,
    "video bitrate",
    MIN_VIDEO_BITRATE_BPS,
    MAX_VIDEO_BITRATE_BPS,
  );
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
  let audio: ValidatedRequest["audio"];
  if (candidate.audio !== undefined) {
    if (!candidate.audio || typeof candidate.audio !== "object" || Array.isArray(candidate.audio))
      throw new Error("MP4 audio options must be an object");
    const sampleRate = boundedInteger(
      candidate.audio.sampleRate,
      "audio sample rate",
      8_000,
      192_000,
    );
    if (candidate.audio.channels !== 2) throw new Error("MP4 audio must use interleaved stereo");
    const audioFrameCount = boundedInteger(
      candidate.audio.frameCount,
      "audio frame count",
      1,
      Math.ceil(MAX_DURATION_SECONDS * sampleRate),
    );
    const expectedAudioFrames = Math.round(
      (frameCount / frameRateNumerator) * frameRateDenominator * sampleRate,
    );
    if (audioFrameCount !== expectedAudioFrames)
      throw new Error(
        `MP4 audio frame count must align to the rational video duration (${expectedAudioFrames})`,
      );
    audio = { sampleRate, channels: 2, frameCount: audioFrameCount };
  }
  return {
    outputPath,
    width,
    height,
    frameRateNumerator,
    frameRateDenominator,
    frameCount,
    pixelFormat: candidate.pixelFormat,
    videoBitrateBps,
    frameBytes,
    audio,
  };
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`MP4 ${label} must be an integer within ${minimum}..=${maximum}`);
  return value as number;
}

export async function selectEncoder(executable: string): Promise<Mp4Encoder> {
  await assertFfmpegAvailable(executable);
  if (await probeEncoder(executable, "h264_nvenc")) return "h264_nvenc";
  if (await probeEncoder(executable, "libx264")) return "libx264";
  throw new Error("FFmpeg has no working H.264 NVENC or libx264 encoder");
}

async function assertFfmpegAvailable(executable: string): Promise<void> {
  const child = spawn(executable, ["-hide_banner", "-version"], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  await new Promise<void>((resolveAvailable, rejectAvailable) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(() => {
      child.kill();
      settle(() =>
        rejectAvailable(
          new Error(
            `FFmpeg availability check timed out (${executable}). Verify the executable or set ASTER_FFMPEG_PATH.`,
          ),
        ),
      );
    }, ENCODER_PROBE_TIMEOUT_MS);
    child.once("error", (error: NodeJS.ErrnoException) => {
      const guidance =
        "Install FFmpeg, set ASTER_FFMPEG_PATH, or rebuild the application with a bundled FFmpeg executable.";
      settle(() =>
        rejectAvailable(
          new Error(
            error.code === "ENOENT"
              ? `FFmpeg executable was not found (${executable}). ${guidance}`
              : `FFmpeg could not be started (${executable}): ${error.message}. ${guidance}`,
          ),
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) settle(resolveAvailable);
      else
        settle(() =>
          rejectAvailable(
            new Error(
              `FFmpeg availability check failed (${executable}, ${signal ?? `exit ${String(code)}`}). Verify the executable or set ASTER_FFMPEG_PATH.`,
            ),
          ),
        );
    });
  });
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
      ...encoderOptions(encoder, PROBE_VIDEO_BITRATE_BPS),
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

export function buildExportArguments(
  request: ValidatedRequest,
  encoder: Mp4Encoder,
  temporaryPath: string,
): string[] {
  const audioInput = request.audio
    ? [
        "-f",
        "f32le",
        "-ar",
        request.audio.sampleRate.toString(),
        "-ac",
        request.audio.channels.toString(),
        "-i",
        "pipe:3",
      ]
    : [];
  const audioOutput = request.audio
    ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-ar", request.audio.sampleRate.toString()]
    : ["-an"];
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
    ...audioInput,
    "-map",
    "0:v:0",
    ...audioOutput,
    "-sn",
    "-dn",
    "-c:v",
    encoder,
    ...encoderOptions(encoder, request.videoBitrateBps),
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

function encoderOptions(encoder: Mp4Encoder, videoBitrateBps: number): string[] {
  const maximumBitrateBps = videoBitrateBps;
  const bufferSizeBps = Math.min(MAX_VIDEO_BITRATE_BPS * 2, videoBitrateBps * 2);
  const rateControl = [
    "-b:v",
    videoBitrateBps.toString(),
    "-maxrate",
    maximumBitrateBps.toString(),
    "-bufsize",
    bufferSizeBps.toString(),
  ];
  return encoder === "h264_nvenc"
    ? ["-preset", "p4", "-tune", "hq", "-rc", "vbr", ...rateControl]
    : ["-preset", "veryfast", ...rateControl];
}

function writeChunk(input: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    input.write(chunk, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function closeInput(input: Writable): Promise<void> {
  if (input.writableEnded) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    const onError = (error: Error) => rejectClose(error);
    input.once("error", onError);
    input.end(() => {
      input.off("error", onError);
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
