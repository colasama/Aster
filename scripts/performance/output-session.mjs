import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hashFile } from "../migration/source.mjs";

const runFile = promisify(execFile);

export async function probeOutput(executable, path, request, timeoutMs = 120_000) {
  const args = [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ];
  const { stdout, stderr } = await runFile(executable, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (stderr.trim()) throw new Error(`FFprobe diagnostic: ${stderr.trim()}`);
  const result = JSON.parse(stdout);
  validateProbe(result, request);
  const metadata = await stat(path);
  return {
    command: [executable, ...args],
    result,
    bytes: metadata.size,
    sha256: await hashFile(path),
  };
}

export function validateProbe(result, request) {
  const streams = result?.streams;
  if (!Array.isArray(streams)) throw new Error("FFprobe returned no streams");
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const video = videos[0];
  if (
    videos.length !== 1 ||
    audios.length !== (request.audio ? 1 : 0) ||
    streams.length !== videos.length + audios.length
  )
    throw new Error("FFprobe stream counts do not match the export");
  if (
    video.codec_name !== "h264" ||
    video.width !== request.width ||
    video.height !== request.height ||
    Number(video.nb_read_frames) !== request.frameCount
  )
    throw new Error("FFprobe video codec, dimensions or frame count mismatch");
  const rate = /^(\d+)\/(\d+)$/.exec(video.avg_frame_rate ?? "");
  if (
    !rate ||
    Number(rate[2]) === 0 ||
    Number(rate[1]) * request.frameRateDenominator !== Number(rate[2]) * request.frameRateNumerator
  )
    throw new Error("FFprobe rational frame rate mismatch");
  const duration = (request.frameCount * request.frameRateDenominator) / request.frameRateNumerator;
  const tolerance = Math.max(request.frameRateDenominator / request.frameRateNumerator, 0.003);
  if (
    !Number.isFinite(Number(video.duration)) ||
    Math.abs(Number(video.duration) - duration) > tolerance
  )
    throw new Error("FFprobe video duration mismatch");
  if (request.audio) {
    const audio = audios[0];
    if (
      audio.codec_name !== "aac" ||
      Number(audio.sample_rate) !== request.audio.sampleRate ||
      audio.channels !== request.audio.channels
    )
      throw new Error("FFprobe audio format mismatch");
    if (
      !Number.isFinite(Number(audio.duration)) ||
      Math.abs(Number(audio.duration) - duration) >
        Math.max(tolerance, 2048 / request.audio.sampleRate)
    )
      throw new Error("FFprobe audio duration mismatch");
  }
  if (
    !Number.isFinite(Number(result.format?.duration)) ||
    Math.abs(Number(result.format.duration) - duration) >
      Math.max(tolerance, request.audio ? 2048 / request.audio.sampleRate : 0)
  )
    throw new Error("FFprobe container duration mismatch");
}

/** Measures the production output boundary without substituting an encoder or IPC transport. */
export class PerformanceOutputSession {
  #assignment;
  #manager;
  #ownerId;
  #directory;
  #probe;
  #state = "idle";
  #request;
  #job;
  #pending = new Set();
  #failed;

  constructor(assignment, options) {
    if (
      !["readback-only", "ipc-no-encode", "full-mp4"].includes(assignment?.benchmark?.mode) ||
      !Number.isSafeInteger(assignment.benchmark.run) ||
      assignment.benchmark.run < 0 ||
      !Number.isSafeInteger(options.index) ||
      options.index < 0
    )
      throw new Error("Invalid benchmark output identity");
    this.#assignment = assignment;
    this.#manager = options.manager;
    this.#ownerId = options.ownerId;
    this.#directory = join(
      resolve(options.runDirectory),
      "outputs",
      `${options.index}-${assignment.benchmark.mode}-run${assignment.benchmark.run}`,
    );
    this.#probe =
      options.probe ??
      ((path, request) => probeOutput(options.ffprobe, path, request, options.timeoutMs));
    this.report = {
      mode: assignment.benchmark.mode,
      encoder: null,
      videoFrames: 0,
      videoBytes: 0,
      audioChunks: 0,
      audioFrames: 0,
      audioBytes: 0,
      outputCalls: 0,
      outputPath: null,
      ffprobe: null,
    };
  }

  async output(payload) {
    const benchmark = this.#assignment.benchmark;
    if (benchmark.mode === "readback-only")
      throw new Error("Readback-only must not invoke the output IPC");
    if (this.#failed) throw this.#failed;
    if (
      payload?.jobId !== benchmark.id ||
      payload.leaseId !== `benchmark-${benchmark.run}` ||
      payload.outputId !== "mp4"
    )
      throw new Error("Output request does not belong to the active benchmark lease");
    this.report.outputCalls += 1;
    try {
      if (payload.type === "startMp4") return await this.#start(payload);
      if (this.#state !== "started") throw new Error("Output session is not accepting data");
      if (payload.type === "finishMp4") return await this.#finish();
      if (!["writeMp4Frame", "writeMp4Audio"].includes(payload.type))
        throw new Error("Unsupported performance output request");
      if (this.#pending.has(payload.type))
        throw new Error("Concurrent writes to the same output pipe are forbidden");
      this.#pending.add(payload.type);
      try {
        return await this.#write(payload);
      } finally {
        this.#pending.delete(payload.type);
      }
    } catch (error) {
      this.#failed = error;
      throw error;
    }
  }

  async #start(payload) {
    if (this.#state !== "idle") throw new Error("Output session was already started");
    this.#state = "starting";
    const { benchmark, case: item } = this.#assignment;
    const { numerator, denominator } = benchmark.frameRate ?? {};
    const frameCount = benchmark.endFrameExclusive - benchmark.startFrame;
    if (
      ![numerator, denominator, item.size.width, item.size.height, frameCount].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error("Invalid benchmark dimensions, duration or rational rate");
    if (!["bgra", "rgba"].includes(payload.pixelFormat) || payload.videoBitrateBps !== 20_000_000)
      throw new Error("Performance output requires production RGBA/BGRA at 20 Mbps");
    const audio = payload.audio;
    if ((benchmark.requireAudio && !audio) || (benchmark.mode !== "full-mp4" && audio))
      throw new Error("Output audio configuration does not match the benchmark workload");
    if (
      audio &&
      (audio.sampleRate !== 48_000 ||
        audio.channels !== 2 ||
        audio.frameCount !== Math.round(((frameCount * denominator) / numerator) * 48_000))
    )
      throw new Error("Audio must be duration-aligned 48 kHz stereo PCM");
    this.#request = {
      width: item.size.width,
      height: item.size.height,
      frameRateNumerator: numerator,
      frameRateDenominator: denominator,
      frameCount,
      pixelFormat: payload.pixelFormat,
      videoBitrateBps: payload.videoBitrateBps,
      ...(audio ? { audio: { ...audio } } : {}),
    };
    this.report.videoBitrateBps = payload.videoBitrateBps;
    if (benchmark.mode === "full-mp4") {
      await mkdir(join(this.#directory, ".."), { recursive: true });
      // A fresh private directory prevents the production publisher from replacing user output.
      await mkdir(this.#directory);
      const outputPath = join(this.#directory, "output.mp4");
      this.#request.outputPath = outputPath;
      this.#job = await this.#manager.start(this.#request, this.#ownerId);
      this.report.encoder = this.#job.encoder;
      this.report.outputPath = outputPath;
    } else if (benchmark.mode !== "ipc-no-encode") throw new Error("Unknown benchmark output mode");
    if (this.#state === "cancelled") {
      await this.#manager.cancelOwner(this.#ownerId);
      throw new Error("Output start expired during cancellation");
    }
    this.#state = "started";
    return { jobId: benchmark.id, encoder: this.report.encoder };
  }

  async #write(payload) {
    if (payload.type === "writeMp4Frame") {
      if (
        !(payload.pixels instanceof ArrayBuffer) ||
        payload.pixels.byteLength !== this.#request.width * this.#request.height * 4
      )
        throw new Error("Video IPC must contain one packed 4-byte pixel frame");
      if (this.report.videoFrames >= this.#request.frameCount)
        throw new Error("Too many video frames");
      if (this.#job) await this.#manager.write(this.#job.jobId, payload.pixels, this.#ownerId);
      if (this.#state !== "started") throw new Error("Video output expired during write");
      this.report.videoFrames += 1;
      this.report.videoBytes += payload.pixels.byteLength;
    } else {
      const audio = this.#request.audio;
      if (
        !audio ||
        !(payload.samples instanceof ArrayBuffer) ||
        payload.samples.byteLength === 0 ||
        payload.samples.byteLength > 8 * 1024 * 1024 ||
        payload.samples.byteLength % 8 !== 0
      )
        throw new Error("Audio IPC must contain bounded interleaved stereo Float32 samples");
      const frames = payload.samples.byteLength / 8;
      if (this.report.audioFrames + frames > audio.frameCount)
        throw new Error("Too many audio frames");
      if (this.#job)
        await this.#manager.writeAudio(this.#job.jobId, payload.samples, this.#ownerId);
      if (this.#state !== "started") throw new Error("Audio output expired during write");
      this.report.audioChunks += 1;
      this.report.audioFrames += frames;
      this.report.audioBytes += payload.samples.byteLength;
    }
    return { acknowledged: true };
  }

  async #finish() {
    if (this.#pending.size) throw new Error("Cannot finish while output writes are pending");
    if (
      this.report.videoFrames !== this.#request.frameCount ||
      this.report.audioFrames !== (this.#request.audio?.frameCount ?? 0)
    )
      throw new Error("Output finished with missing video or audio frames");
    this.#state = "finishing";
    let result = { frameCount: this.report.videoFrames, audioFrameCount: this.report.audioFrames };
    if (this.#job) {
      result = await this.#manager.finish(this.#job.jobId, this.#ownerId);
      this.report.encoderReport = result;
      if (
        result.frameCount !== this.report.videoFrames ||
        result.audioFrameCount !== this.report.audioFrames ||
        result.outputPath !== this.#request.outputPath ||
        result.encoder !== this.#job.encoder
      )
        throw new Error("Encoder report disagrees with independently checked output");
    }
    if (this.#state !== "finishing") throw new Error("Output expired during finalization");
    this.#state = "finished";
    return result;
  }

  assertComplete() {
    if (this.#failed) throw this.#failed;
    if (this.#assignment.benchmark.mode === "readback-only") {
      if (this.report.outputCalls !== 0) throw new Error("Readback-only emitted output IPC");
    } else if (this.#state !== "finished") throw new Error("Benchmark output was not finalized");
  }

  async verify() {
    this.assertComplete();
    if (this.#job) {
      this.report.ffprobe = await this.#probe(this.#request.outputPath, this.#request);
      if (this.report.encoderReport.bytesWritten !== this.report.ffprobe.bytes)
        throw new Error("Encoder byte count disagrees with FFprobe output");
    }
    return this.report;
  }

  async cancel() {
    this.#state = "cancelled";
    await this.#manager.cancelOwner(this.#ownerId);
  }
}

export function validatePerformanceResult(assignment, result, output, adapter) {
  const { benchmark, case: item } = assignment;
  const frames = benchmark.endFrameExclusive - benchmark.startFrame;
  if (
    result?.schemaVersion !== 1 ||
    result.id !== benchmark.id ||
    result.benchmarkId !== benchmark.id ||
    result.caseId !== item.id ||
    result.mode !== benchmark.mode ||
    result.run !== benchmark.run
  )
    throw new Error("Performance completion does not match the active assignment");
  if (
    result.frames !== frames ||
    result.startFrame !== benchmark.startFrame ||
    result.endFrameExclusive !== benchmark.endFrameExclusive ||
    result.width !== item.size.width ||
    result.height !== item.size.height ||
    result.warmupFrames !== benchmark.warmupFrames
  )
    throw new Error("Performance completion dimensions or frame domain mismatch");
  if (
    result.frameRate?.numerator !== benchmark.frameRate.numerator ||
    result.frameRate?.denominator !== benchmark.frameRate.denominator
  )
    throw new Error("Performance completion rational rate mismatch");
  const maximumInFlight = result.synchronizeVideo
    ? 1
    : Math.min(
        3,
        Math.max(1, Math.floor((64 * 1024 * 1024) / (item.size.width * item.size.height * 4))),
      );
  if (
    !["rgba", "bgra"].includes(result.pixelFormat) ||
    typeof result.synchronizeVideo !== "boolean" ||
    !Number.isSafeInteger(result.maxInFlight) ||
    result.maxInFlight < 1 ||
    result.maxInFlight > maximumInFlight
  )
    throw new Error("Performance completion did not use a bounded synchronized production loop");
  if (
    ![result.elapsedMs, result.framesPerSecond].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    Math.abs(result.framesPerSecond - (frames * 1000) / result.elapsedMs) > 1e-6
  )
    throw new Error("Performance elapsed time and throughput disagree");
  for (const field of ["loadMs", "initializeMs"]) {
    if (!Number.isFinite(result[field]) || result[field] < 0) throw new Error(`Invalid ${field}`);
  }
  for (const field of ["frameCompletionIntervalsMs", "readbackWallLatenciesMs"]) {
    if (
      !Array.isArray(result[field]) ||
      result[field].length !== frames ||
      result[field].some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error(`Missing or invalid ${field}`);
  }
  const diagnostics = result.diagnostics;
  const expectedDescription = `${adapter.vendor || "GPU"} · ${adapter.description || adapter.device || "WebGPU"}`;
  if (
    diagnostics?.available !== true ||
    diagnostics.description !== expectedDescription ||
    [
      "materialResourceError",
      "adjustmentLayerError",
      "precompositionSurfaceError",
      "sceneGeneratorError",
    ].some((key) => diagnostics[key])
  )
    throw new Error("Performance renderer diagnostics failed or adapter changed");
  const calls = result.outputInvokeLatenciesMs;
  if (
    !Array.isArray(calls) ||
    calls.some((entry) => !Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0)
  )
    throw new Error("Invalid output invocation timings");
  const audio = result.audio;
  if ((benchmark.requireAudio && !audio) || (benchmark.mode !== "full-mp4" && audio !== null))
    throw new Error("Performance audio configuration does not match the benchmark workload");
  const expectedAudioFrames = Math.round(
    ((frames * benchmark.frameRate.denominator) / benchmark.frameRate.numerator) * 48_000,
  );
  if (
    audio !== null &&
    (audio?.enabled !== true ||
      audio.sampleRate !== 48_000 ||
      audio.channels !== 2 ||
      audio.frameCount !== expectedAudioFrames)
  )
    throw new Error("Performance audio does not cover the video duration");
  if (benchmark.mode === "readback-only") {
    if (calls.length || output.outputCalls) throw new Error("Readback-only invoked output IPC");
  } else {
    const count = (type) => calls.filter((entry) => entry.type === type).length;
    if (
      calls.length !== output.outputCalls ||
      count("startMp4") !== 1 ||
      count("finishMp4") !== 1 ||
      count("writeMp4Frame") !== frames ||
      count("writeMp4Audio") !== output.audioChunks ||
      output.videoFrames !== frames ||
      output.videoBytes !== frames * item.size.width * item.size.height * 4 ||
      output.audioFrames !== (audio?.frameCount ?? 0) ||
      output.audioBytes !== (audio?.frameCount ?? 0) * 8
    )
      throw new Error("Performance timings disagree with actual output IPC counts");
  }
}

export function normalizePerformanceIdentity(value) {
  const adapter = {};
  for (const key of ["vendor", "architecture", "device", "description"]) {
    if (typeof value?.[key] !== "string") throw new Error("Invalid WebGPU adapter identity");
    adapter[key] = value[key];
  }
  if (value.isFallbackAdapter !== undefined) {
    if (typeof value.isFallbackAdapter !== "boolean")
      throw new Error("Invalid fallback adapter flag");
    adapter.isFallbackAdapter = value.isFallbackAdapter;
  }
  const fonts = value.fonts;
  if (
    fonts?.status === "available" &&
    /^[a-f0-9]{64}$/.test(fonts.sha256) &&
    Number.isSafeInteger(fonts.count) &&
    fonts.count >= 0
  )
    return { adapter, fonts: { status: fonts.status, sha256: fonts.sha256, count: fonts.count } };
  if (fonts?.status === "unavailable" && typeof fonts.reason === "string")
    return { adapter, fonts: { status: fonts.status, reason: fonts.reason } };
  throw new Error("A valid system-font identity is required");
}

export async function publishPerformanceReport(directory, report) {
  const output = join(directory, "report.json");
  const lockPath = join(directory, ".report.lock");
  const lock = await open(lockPath, "wx");
  const temporary = join(directory, `.report-${randomUUID()}.json`);
  try {
    if (
      await lstat(output).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      throw new Error("Performance report already exists");
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
