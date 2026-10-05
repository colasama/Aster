import type { BlendMode } from "../../core/types";
import { createMaterialShapePipelines } from "../scene/scene-pipelines";
import { type MaterialBindingPlan, materialBindingUniforms } from "./material-texture-plan";
import { MaterialTextureRegistry } from "./material-texture-registry";

export interface MaterialTextureBinding {
  bindGroup: GPUBindGroup;
  pipeline: GPURenderPipeline;
}

export const NORMAL_MAP_SAMPLER_DESCRIPTOR: GPUSamplerDescriptor = {
  addressModeU: "repeat",
  addressModeV: "repeat",
  magFilter: "linear",
  minFilter: "linear",
};

export const HDR_ENVIRONMENT_SAMPLER_DESCRIPTOR: GPUSamplerDescriptor = {
  addressModeU: "repeat",
  addressModeV: "clamp-to-edge",
  magFilter: "linear",
  minFilter: "linear",
};

/** GPU execution consumes supplied bindings and registered texture owners only. */
export class MaterialGpuBindings {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #lightingLayout: GPUBindGroupLayout;
  readonly #layout: GPUBindGroupLayout;
  readonly #normalSampler: GPUSampler;
  readonly #environmentSampler: GPUSampler;
  readonly #uniforms = new Map<string, GPUBuffer>();
  readonly #bindGroups = new Map<string, { key: string; bindGroup: GPUBindGroup }>();
  readonly #textures = new MaterialTextureRegistry();
  #pipelines?: Record<BlendMode, GPURenderPipeline>;
  #fallbackNormal?: GPUTexture;
  #fallbackEnvironment?: GPUTexture;

  constructor(device: GPUDevice, format: GPUTextureFormat, lightingLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#format = format;
    this.#lightingLayout = lightingLayout;
    this.#layout = device.createBindGroupLayout({
      label: "Mesh normal map + HDR environment layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.#normalSampler = device.createSampler({
      ...NORMAL_MAP_SAMPLER_DESCRIPTOR,
      label: "Repeating mesh normal-map sampler",
    });
    this.#environmentSampler = device.createSampler({
      ...HDR_ENVIRONMENT_SAMPLER_DESCRIPTOR,
      label: "Equirectangular HDR environment sampler",
    });
  }

  register(hash: string, role: "normal" | "environment", texture: GPUTexture): void {
    this.#textures.register(hash, role, texture);
  }

  retire(hash: string | undefined, texture: GPUTexture | undefined): void {
    this.#textures.retire(hash, texture);
    if (texture) this.#bindGroups.clear();
  }

  invalidate(instanceId?: string): void {
    if (instanceId === undefined) this.#bindGroups.clear();
    else this.#bindGroups.delete(instanceId);
  }

  remove(instanceId: string): void {
    this.#uniforms.get(instanceId)?.destroy();
    this.#uniforms.delete(instanceId);
    this.#bindGroups.delete(instanceId);
  }

  sweep(active: ReadonlySet<string>): void {
    for (const instanceId of this.#uniforms.keys())
      if (!active.has(instanceId)) this.remove(instanceId);
  }

  get uniformBytes(): number {
    return this.#uniforms.size * 16;
  }

  destroy(): void {
    for (const uniform of this.#uniforms.values()) uniform.destroy();
    this.#uniforms.clear();
    this.#bindGroups.clear();
    this.#fallbackNormal?.destroy();
    this.#fallbackNormal = undefined;
    this.#fallbackEnvironment?.destroy();
    this.#fallbackEnvironment = undefined;
  }

  bindingFor(
    plan: MaterialBindingPlan | undefined,
    blendMode: BlendMode,
  ): MaterialTextureBinding | undefined {
    if (!plan?.active) return undefined;
    const { instanceId } = plan;
    const normalTexture = plan.normalHash
      ? this.#textures.resolve(plan.normalHash, "normal")
      : this.#ensureFallbackNormal();
    const environmentTexture = plan.environmentHash
      ? this.#textures.resolve(plan.environmentHash, "environment")
      : this.#ensureFallbackEnvironment();
    const key = [
      plan.normalHash,
      plan.environmentHash,
      plan.normalScale,
      plan.normalEnabled,
      plan.environmentIntensity,
      plan.environmentRotation,
    ].join("|");
    let cached = this.#bindGroups.get(instanceId);
    let uniform = this.#uniforms.get(instanceId);
    if (!uniform) {
      uniform = this.#device.createBuffer({
        label: `Mesh material map uniforms · ${instanceId}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.#uniforms.set(instanceId, uniform);
    }
    if (!cached || cached.key !== key) {
      this.#device.queue.writeBuffer(uniform, 0, materialBindingUniforms(plan));
      cached = {
        key,
        bindGroup: this.#device.createBindGroup({
          label: `Mesh normal + environment resources · ${instanceId}`,
          layout: this.#layout,
          entries: [
            { binding: 0, resource: normalTexture.createView() },
            { binding: 1, resource: environmentTexture.createView() },
            { binding: 2, resource: this.#normalSampler },
            { binding: 3, resource: this.#environmentSampler },
            { binding: 4, resource: { buffer: uniform } },
          ],
        }),
      };
      this.#bindGroups.set(instanceId, cached);
    }
    return { bindGroup: cached.bindGroup, pipeline: this.#pipeline(blendMode) };
  }

  #pipeline(blendMode: BlendMode): GPURenderPipeline {
    this.#pipelines ??= createMaterialShapePipelines(
      this.#device,
      this.#format,
      this.#lightingLayout,
      this.#layout,
    );
    return this.#pipelines[blendMode];
  }

  #ensureFallbackNormal(): GPUTexture {
    if (this.#fallbackNormal) return this.#fallbackNormal;
    this.#fallbackNormal = this.#device.createTexture({
      label: "Flat normal map fallback",
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture: this.#fallbackNormal },
      new Uint8Array([128, 128, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    return this.#fallbackNormal;
  }

  #ensureFallbackEnvironment(): GPUTexture {
    if (this.#fallbackEnvironment) return this.#fallbackEnvironment;
    this.#fallbackEnvironment = this.#device.createTexture({
      label: "Black HDR environment fallback",
      size: [1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture: this.#fallbackEnvironment },
      new Uint16Array([0, 0, 0, 0x3c00]),
      { bytesPerRow: 8 },
      [1, 1],
    );
    return this.#fallbackEnvironment;
  }
}
