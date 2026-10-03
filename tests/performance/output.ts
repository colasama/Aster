import type { DesktopRenderHostOutputRequest, Mp4PixelFormat } from "../../src/desktop/api";
import type { PerformanceAssignment, PerformanceResult } from "./protocol";

/** Validates the same frame stream in every arm; the local arm never crosses IPC. */
export class PerformanceOutput {
  #started = false;
  #finished = false;
  #frames = 0;
  #audioFrames = 0;
  audio: PerformanceResult["audio"] = null;

  constructor(
    private readonly assignment: PerformanceAssignment,
    private readonly pixelFormat: Mp4PixelFormat,
  ) {}

  accept(request: DesktopRenderHostOutputRequest): void {
    const { benchmark } = this.assignment;
    if (
      request.jobId !== benchmark.id ||
      request.leaseId !== `benchmark-${benchmark.run}` ||
      request.outputId !== "mp4"
    )
      throw new Error("Benchmark output correlation differs");
    if (this.#finished) throw new Error("Output arrived after benchmark finish");
    if (request.type === "startMp4") {
      if (this.#started) throw new Error("Benchmark output started twice");
      if (request.pixelFormat !== this.pixelFormat || request.videoBitrateBps !== 20_000_000)
        throw new Error("Benchmark output format differs");
      if (benchmark.requireAudio && !request.audio)
        throw new Error("Benchmark requires an audible production audio stream");
      if (request.audio) {
        if (benchmark.mode !== "full-mp4") throw new Error("Only MP4 benchmarks may include audio");
        this.audio = { enabled: true, ...request.audio };
      }
      this.#started = true;
      return;
    }
    if (!this.#started) throw new Error("Benchmark output has not started");
    if (request.type === "writeMp4Frame") {
      const { width, height } = this.assignment.case.size;
      if (
        !(request.pixels instanceof ArrayBuffer) ||
        request.pixels.byteLength !== width * height * 4
      )
        throw new Error("Benchmark output contains a malformed frame");
      if (++this.#frames > benchmark.endFrameExclusive - benchmark.startFrame)
        throw new Error("Benchmark output contains too many frames");
      return;
    }
    if (request.type === "writeMp4Audio") {
      if (
        !this.audio ||
        !(request.samples instanceof ArrayBuffer) ||
        request.samples.byteLength % 8
      )
        throw new Error("Benchmark output contains malformed audio");
      this.#audioFrames += request.samples.byteLength / 8;
      if (this.#audioFrames > this.audio.frameCount)
        throw new Error("Benchmark output contains too much audio");
      return;
    }
    if (request.type !== "finishMp4") throw new Error("Unexpected benchmark PNG output");
    this.assertCounts();
    this.#finished = true;
  }

  assertComplete(): void {
    if (!this.#finished) throw new Error("Benchmark output did not finish");
    this.assertCounts();
  }

  private assertCounts(): void {
    const { startFrame, endFrameExclusive } = this.assignment.benchmark;
    if (this.#frames !== endFrameExclusive - startFrame)
      throw new Error("Benchmark output frame count is incomplete");
    if (this.#audioFrames !== (this.audio?.frameCount ?? 0))
      throw new Error("Benchmark output audio count is incomplete");
  }
}
