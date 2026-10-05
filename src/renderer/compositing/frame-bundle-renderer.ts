import { AntiAliasingRenderer } from "../effects/anti-aliasing";
import { requirePlan } from "../frame-plan/canonical";
import type { FrameBundle } from "../frame-plan/frame-bundle-plan";
import { readFrameBundleAsync } from "../frame-plan/frame-bundle-read";
import { normalizeRawFrameRgba } from "../gpu/raw-frame-png";
import { RendererResources } from "../renderer-resources";
import { prepareSuppliedFrame } from "./prepare-supplied-frame";
import { recordDecodedFrame } from "./record-planned-frame";
import { SuppliedFrameAssets } from "./supplied-frame-assets";

/** Headless diagnostic replay on an independent device, populated only from supplied frame bytes. */
export class FrameBundleRenderer {
  readonly #resources: RendererResources;
  readonly #aa: AntiAliasingRenderer;
  #output?: GPUTexture;
  #busy = false;
  #destroyed = false;

  private constructor(
    readonly device: GPUDevice,
    readonly format: GPUTextureFormat,
  ) {
    this.#resources = new RendererResources(
      device,
      format,
      {
        available: true,
        adapter: "supplied-frame",
        architecture: "",
        description: "",
        maxTextureSize: device.limits.maxTextureDimension2D,
        timestampQueries: false,
      },
      () => {},
    );
    this.#aa = new AntiAliasingRenderer(device, format);
  }

  static async create(): Promise<FrameBundleRenderer> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    requirePlan(adapter, "missing_resource", "Supplied replay requires a GPU adapter");
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
    try {
      return new FrameBundleRenderer(device, navigator.gpu.getPreferredCanvasFormat());
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  async render(bundle: FrameBundle): Promise<Uint8ClampedArray<ArrayBuffer>> {
    requirePlan(
      !this.#busy && !this.#destroyed,
      "resource_conflict",
      "Supplied frame renderer is busy or destroyed",
    );
    this.#busy = true;
    let assets: SuppliedFrameAssets | undefined;
    const resources = this.#resources,
      device = this.device;
    device.pushErrorScope("validation");
    try {
      const decoded = await readFrameBundleAsync(bundle),
        header = decoded.plans.post.metadata.header;
      const { width, height } = header.target;
      if (
        resources.sceneTexture?.width !== header.render_target.width ||
        resources.sceneTexture?.height !== header.render_target.height
      )
        resources.resizeRenderTargets(header.render_target.width, header.render_target.height);
      this.#aa.resize(header.aa, header.render_target.width, header.render_target.height);
      if (this.#output?.width !== width || this.#output?.height !== height) {
        this.#output?.destroy();
        this.#output = device.createTexture({
          label: "Supplied frame output",
          size: [width, height],
          format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      }
      assets = await SuppliedFrameAssets.create(decoded, resources);
      const prepared = prepareSuppliedFrame(decoded, resources, assets);
      requirePlan(assets.media, "missing_resource", "Supplied media is unavailable");
      const encoder = device.createCommandEncoder({ label: "Supplied frame replay" });
      const result = recordDecodedFrame({
        decoded,
        ...prepared,
        resources,
        encoder,
        output: this.#output.createView(),
        antiAliasing: this.#aa,
        mediaBindings: assets.media,
        materialBindings: assets.materials,
      });
      requirePlan(
        result.adjustmentErrors.length === 0,
        "invalid_effect_execution",
        JSON.stringify(result.adjustmentErrors),
      );
      const ticket = resources.frameReadback.reserve(width, height);
      try {
        ticket.encode(encoder, this.#output);
        device.queue.submit([encoder.finish()]);
        const raw = await ticket.read();
        await device.queue.onSubmittedWorkDone();
        return normalizeRawFrameRgba(raw, width, height);
      } finally {
        ticket.abort();
      }
    } finally {
      assets?.destroy();
      this.#busy = false;
      const error = await device.popErrorScope();
      requirePlan(!error, "invalid_resource", `Supplied frame GPU validation: ${error?.message}`);
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#resources.destroy();
    this.#aa.destroy();
    this.#output?.destroy();
    this.device.destroy();
  }
}
