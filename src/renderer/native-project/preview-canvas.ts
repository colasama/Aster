import type { GpuMemorySnapshot } from "../../core/rendering/gpu-memory-policy";
import type {
  DesktopNativePreview,
  NativePreviewDelivery,
  NativePreviewDescriptor,
} from "../../core/rendering/native-preview-protocol";
import type { CachedPreviewFrame } from "../../core/rendering/preview-frame-cache";
import { detectGpuMemory } from "../../desktop/gpu-memory";

interface PendingFrame {
  request: number;
  time: number;
  capture: boolean;
  display: boolean;
  snapshot?: HTMLCanvasElement;
  current(): boolean;
  resolve(value: { skipped: boolean; pixels?: CachedPreviewFrame }): void;
  reject(error: unknown): void;
}
const receivers = new Map<string, (value: NativePreviewDelivery<VideoFrame>) => void>();
let listening = false;

/** Electron owns the transport; this class only copies an owned VideoFrame into the editor canvas. */
export class NativePreviewCanvas {
  #identity?: { id: string; ready: NativePreviewDescriptor };
  #pending?: PendingFrame;
  #request = 0;
  #disposed = false;
  #loss?: Error;
  readonly format: GPUTextureFormat;
  readonly context: GPUCanvasContext;
  private constructor(
    readonly canvas: HTMLCanvasElement,
    readonly device: GPUDevice,
    readonly api: DesktopNativePreview,
    readonly memory: GpuMemorySnapshot,
  ) {
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Native preview GPU canvas is unavailable");
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format: this.format,
      alphaMode: "opaque",
      colorSpace: "srgb",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    if (!listening) {
      listening = true;
      window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window || event.data?.channel !== "aster-native-preview") return;
        const value = event.data as NativePreviewDelivery<VideoFrame>;
        if (!(value.frame instanceof VideoFrame)) return;
        const receiver = receivers.get(value.id);
        if (receiver) receiver(value);
        else value.frame.close();
      });
    }
    void device.lost.then((info) => {
      if (!this.#disposed) {
        this.#loss = new Error(`Preview GPU device lost: ${info.message}`);
        this.#pending?.reject(this.#loss);
      }
    });
  }

  get loss(): Error | undefined {
    return this.#loss;
  }

  static async create(
    canvas: HTMLCanvasElement,
    api: DesktopNativePreview,
  ): Promise<NativePreviewCanvas> {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("Native preview needs a GPU presentation adapter");
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
    try {
      return new NativePreviewCanvas(canvas, device, api, await detectGpuMemory(adapter.info));
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  bind(id: string, ready: NativePreviewDescriptor): void {
    if (this.#loss) throw this.#loss;
    if (this.#disposed || this.#pending)
      throw new Error("Preview canvas cannot change an active frame");
    if (this.#identity) receivers.delete(this.#identity.id);
    this.#identity = { id, ready };
    receivers.set(id, (value) => {
      void this.#receive(value);
    });
  }

  async present(
    time: number,
    capture: boolean,
    current: () => boolean,
    display = true,
    snapshot?: HTMLCanvasElement,
  ) {
    if (this.#loss) throw this.#loss;
    const identity = this.#identity;
    if (!identity || this.#disposed || this.#pending)
      throw new Error("Preview canvas is not ready");
    const request = ++this.#request;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drawn = new Promise<{ skipped: boolean; pixels?: CachedPreviewFrame }>(
      (resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native preview presentation timed out")),
          120000,
        );
        this.#pending = { request, time, capture, display, snapshot, current, resolve, reject };
      },
    );
    try {
      const [rendered, result] = await Promise.all([
        this.api.present(identity.id, time, request),
        drawn,
      ]);
      return { ...result, ...rendered };
    } finally {
      clearTimeout(timer);
      this.#pending = undefined;
    }
  }

  async #receive(delivery: NativePreviewDelivery<VideoFrame>): Promise<void> {
    const pending = this.#pending,
      identity = this.#identity;
    const video = delivery.frame;
    let readback: GPUBuffer | undefined;
    let offscreen: GPUTexture | undefined;
    let scoped = false;
    try {
      if (!pending || !identity || delivery.request !== pending.request) return;
      if (
        delivery.generation !== identity.ready.generation ||
        delivery.time !== pending.time ||
        delivery.width !== identity.ready.width ||
        delivery.height !== identity.ready.height ||
        video.codedWidth !== delivery.width ||
        video.codedHeight !== delivery.height ||
        !Number.isSafeInteger(delivery.sequence) ||
        video.timestamp !== delivery.sequence ||
        delivery.source.runtime_sha256 !== identity.ready.source.runtime_sha256 ||
        delivery.source.authored_sha256 !== identity.ready.source.authored_sha256 ||
        delivery.source.scope !== identity.ready.source.scope ||
        delivery.source.revision !== identity.ready.source.revision ||
        delivery.source.composition_id !== identity.ready.source.composition_id
      )
        throw new Error("Native preview delivery belongs to a different snapshot");
      if (this.#disposed || !pending.current()) {
        pending.resolve({ skipped: true });
        return;
      }
      if (pending.snapshot) {
        // Copy the authenticated frame while its lease is live, independently of the swapchain.
        const scale = Math.min(1, 2048 / Math.max(delivery.width, delivery.height));
        const target = pending.snapshot;
        target.width = Math.max(1, Math.round(delivery.width * scale));
        target.height = Math.max(1, Math.round(delivery.height * scale));
        // Match the editor's opaque swapchain: associated RGB is displayed over black.
        const context = target.getContext("2d", { alpha: false });
        if (!context) throw new Error("Native snapshot canvas is unavailable");
        context.drawImage(video, 0, 0, target.width, target.height);
        pending.resolve({ skipped: !pending.current() });
        return;
      }
      this.device.pushErrorScope("validation");
      scoped = true;
      if (pending.display) {
        if (this.canvas.width !== delivery.width) this.canvas.width = delivery.width;
        if (this.canvas.height !== delivery.height) this.canvas.height = delivery.height;
      } else
        offscreen = this.device.createTexture({
          size: [delivery.width, delivery.height],
          format: this.format,
          usage:
            GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      const texture = offscreen ?? this.context.getCurrentTexture();
      this.device.queue.copyExternalImageToTexture(
        { source: video },
        { texture, premultipliedAlpha: true, colorSpace: "srgb" },
        [delivery.width, delivery.height],
      );
      let pixels: CachedPreviewFrame | undefined;
      let completion: Promise<void>;
      const stride = Math.ceil((delivery.width * 4) / 256) * 256;
      if (pending.capture) {
        readback = this.device.createBuffer({
          size: stride * delivery.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: stride }, [
          delivery.width,
          delivery.height,
        ]);
        this.device.queue.submit([encoder.finish()]);
        completion = readback.mapAsync(GPUMapMode.READ);
      } else completion = Promise.resolve();
      // Capture waits for mapped pixels. Display completion is acknowledged by the broker
      // after Electron's GPU-tracked VideoFrame references and native surface lease drain.
      const validation = this.device.popErrorScope();
      scoped = false;
      const [, error] = await Promise.all([completion, validation]);
      if (error) throw new Error(error.message);
      if (readback) {
        const mapped = new Uint8Array(readback.getMappedRange());
        const bytes = new Uint8Array(delivery.width * delivery.height * 4);
        for (let y = 0; y < delivery.height; y++)
          bytes.set(
            mapped.subarray(y * stride, y * stride + delivery.width * 4),
            y * delivery.width * 4,
          );
        pixels = {
          pixels: bytes.buffer,
          width: delivery.width,
          height: delivery.height,
          pixelFormat: this.format === "bgra8unorm" ? "bgra" : "rgba",
        };
      }
      pending.resolve({ skipped: !pending.current(), pixels });
    } catch (error) {
      pending?.reject(error);
    } finally {
      if (scoped) await this.device.popErrorScope();
      readback?.destroy();
      offscreen?.destroy();
      video.close();
    }
  }

  async presentCached(frame: CachedPreviewFrame): Promise<void> {
    if (this.#loss) throw this.#loss;
    if (this.#disposed || this.#pending) throw new Error("Preview canvas is busy");
    const expected = this.format === "bgra8unorm" ? "bgra" : "rgba";
    if (
      frame.pixelFormat !== expected ||
      frame.pixels.byteLength !== frame.width * frame.height * 4
    )
      throw new Error("Cached preview format differs");
    if (this.canvas.width !== frame.width) this.canvas.width = frame.width;
    if (this.canvas.height !== frame.height) this.canvas.height = frame.height;
    this.device.queue.writeTexture(
      { texture: this.context.getCurrentTexture() },
      frame.pixels,
      { bytesPerRow: frame.width * 4 },
      [frame.width, frame.height],
    );
    await this.device.queue.onSubmittedWorkDone();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#identity) receivers.delete(this.#identity.id);
    this.#pending?.reject(new Error("Preview canvas disposed"));
    this.context.unconfigure();
    this.device.destroy();
  }
}
