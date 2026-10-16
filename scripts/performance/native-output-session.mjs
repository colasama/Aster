import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { probeOutput } from "./output-session.mjs";

/** Benchmark adapter around the production whole-job route, retaining native-only provenance. */
export class NativePerformanceOutputSession {
  #assignment;
  #options;
  #host;
  #state = "new";
  #busy = false;
  #warmups = 0;
  #audio;
  #manifest;
  #firstAdmissionAt;
  report = {
    renderer: "rust",
    outputCalls: 0,
    calls: [],
    videoFrames: 0,
    admittedFrames: 0,
    audioFrames: 0,
    audioBytes: 0,
    audioChunks: 0,
    warmupFrames: 0,
  };

  constructor(assignment, options) {
    assert.equal(assignment.benchmark.renderer, "rust");
    assert.equal(assignment.benchmark.mode, "full-mp4");
    this.#assignment = assignment;
    this.#options = options;
    this.report.outputPath = join(
      options.runDirectory,
      "outputs",
      `${options.index}-full-mp4-run${assignment.benchmark.run}`,
      "output.mp4",
    );
    this.report.temporaryRoot = join(options.runDirectory, `native-private-${options.index}`);
  }

  async prepare(value) {
    assert.equal(this.#state, "new");
    this.#state = "preparing";
    const manifest = structuredClone(value);
    const { benchmark, case: item } = this.#assignment;
    for (const [key, expected] of Object.entries({
      id: benchmark.id,
      projectRevision: 0,
      width: item.size.width,
      height: item.size.height,
      antiAliasing: item.aa,
      startFrame: benchmark.startFrame,
      endFrameExclusive: benchmark.endFrameExclusive,
      frameRate: benchmark.frameRate,
    }))
      assert.deepEqual(manifest[key], expected, key);
    assert(
      typeof manifest.projectSnapshot === "string" &&
        manifest.projectSnapshot.length <= 96 * 1024 * 1024,
    );
    assert(
      typeof manifest.renderMediaSnapshot === "string" &&
        manifest.renderMediaSnapshot.length <= 96 * 1024 * 1024,
    );
    assert.deepEqual(manifest.outputs, [
      {
        id: "mp4",
        kind: "mp4",
        destination: `${benchmark.id}.mp4`,
        codec: "h264",
        bitrateMbps: 20,
        includeAudio: true,
      },
    ]);
    const project = JSON.parse(manifest.projectSnapshot);
    assert(project.compositions.some((c) => c.id === manifest.compositionId));
    this.#manifest = manifest;
    this.report.manifest_sha256 = createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex");
    await mkdir(join(this.report.outputPath, ".."), { recursive: true });
    this.#host = new this.#options.NativeRenderHostExport({
      manifest,
      runtime: { ...this.#options.runtime, temporaryRoot: this.report.temporaryRoot },
      ffmpeg: this.#options.ffmpeg,
      authorizedPaths: () => [...this.#options.allowedAssets.values()],
      outputPath: () => this.report.outputPath,
      report: (decision, transport) => {
        assert.equal(decision.accepted, true, decision.reason);
        this.report.transport = transport;
      },
    });
    const decision = await this.#host.output({ type: "prepareNative", outputId: "mp4" });
    assert.equal(decision.handled, true);
    assert.deepEqual(decision.value, { accepted: true, reason: null });
    assert.equal(this.#state, "preparing");
    this.#state = "warmup";
  }

  async warm(frame, packet) {
    assert.equal(this.#state, "warmup");
    assert(!this.#busy && this.#warmups < 10);
    this.#busy = true;
    try {
      assert.deepEqual(await this.#host.warm(frame, packet), { accepted: true, reason: null });
      assert.equal(this.#state, "warmup");
      this.report.warmupFrames = ++this.#warmups;
    } finally {
      this.#busy = false;
    }
  }

  async output(value) {
    const request = this.#options.parseRenderHostOutputRequest(value);
    const { benchmark } = this.#assignment;
    assert.equal(request.jobId, benchmark.id);
    assert.equal(request.leaseId, `benchmark-${benchmark.run}`);
    assert.equal(request.outputId, "mp4");
    const frames = benchmark.endFrameExclusive - benchmark.startFrame;
    if (request.type === "prepareNative") {
      assert.equal(this.#state, "warmup");
      assert(!this.#busy && this.#warmups === 10);
      this.#state = "measured";
      this.report.calls.push(request.type);
      this.report.outputCalls++;
      return { accepted: true, reason: null };
    }
    assert.equal(this.#state, "measured");
    assert(
      [
        "admitNative",
        "sealNative",
        "startMp4",
        "renderNativeFrame",
        "writeMp4Audio",
        "finishMp4",
      ].includes(request.type),
      `Native benchmark cannot fallback or write raw video: ${request.type}${request.type === "abandonNative" ? `: ${request.reason}` : ""}`,
    );
    if (request.type === "startMp4") {
      assert.equal(request.videoBitrateBps, 20_000_000);
      this.report.videoBitrateBps = request.videoBitrateBps;
      if (benchmark.requireAudio) assert(request.audio, "Owner workload requires audio");
      this.#audio = request.audio;
    }
    if (request.type === "admitNative") this.#firstAdmissionAt ??= performance.now();
    const response = await this.#host.output(request);
    assert.equal(response.handled, true);
    if (["admitNative", "sealNative"].includes(request.type))
      assert.deepEqual(response.value, { accepted: true, reason: null });
    if (request.type === "admitNative") this.report.admittedFrames++;
    if (request.type === "renderNativeFrame") this.report.videoFrames++;
    if (request.type === "writeMp4Audio") {
      this.report.audioChunks++;
      this.report.audioBytes += request.samples.byteLength;
      this.report.audioFrames += request.samples.byteLength / 8;
    }
    this.report.calls.push(request.type);
    this.report.outputCalls++;
    if (request.type === "finishMp4") {
      this.report.observedWorkMs = performance.now() - this.#firstAdmissionAt;
      assert.equal(this.report.admittedFrames, frames);
      assert.equal(this.report.videoFrames, frames);
      assert.equal(this.report.audioFrames, this.#audio?.frameCount ?? 0);
      this.report.encoderReport = response.value;
      assert.equal(response.value.frameCount, frames);
      assert.equal(response.value.encoder, "h264_mf");
      assert.equal(response.value.nativeEncoder.accepted_frames, frames);
      assert.equal(response.value.nativeEncoder.encoded_frames, frames);
      assert.equal(response.value.nativeEncoder.drain_completed, true);
      assert.equal(this.report.transport.warmup.frames, 10);
      this.#state = "finished";
    }
    return response.value;
  }

  validate(result, adapter) {
    assert.equal(this.#state, "finished");
    const { benchmark, case: item } = this.#assignment;
    const frames = benchmark.endFrameExclusive - benchmark.startFrame;
    for (const [key, expected] of Object.entries({
      schemaVersion: 1,
      renderer: "rust",
      id: benchmark.id,
      benchmarkId: benchmark.id,
      caseId: item.id,
      mode: "full-mp4",
      run: benchmark.run,
      frames,
      startFrame: benchmark.startFrame,
      endFrameExclusive: benchmark.endFrameExclusive,
      width: item.size.width,
      height: item.size.height,
      frameRate: benchmark.frameRate,
      warmupFrames: 10,
      maxInFlight: 1,
    }))
      assert.deepEqual(result[key], expected, key);
    assert(["rgba", "bgra"].includes(result.pixelFormat));
    assert.equal(typeof result.synchronizeVideo, "boolean");
    assert(Number.isFinite(result.elapsedMs) && result.elapsedMs > 0);
    assert(
      result.elapsedMs + 1 >= this.report.observedWorkMs,
      "Reported interval omitted observed admission/encode/mux work",
    );
    assert(Math.abs(result.framesPerSecond - (frames * 1000) / result.elapsedMs) < 1e-6);
    for (const key of ["loadMs", "initializeMs"])
      assert(Number.isFinite(result[key]) && result[key] >= 0);
    for (const key of ["frameCompletionIntervalsMs", "planWallLatenciesMs"]) {
      assert.equal(result[key]?.length, frames);
      assert(Array.from(result[key]).every((n) => Number.isFinite(n) && n >= 0));
    }
    assert(
      result.frameCompletionIntervalsMs.reduce((a, b) => a + b, 0) <= result.elapsedMs + 0.001,
    );
    assert.deepEqual(
      result.outputInvokeLatenciesMs.map((c) => c.type),
      this.report.calls,
    );
    assert(
      result.outputInvokeLatenciesMs.every((c) => Number.isFinite(c.elapsedMs) && c.elapsedMs >= 0),
    );
    assert.deepEqual(result.audio, this.#audio ? { enabled: true, ...this.#audio } : null);
    assert.equal(result.diagnostics?.available, true);
    assert.equal(
      result.diagnostics.description,
      `${adapter.vendor || "GPU"} · ${adapter.description || adapter.device || "WebGPU"}`,
    );
    for (const key of [
      "materialResourceError",
      "adjustmentLayerError",
      "precompositionSurfaceError",
      "sceneGeneratorError",
    ])
      assert(!result.diagnostics[key]);
  }

  async verify() {
    assert.equal(this.#state, "finished");
    const m = this.#manifest;
    this.report.ffprobe = await probeOutput(this.#options.ffprobe, this.report.outputPath, {
      width: m.width,
      height: m.height,
      frameCount: m.endFrameExclusive - m.startFrame,
      frameRateNumerator: m.frameRate.numerator,
      frameRateDenominator: m.frameRate.denominator,
      ...(this.#audio ? { audio: this.#audio } : {}),
    });
    assert.equal(this.report.encoderReport.bytesWritten, this.report.ffprobe.bytes);
    assert.deepEqual(await readdir(this.report.temporaryRoot), []);
    return this.report;
  }

  async cancel() {
    this.#state = "cancelled";
    await this.#host?.dispose();
  }
}
