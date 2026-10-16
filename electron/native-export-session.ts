import {
  Mp4ExportManager,
  type Mp4ExportReport,
  type Mp4ExportStartRequest,
  validateMp4ExportRequest,
} from "./mp4-export.js";
import type { NativeEncodedSpool } from "./native-encoded-spool.js";
import type { NativeRenderClient } from "./native-render-client.js";
import type {
  NativePacketMetadata,
  NativeSessionReply,
  NativeVideoConfig,
} from "./native-render-protocol.js";

export interface NativeExportReport extends Mp4ExportReport {
  transport: "nv12-shared" | "nv12-readback";
  transportReason: string | null;
  nativeEncoder: Record<string, unknown>;
}

/** Owns an admitted sidecar and the existing audio/atomic MP4 mux for one export. */
export class NativeExportSession {
  readonly #client: NativeRenderClient;
  readonly #mux: Mp4ExportManager;
  readonly #request: Mp4ExportStartRequest;
  readonly #transport: NativeExportReport["transport"];
  readonly #transportReason: string | null;
  readonly #muxId: string;
  readonly #stored?: NativeEncodedSpool;
  #submitted = 0;
  #encoded = 0;
  #videoBusy = false;
  #closed = false;
  #nativeEncoder?: Record<string, unknown>;

  private constructor(
    client: NativeRenderClient,
    mux: Mp4ExportManager,
    muxId: string,
    request: Mp4ExportStartRequest,
    transport: NativeExportReport["transport"],
    reason: string | null,
    stored?: NativeEncodedSpool,
  ) {
    this.#client = client;
    this.#mux = mux;
    this.#muxId = muxId;
    this.#request = request;
    this.#transport = transport;
    this.#transportReason = reason;
    this.#stored = stored;
  }

  static async start(
    client: NativeRenderClient,
    ffmpeg: string,
    value: Mp4ExportStartRequest,
    prepared?: NativeSessionReply,
    stored?: NativeEncodedSpool,
  ): Promise<NativeExportSession> {
    const mux = new Mp4ExportManager(ffmpeg, "native-h264");
    try {
      const request = await validateMp4ExportRequest(value);
      if (
        stored &&
        (!prepared || !stored.statistics.sealed || stored.statistics.frames !== request.frameCount)
      )
        throw new Error("Stored native export has not completed whole-job admission");
      const video: NativeVideoConfig = {
        size: { width: request.width, height: request.height },
        frame_rate: {
          numerator: request.frameRateNumerator,
          denominator: request.frameRateDenominator,
        },
        bitrate_bps: request.videoBitrateBps,
      };
      const { response } =
        prepared ??
        (await client.request({
          type: "begin_export",
          video,
          frame_count: request.frameCount,
        }));
      const accepted = response.video as NativeVideoConfig | undefined;
      if (
        response.type !== "export_started" ||
        response.frame_count !== request.frameCount ||
        accepted?.size?.width !== video.size.width ||
        accepted?.size?.height !== video.size.height ||
        accepted?.frame_rate?.numerator !== video.frame_rate.numerator ||
        accepted?.frame_rate?.denominator !== video.frame_rate.denominator ||
        accepted?.bitrate_bps !== video.bitrate_bps ||
        (response.transport !== "nv12-shared" && response.transport !== "nv12-readback") ||
        (response.transport_reason !== null && typeof response.transport_reason !== "string")
      )
        throw new Error("Native encoder accepted a different export configuration");
      const started = await mux.start(request, 0);
      return new NativeExportSession(
        client,
        mux,
        started.jobId,
        request,
        response.transport,
        response.transport_reason,
        stored,
      );
    } catch (error) {
      await Promise.allSettled([client.dispose(), mux.dispose()]);
      throw error;
    }
  }

  async render(plan?: Uint8Array): Promise<void> {
    if (this.#closed || this.#videoBusy || this.#submitted >= this.#request.frameCount)
      throw new Error("Native export cannot accept this frame");
    if ((!this.#stored && !plan) || (this.#stored && plan))
      throw new Error("Native export input does not match its live or stored transport");
    this.#videoBusy = true;
    try {
      let reply: NativeSessionReply;
      if (this.#stored) reply = await this.#stored.read(this.#submitted);
      else {
        if (!plan) throw new Error("Native export plan is missing");
        reply = await this.#client.request(
          { type: "render_frame", plan_bytes: plan.byteLength, frame_index: this.#submitted },
          plan,
        );
      }
      this.#submitted++;
      await this.#consume(reply);
      // Hardware encoders retain tail packets. Drain once the last input arrives so the mux
      // sees video EOF before the renderer waits for its independently backpressured PCM lane.
      if (this.#submitted === this.#request.frameCount) {
        const drained = this.#stored
          ? await this.#stored.read(this.#request.frameCount)
          : await this.#client.request({ type: "finish_export" });
        await this.#consume(drained);
        const encoder = drained.response.encoder as Record<string, unknown> | undefined;
        if (
          this.#encoded !== this.#request.frameCount ||
          encoder?.drain_completed !== true ||
          encoder.accepted_frames !== this.#submitted ||
          encoder.encoded_frames !== this.#encoded ||
          encoder.cancelled !== false
        )
          throw new Error("Native export did not drain every accepted frame");
        if (!this.#stored) await this.#client.shutdown();
        this.#nativeEncoder = encoder;
      }
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
      this.#videoBusy = false;
    }
  }

  async writeAudio(samples: ArrayBuffer): Promise<void> {
    if (this.#closed) throw new Error("Native export is closed");
    try {
      await this.#mux.writeAudio(this.#muxId, samples, 0);
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }

  async finish(): Promise<NativeExportReport> {
    if (this.#closed || this.#videoBusy)
      throw new Error("Native export is closed or has a pending frame");
    this.#closed = true;
    try {
      if (this.#submitted !== this.#request.frameCount)
        throw new Error("Native export is missing frames");
      if (!this.#nativeEncoder) throw new Error("Native encoder has not completed its drain");
      const report = await this.#mux.finish(this.#muxId, 0);
      return {
        ...report,
        transport: this.#transport,
        transportReason: this.#transportReason,
        nativeEncoder: this.#nativeEncoder,
      };
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.#closed = true;
    // Kill out of band: the worker may be blocked in a native driver or a pipe write.
    await Promise.allSettled([this.#client.dispose(), this.#mux.dispose()]);
  }

  async #consume(reply: NativeSessionReply): Promise<void> {
    const packets = reply.response.packets as NativePacketMetadata[];
    const numerator = BigInt(this.#request.frameRateNumerator);
    const ticks = BigInt(this.#request.frameRateDenominator) * 10_000_000n;
    for (const [index, packet] of packets.entries()) {
      const frame = this.#encoded + index;
      const timestamp = (BigInt(frame) * ticks) / numerator;
      const end = (BigInt(frame + 1) * ticks) / numerator;
      if (
        packet.frame_index !== frame ||
        frame >= this.#submitted ||
        BigInt(packet.timestamp_100ns) !== timestamp ||
        BigInt(packet.duration_100ns) !== end - timestamp
      )
        throw new Error("Native packet order or rational timestamp does not match the job");
    }
    if (packets.length) {
      await this.#mux.writeEncoded(this.#muxId, reply.payload, packets.length, 0);
      this.#encoded += packets.length;
    }
  }
}
