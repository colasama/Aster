import type {
  NativeExportDecision,
  NativeFramePacket,
} from "../src/core/rendering/native-export-protocol.js";
import type { RenderJobManifest } from "../src/core/rendering/render-queue.js";
import type { Mp4ExportStartRequest } from "./mp4-export.js";
import { NativeEncodedSpool } from "./native-encoded-spool.js";
import { prepareNativeEncoder } from "./native-encoder-preflight.js";
import { ownNativeFrame } from "./native-export-input.js";
import { type NativeExportReport, NativeExportSession } from "./native-export-session.js";
import { NativeFrameAdmission } from "./native-frame-admission.js";
import { validateNativeJobFrame } from "./native-job-identity.js";
import { NativeMediaGrants } from "./native-media-grants.js";
import type { NativeRenderClient } from "./native-render-client.js";
import type { NativeSessionReply, NativeVideoConfig } from "./native-render-protocol.js";
import { NativeResourceWindow } from "./native-resource-window.js";

export interface NativeExportJobOptions {
  manifest: RenderJobManifest;
  authorizedPaths: readonly string[];
  temporaryRoot: string;
  outputPath: string;
  binary: string;
  compiler?: string;
  ffmpeg: string;
  ffprobe: string;
}
type NativeJobState = "new" | "preflight" | "ready" | "exporting" | "finished" | "closed";

