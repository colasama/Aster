import type { NativeFramePacket } from "../../core/rendering/native-export-protocol";
import type { RendererMetrics } from "../../core/types";
import {
  type CapturedFrameBundle,
  captureSubmittedFrameBundle,
} from "../compositing/frame-bundle-capture";
import { nativeFramePacketWithRasters } from "../compositing/native-frame-packet";
import { withNativeFrameRasters } from "../compositing/native-frame-rasters";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import type { FrameHeaderSlice } from "../frame-plan/types";
import type { MediaBindingLease } from "../media/media-binding-lease";
import { NativeRasterCaptureCache } from "../media/native-raster-capture-cache";
import type { RendererResources } from "../renderer-resources";
import {
  ExactFrameCaptureQueue,
  type ExactFrameResourceBarrier,
} from "./exact-frame-resource-barrier";
import {
  type FrameReadbackTicket,
  type GpuFrameReadbackPool,
  type RawVideoFrame,
  validateReadbackDestination,
} from "./frame-readback";
import type { GpuMemoryPlan } from "./gpu-memory-budget";
import {
  type ProductionCaptureRenderer,
  type ProductionFrameRequest,
  productionCaptureRender,
  type RawProductionFrameRequest,
} from "./production-capture-render";

export interface CapturedProductionFrame extends RawVideoFrame {
  bundle?: CapturedFrameBundle;
}
interface PendingCapture {
  ticket?: FrameReadbackTicket;
  captureBundle: boolean;
  planOnly?: boolean;
  bundle?: Promise<CapturedFrameBundle>;
  packet?: Promise<NativeFramePacket>;
  retained?: ReadonlySet<string>;
}

/** Serialize exact-frame discovery while retaining independent owners for diagnostic capture. */
export class ProductionFrameCapture {
  readonly #queue = new ExactFrameCaptureQueue<
    CapturedProductionFrame | CapturedFrameBundle | NativeFramePacket
  >();
  #pending?: PendingCapture;
  readonly #rasters = new NativeRasterCaptureCache();
  #epoch = 0;

  constructor(
    private readonly context: () => {
      renderer: ProductionCaptureRenderer;
      pool: GpuFrameReadbackPool;
      resources: ExactFrameResourceBarrier;
    },
  ) {}

  captureFrame(...args: RawProductionFrameRequest): Promise<CapturedProductionFrame> {
    const [
      composition,
      time,
      snapshot,
      project,
      synchronizeVideo = false,
      destination,
      captureBundle = false,
    ] = args;
    const { renderer, pool, resources } = this.context();
    return this.capture({
      pool,
      resources,
      width: renderer.outputWidth,
      height: renderer.outputHeight,
      synchronizeVideo,
      destination,
      captureBundle,
      render: productionCaptureRender(renderer, composition, time, snapshot, project),
    });
  }

  captureExportPlan(...args: ProductionFrameRequest): Promise<CapturedFrameBundle> {
    const [composition, time, snapshot, project, synchronizeVideo = true] = args;
    const { renderer, resources } = this.context();
    return this.capturePlan({
      resources,
      synchronizeVideo,
      render: productionCaptureRender(renderer, composition, time, snapshot, project),
    });
  }

  captureExportPacket(
    retained: ReadonlySet<string>,
    ...args: ProductionFrameRequest
  ): Promise<NativeFramePacket> {
    const [composition, time, snapshot, project, synchronizeVideo = true] = args;
    const { renderer, resources } = this.context();
    return this.capturePacket({
      resources,
      synchronizeVideo,
      retained,
      render: productionCaptureRender(renderer, composition, time, snapshot, project),
    });
  }

