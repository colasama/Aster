import { captureSubmittedFrameBundle } from "../compositing/frame-bundle-capture";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import type { MediaBindingLease } from "../media/media-binding-lease";
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

export interface CapturedProductionFrame extends RawVideoFrame {
  bundle?: FrameBundle;
}
interface PendingCapture {
  ticket: FrameReadbackTicket;
  captureBundle: boolean;
  bundle?: Promise<FrameBundle>;
}

/** Serialize exact-frame discovery while retaining independent owners for diagnostic capture. */
export class ProductionFrameCapture {
  readonly #queue = new ExactFrameCaptureQueue<CapturedProductionFrame>();
  #pending?: PendingCapture;

  get capturesBundle(): boolean {
    return this.#pending?.captureBundle === true;
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
        pending.ticket.abort();
        return Promise.resolve(pending.bundle)
          .catch(() => undefined)
          .then(() => {
            throw error;
          });
      } finally {
        this.#pending = undefined;
      }
      const pixels = pending.ticket.read(options.destination);
      // Drain both readbacks even if one fails; retained media must always be released.
      return Promise.allSettled([pixels, pending.bundle]).then(([pixelResult, bundleResult]) => {
        if (pixelResult.status === "rejected") throw pixelResult.reason;
        if (bundleResult.status === "rejected") throw bundleResult.reason;
        const frame = pixelResult.value,
          bundle = bundleResult.value;
        if (options.captureBundle && !bundle)
          throw new Error("No submitted frame bundle was captured");
        return bundle ? { ...frame, bundle } : frame;
      });
    }, options.resources);
  }

  encode(encoder: GPUCommandEncoder, output: GPUTexture): void {
    this.#pending?.ticket.encode(encoder, output);
  }

  submitted(device: GPUDevice, bundle: FrameBundle, media: MediaBindingLease): void {
    if (!this.#pending?.captureBundle) return;
    this.#pending.bundle = captureSubmittedFrameBundle(device, bundle, media);
    void this.#pending.bundle.catch(() => undefined);
  }

  abort(): void {
    this.#pending?.ticket.abort();
    this.#pending = undefined;
  }
}