/** Main-process whole-job admission owns immutable inputs through atomic mux completion. */
export class NativeExportJob {
  readonly #options: NativeExportJobOptions;
  #state: NativeJobState = "new";
  #client?: NativeRenderClient;
  #window?: NativeResourceWindow;
  #admission?: NativeFrameAdmission;
  #encoded?: NativeEncodedSpool;
  #media?: NativeMediaGrants;
  #session?: NativeExportSession;
  #video?: NativeVideoConfig;
  #prepared?: NativeSessionReply;
  #nativeTimings?: unknown;
  #pending?: Promise<unknown>;
  #disposal?: Promise<void>;
  #rendered = 0;
  readonly #warmup = { frames: 0, elapsedMs: 0 };
  readonly #timings = {
    prepareMs: 0,
    admissionMs: 0,
    resourceInstallMs: 0,
    nativeRenderEncodeMs: 0,
    identityCheckMs: 0,
    encodedSpoolMs: 0,
    admittedFrames: 0,
  };

  constructor(options: NativeExportJobOptions) {
    this.#options = structuredClone(options);
  }

  get statistics() {
    return this.#admission?.statistics;
  }

  get transport() {
    return {
      transport: this.#prepared?.response.transport,
      transportReason: this.#prepared?.response.transport_reason,
      adapterLuid: this.#prepared?.response.adapter_luid,
      nativeAdapter: this.#prepared?.response.adapter,
      probedAdapterLuid: this.#prepared?.response.probed_adapter_luid,
      preflight: { ...this.#timings },
      admissionTimings: this.#admission?.timings,
      compressed: this.#encoded?.statistics,
      nativeTimings: this.#nativeTimings,
      warmup: { ...this.#warmup },
    };
  }

  async prepare(): Promise<NativeExportDecision> {
    const started = performance.now();
    try {
      await this.#run(async () => {
        this.#expect("new");
        const { manifest, temporaryRoot, authorizedPaths, binary, compiler, ffmpeg, ffprobe } =
          this.#options;
        const output = manifest.outputs[0];
        if (manifest.outputs.length !== 1 || output?.kind !== "mp4" || output.codec !== "h264")
          throw new Error("Native export currently requires one H.264 MP4 output");
        const frameCount = manifest.endFrameExclusive - manifest.startFrame;
        if (manifest.width % 2 || manifest.height % 2 || frameCount > 1_000_000)
          throw new Error("Native export dimensions or frame count exceed encoder capabilities");
        this.#media = await NativeMediaGrants.create(temporaryRoot, manifest, authorizedPaths);
        this.#expect("new");
        this.#admission = new NativeFrameAdmission({
          frameCount,
          maxBytes: 31 * 1024 ** 3,
          maxResources: 262144,
          maxFrameBytes: 67_108_864,
        });
        this.#expect("new");
        this.#video = {
          size: { width: manifest.width, height: manifest.height },
          frame_rate: { ...manifest.frameRate },
          bitrate_bps: Math.round(output.bitrateMbps * 1_000_000),
        };
        this.#encoded = await NativeEncodedSpool.create(temporaryRoot, frameCount, this.#video);
        this.#expect("new");
        const prepared = await prepareNativeEncoder({
          binary,
          args: [
            ...(compiler ? ["--dxcompiler", compiler] : []),
            "--media-authorizations",
            this.#media.path,
            "--ffmpeg",
            ffmpeg,
            "--ffprobe",
            ffprobe,
          ],
          video: this.#video,
          frameCount,
          own: (client) => {
            this.#client = client;
          },
          assertActive: () => this.#expect("new"),
        });
        this.#window = new NativeResourceWindow(prepared.client);
        this.#prepared = prepared.reply;
        this.#expect("new");
        this.#state = "preflight";
      });
      return { accepted: true, reason: null };
    } catch (error) {
      return this.#reject(error);
    } finally {
      this.#timings.prepareMs += performance.now() - started;
    }
  }

  /** Optional pipeline preparation on the retained device, before any measured frame is admitted. */
  async warm(index: number, packet: NativeFramePacket): Promise<NativeExportDecision> {
    const started = performance.now();
    try {
      await this.#run(async () => {
        this.#expect("preflight");
        const client = this.#client,
          window = this.#window;
        const frames = this.#options.manifest.endFrameExclusive - this.#options.manifest.startFrame;
        if (
          !client ||
          !window ||
          this.#timings.admittedFrames ||
          this.#warmup.frames >= 10 ||
          index !== this.#warmup.frames % frames
        )
          throw new Error("Native warm-up is unavailable or out of order");
        const owned = ownNativeFrame(packet);
        await window.install(owned);
        const reply = await client.request(
          { type: "warm_frame", plan_bytes: owned.plan.length },
          owned.plan,
        );
        validateNativeJobFrame(this.#options.manifest, index, owned.plan, reply, "warmup");
        const encoder = reply.response.encoder as Record<string, unknown> | undefined;
        if (
          reply.response.warmup_frames !== this.#warmup.frames + 1 ||
          encoder?.accepted_frames !== 0 ||
          encoder.encoded_frames !== 0 ||
          encoder.encoded_bytes !== 0 ||
          encoder.drain_completed !== false ||
          encoder.cancelled !== false
        )
          throw new Error("Native warm-up changed the measured encoder clock");
        await window.clear();
        this.#expect("preflight");
        this.#warmup.frames++;
      });
      return { accepted: true, reason: null };
    } catch (error) {
      return this.#reject(error);
    } finally {
      this.#warmup.elapsedMs += performance.now() - started;
    }
  }

  async admit(index: number, packet: NativeFramePacket): Promise<NativeExportDecision> {
    const started = performance.now();
    try {
      await this.#run(async () => {
        this.#expect("preflight");
        const client = this.#client,
          window = this.#window,
          admission = this.#admission,
          encoded = this.#encoded;
        if (!client || !window || !admission || !encoded)
          throw new Error("Native preflight is unavailable");
        await admission.append(index, packet, async (owned) => {
          let stage = performance.now();
          await window.install(owned);
          this.#timings.resourceInstallMs += performance.now() - stage;
          stage = performance.now();
          const reply = await client.request(
            { type: "render_frame", plan_bytes: owned.plan.length, frame_index: index },
            owned.plan,
          );
          this.#timings.nativeRenderEncodeMs += performance.now() - stage;
          stage = performance.now();
          validateNativeJobFrame(this.#options.manifest, index, owned.plan, reply);
          this.#timings.identityCheckMs += performance.now() - stage;
          stage = performance.now();
          await encoded.append(index, reply);
          this.#timings.encodedSpoolMs += performance.now() - stage;
        });
        this.#expect("preflight");
        this.#timings.admittedFrames++;
      });
      return { accepted: true, reason: null };
    } catch (error) {
      return this.#reject(error);
    } finally {
      this.#timings.admissionMs += performance.now() - started;
    }
  }

  async seal(): Promise<NativeExportDecision> {
    try {
      await this.#run(async () => {
        this.#expect("preflight");
        if (!this.#admission || !this.#encoded || !this.#client)
          throw new Error("Native preflight spool is unavailable");
        this.#admission.seal();
        const drained = await this.#client.request({ type: "finish_export" });
        await this.#encoded.seal(drained);
        this.#nativeTimings = drained.response.timings;
        await this.#client.shutdown();
        this.#expect("preflight");
        this.#state = "ready";
      });
      return { accepted: true, reason: null };
    } catch (error) {
      return this.#reject(error);
    }
  }

  async start(audio?: Mp4ExportStartRequest["audio"]): Promise<void> {
    await this.#run(async () => {
      this.#expect("ready");
      const { manifest, ffmpeg, outputPath } = this.#options;
      const output = manifest.outputs[0];
      const frameCount = manifest.endFrameExclusive - manifest.startFrame;
      if (!this.#client || !this.#video || output?.kind !== "mp4")
        throw new Error("Native encoder is unavailable");
      if (
        audio &&
        (!output.includeAudio ||
          audio.channels !== 2 ||
          audio.sampleRate !== 48000 ||
          audio.frameCount !==
            Math.round(
              (frameCount / manifest.frameRate.numerator) * manifest.frameRate.denominator * 48000,
            ))
      )
        throw new Error("Native audio does not match the immutable job clock");
      this.#session = await NativeExportSession.start(
        this.#client,
        ffmpeg,
        {
          outputPath,
          width: manifest.width,
          height: manifest.height,
          frameRateNumerator: manifest.frameRate.numerator,
          frameRateDenominator: manifest.frameRate.denominator,
          frameCount,
          pixelFormat: "rgba",
          videoBitrateBps: this.#video.bitrate_bps,
          ...(audio ? { audio } : {}),
        },
        this.#prepared,
        this.#encoded,
      );
      this.#expect("ready");
      this.#state = "exporting";
    });
  }

  async render(index: number): Promise<void> {
    await this.#run(async () => {
      this.#expect("exporting");
      if (index !== this.#rendered || !this.#encoded || !this.#session)
        throw new Error("Native export frame is out of order");
      await this.#session.render();
      this.#expect("exporting");
      this.#rendered++;
    });
  }

  async writeAudio(samples: ArrayBuffer): Promise<void> {
    this.#expect("exporting");
    if (!this.#session) throw new Error("Native export session is unavailable");
    await this.#session.writeAudio(samples);
  }

  async finish(): Promise<NativeExportReport> {
    return this.#run(async () => {
      this.#expect("exporting");
      if (!this.#session) throw new Error("Native export session is unavailable");
      const report = await this.#session.finish();
      this.#expect("exporting");
      this.#state = "finished";
      return report;
    });
  }

  dispose(): Promise<void> {
    this.#state = "closed";
    this.#disposal ??= (async () => {
      // Interrupt driver/pipe waits before waiting for the operation that owns spool files.
      await Promise.allSettled([this.#client?.dispose(), this.#session?.cancel()]);
      await this.#pending?.catch(() => undefined);
      const results = await Promise.allSettled([
        this.#session?.cancel(),
        this.#admission?.dispose(),
        this.#encoded?.dispose(),
        this.#media?.dispose(),
      ]);
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          "Native job cleanup failed",
        );
    })();
    return this.#disposal;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending || this.#state === "closed") throw new Error("Native job is closed or busy");
    const pending = operation();
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      this.#pending = undefined;
    }
  }

  #expect(state: NativeJobState): void {
    if (this.#state !== state) throw new Error(`Native job is not ${state}`);
  }

  async #reject(error: unknown): Promise<NativeExportDecision> {
    await this.dispose();
    return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