  capturePacket(options: {
    resources: ExactFrameResourceBarrier;
    synchronizeVideo: boolean;
    retained: ReadonlySet<string>;
    render(holdInexactVideo: boolean): void;
  }): Promise<NativeFramePacket> {
    const retained = new Set(options.retained);
    return this.#queue.capture((discovery) => {
      if (this.#pending)
        return Promise.reject(new Error("A production capture is already being prepared"));
      const pending: PendingCapture = { captureBundle: true, planOnly: true, retained };
      this.#pending = pending;
      try {
        options.render(options.synchronizeVideo && discovery);
        if (!pending.packet) throw new Error("No complete native packet was captured");
        return pending.packet;
      } catch (error) {
        return Promise.resolve(pending.packet)
          .catch(() => undefined)
          .then(() => {
            throw error;
          });
      } finally {
        this.#pending = undefined;
      }
    }, options.resources);
  }

  get capturesBundle(): boolean {
    return this.#pending?.captureBundle === true;
  }

  get plansOnly(): boolean {
    return this.#pending?.planOnly === true;
  }

  capturePlan(options: {
    resources: ExactFrameResourceBarrier;
    synchronizeVideo: boolean;
    render(holdInexactVideo: boolean): void;
  }): Promise<CapturedFrameBundle> {
    return this.#queue.capture((discovery) => {
      if (this.#pending)
        return Promise.reject(new Error("A production capture is already being prepared"));
      const pending: PendingCapture = { captureBundle: true, planOnly: true };
      this.#pending = pending;
      try {
        options.render(options.synchronizeVideo && discovery);
        if (!pending.bundle) throw new Error("No complete frame plan was captured");
        return pending.bundle;
      } catch (error) {
        return Promise.resolve(pending.bundle)
          .catch(() => undefined)
          .then(() => {
            throw error;
          });
      } finally {
        this.#pending = undefined;
      }
    }, options.resources);
  }

  capture(options: {
    pool: GpuFrameReadbackPool;
    resources: ExactFrameResourceBarrier;
    width: number;
    height: number;
    synchronizeVideo: boolean;
    destination?: ArrayBuffer;
    captureBundle: boolean;
    render(holdInexactVideo: boolean): void;
  }): Promise<CapturedProductionFrame> {
    if (options.destination !== undefined)
      validateReadbackDestination(options.destination, options.width, options.height);
    return this.#queue.capture((discovery) => {
      if (this.#pending)
        return Promise.reject(new Error("A GPU frame readback is already being encoded"));
      const pending: PendingCapture = {
        ticket: options.pool.reserve(options.width, options.height),
        captureBundle: options.captureBundle,
      };
      this.#pending = pending;
      try {
        options.render(options.synchronizeVideo && discovery);
      } catch (error) {
        pending.ticket?.abort();
        return Promise.resolve(pending.bundle)
          .catch(() => undefined)
          .then(() => {
            throw error;
          });
      } finally {
        this.#pending = undefined;
      }
      const pixels = pending.ticket?.read(options.destination);
      // Drain both readbacks even if one fails; retained media must always be released.
      return Promise.allSettled([pixels, pending.bundle]).then(([pixelResult, bundleResult]) => {
        if (pixelResult.status === "rejected") throw pixelResult.reason;
        if (bundleResult.status === "rejected") throw bundleResult.reason;
        const frame = pixelResult.value,
          bundle = bundleResult.value;
        if (!frame) throw new Error("No output readback was reserved");
        if (options.captureBundle && !bundle)
          throw new Error("No submitted frame bundle was captured");
        return bundle ? { ...frame, bundle } : frame;
      });
    }, options.resources);
  }

  encode(encoder: GPUCommandEncoder, output: GPUTexture): void {
    this.#pending?.ticket?.encode(encoder, output);
  }

  /** Submit raster inputs without recording the final scene/output graph. */
  submitPlan(options: {
    device: GPUDevice;
    bundle(): Promise<FrameBundle>;
    header: FrameHeaderSlice;
    media: MediaBindingLease;
    textures: RendererResources["mediaTextures"];
    memory: GpuMemoryPlan;
    started: number;
    cacheHitRate: number;
  }): RendererMetrics {
    const { device, bundle, media, textures, memory } = options;
    if (!this.#pending?.planOnly) throw new Error("No native plan capture is pending");
    const frames = media.resourceMessages.filter(
      (frame) => frame.kind === "media_frame" && frame.descriptor.sample.kind === "raster",
    );
    const lease = media.retainForCapture(frames.map((frame) => frame.hash));
    const epoch = this.#epoch;
    const captured = (async () => {
      try {
        // The builder snapshots synchronously; independent GPU owners survive its first await.
        const input = await bundle();
        if (epoch !== this.#epoch) throw new Error("Native plan capture was aborted");
        const required = input.resources
          .map((packet) => packet.message)
          .filter(
            (frame) => frame.kind === "media_frame" && frame.descriptor.sample.kind === "raster",
          );
        const rasters = await this.#rasters.captureVerified(device, lease, required);
        return { input, rasters };
      } finally {
        lease.release();
      }
    })();
    const retained = this.#pending.retained;
    if (retained) {
      this.#pending.packet = captured.then(({ input, rasters }) =>
        nativeFramePacketWithRasters(input, rasters, retained),
      );
      void this.#pending.packet.catch(() => undefined);
    } else {
      this.#pending.bundle = captured.then(async ({ input, rasters }) => ({
        ...(await withNativeFrameRasters(input, rasters)),
        submittedPlan: structuredClone(input.plan),
      }));
      void this.#pending.bundle.catch(() => undefined);
    }
    try {
      // Collection above must precede flush, which consumes pending temporal raster passes.
      const uploads = device.createCommandEncoder({ label: "Aster frame plan inputs" });
      textures.flush(uploads, options.header);
      device.queue.submit([uploads.finish()]);
      textures.submitted();
    } catch (error) {
      this.abort();
      throw error;
    }
    return {
      fps: 0,
      frameMs: 0,
      cpuMs: performance.now() - options.started,
      gpuMs: 0,
      drawCalls: 0,
      passCount: 0,
      dirtyNodes: 0,
      cacheHitRate: options.cacheHitRate,
      estimatedVramMb: memory.estimatedBytes / 1024 / 1024,
      transientTextureCount: 0,
      memoryBudgetMb: memory.budgetMb,
      memoryPressure: memory.pressure,
    };
  }

  submitted(device: GPUDevice, bundle: FrameBundle, media: MediaBindingLease): void {
    if (!this.#pending?.captureBundle) return;
    this.#pending.bundle = captureSubmittedFrameBundle(
      device,
      bundle,
      media,
      this.#pending.planOnly ? "raster" : "all",
      this.#rasters,
    );
    void this.#pending.bundle.catch(() => undefined);
  }

  abort(): void {
    this.#epoch++;
    this.#rasters.clear();
    this.#pending?.ticket?.abort();
    this.#pending = undefined;
  }
}
