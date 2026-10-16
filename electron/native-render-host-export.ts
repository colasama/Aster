import type {
  NativeExportDecision,
  NativeFramePacket,
} from "../src/core/rendering/native-export-protocol.js";
import type { RenderJobManifest } from "../src/core/rendering/render-queue.js";
import { NativeExportJob, type NativeExportJobOptions } from "./native-export-job.js";
import type { RenderHostOutputRequest } from "./render-queue-host-protocol.js";

export type NativeRenderRuntime = Pick<
  NativeExportJobOptions,
  "binary" | "compiler" | "ffprobe" | "temporaryRoot"
>;
interface NativeHostOptions {
  manifest: RenderJobManifest;
  runtime?: NativeRenderRuntime;
  ffmpeg: string;
  authorizedPaths(): readonly string[];
  outputPath(outputId: string): string;
  report(decision: NativeExportDecision, transport?: NativeExportJob["transport"]): void;
}

/** Route one entire output through an admitted native job, or retain the original raw path. */
export class NativeRenderHostExport {
  readonly #options: NativeHostOptions;
  #job?: NativeExportJob;
  #state: "new" | "preflight" | "ready" | "exporting" | "finished" | "fallback" | "closed" = "new";
  #pending?: Promise<unknown>;
  #disposal?: Promise<void>;
  constructor(options: NativeHostOptions) {
    this.#options = { ...options, manifest: structuredClone(options.manifest) };
  }

  get statistics() {
    return this.#job?.statistics;
  }

  get unfinished(): boolean {
    return ["preflight", "ready", "exporting"].includes(this.#state);
  }

  /** Explicit preparation on the same job; ordinary queue output never invokes this operation. */
  async warm(frame: number, packet: NativeFramePacket): Promise<NativeExportDecision> {
    if (this.#state !== "preflight" || this.#pending || !this.#job)
      throw new Error("Native RenderHost warm-up is unavailable");
    const pending = this.#job.warm(frame, packet);
    this.#pending = pending;
    try {
      return this.#decision(await pending);
    } finally {
      this.#pending = undefined;
    }
  }

  async output(request: RenderHostOutputRequest): Promise<{ handled: boolean; value?: unknown }> {
    if (this.#state === "closed") throw new Error("Native RenderHost route is closed");
    const nativeControl = [
      "prepareNative",
      "sealNative",
      "admitNative",
      "abandonNative",
      "renderNativeFrame",
    ].includes(request.type);
    const active = ["preflight", "ready", "exporting", "finished"].includes(this.#state);
    if (!nativeControl && !active) {
      if (this.#state === "new") this.#state = "fallback";
      return { handled: false };
    }
    if (request.outputId !== this.#options.manifest.outputs[0]?.id)
      throw new Error("Native output does not match the immutable job");
    // PCM runs independently of the serialized video/control lane.
    if (request.type === "writeMp4Audio" && this.#state === "exporting" && this.#job) {
      await this.#job.writeAudio(request.samples);
      return { handled: true };
    }
    if (this.#pending) throw new Error("Native RenderHost route is busy");
    const pending = this.#output(request);
    this.#pending = pending;
    try {
      return { handled: true, value: await pending };
    } finally {
      this.#pending = undefined;
    }
  }

  async #output(request: RenderHostOutputRequest): Promise<unknown> {
    if (request.type === "prepareNative") {
      if (this.#state !== "new") throw new Error("Native route was already selected");
      if (!this.#options.runtime)
        return this.#decision({
          accepted: false,
          reason: "Native renderer runtime is unavailable on this platform",
        });
      const manifest = this.#options.manifest;
      // Unsupported output sets must be rejected before asking the publisher for an MP4 path.
      if (
        manifest.outputs.length !== 1 ||
        manifest.outputs[0]?.kind !== "mp4" ||
        manifest.outputs[0].codec !== "h264"
      )
        return this.#decision({
          accepted: false,
          reason: "Native export currently requires one H.264 MP4 output",
        });
      this.#state = "preflight";
      this.#job = new NativeExportJob({
        ...this.#options.runtime,
        manifest,
        ffmpeg: this.#options.ffmpeg,
        authorizedPaths: this.#options.authorizedPaths(),
        outputPath: this.#options.outputPath(request.outputId),
      });
      return this.#decision(await this.#job.prepare());
    }
    if (request.type === "abandonNative") {
      if (this.#state !== "preflight" && this.#state !== "fallback")
        throw new Error("Native route cannot be changed after admission");
      await this.#job?.dispose();
      return this.#decision({
        accepted: false,
        reason: request.reason,
      });
    }
    if (!this.#job) throw new Error("Native route has not been prepared");
    if (request.type === "admitNative" && this.#state === "preflight")
      return this.#decision(await this.#job.admit(request.frame, request.packet));
    if (request.type === "sealNative" && this.#state === "preflight") {
      const decision = await this.#job.seal();
      this.#requireOpen();
      if (decision.accepted) this.#state = "ready";
      return this.#decision(decision);
    }
    if (request.type === "startMp4" && this.#state === "ready") {
      const output = this.#options.manifest.outputs[0];
      if (
        output?.kind !== "mp4" ||
        request.videoBitrateBps !== Math.round(output.bitrateMbps * 1_000_000)
      )
        throw new Error("Native bitrate does not match the immutable job");
      await this.#job.start(request.audio);
      this.#requireOpen();
      this.#state = "exporting";
      return { encoder: "h264_mf" };
    }
    if (request.type === "renderNativeFrame" && this.#state === "exporting")
      return this.#job.render(request.frame);
    if (request.type === "finishMp4" && this.#state === "exporting") {
      const report = await this.#job.finish();
      this.#requireOpen();
      this.#state = "finished";
      await this.#job.dispose();
      return report;
    }
    throw new Error("Native output request is incompatible with the selected whole-job route");
  }

  dispose(): Promise<void> {
    this.#state = "closed";
    this.#disposal ??= (async () => {
      await this.#job?.dispose();
      await this.#pending?.catch(() => undefined);
      await this.#job?.dispose();
    })();
    return this.#disposal;
  }

  #requireOpen(): void {
    if (this.#state === "closed") throw new Error("Native RenderHost route was cancelled");
  }
  #decision(decision: NativeExportDecision): NativeExportDecision {
    this.#requireOpen();
    if (!decision.accepted) this.#state = "fallback";
    if (!decision.accepted || this.#state === "ready")
      this.#options.report(decision, decision.accepted ? this.#job?.transport : undefined);
    return decision;
  }
}
