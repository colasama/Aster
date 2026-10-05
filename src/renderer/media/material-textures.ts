import { logger } from "../../core/logger";
import { runCpuTask } from "../../core/scheduling/cpu-scheduler";
import type { BlendMode, Composition, EnvironmentLighting, Layer } from "../../core/types";
import { createMaterialShapePipelines } from "../scene/scene-pipelines";
import { prepareEncodedTexture, uploadEncodedTexture } from "./encoded-texture-upload";
import { prepareHdrTexture } from "./hdr-texture-resource";
import { type MaterialBindingPlan, planMaterialTextures } from "./material-texture-plan";
import { MaterialTextureRegistry } from "./material-texture-registry";
import { uploadTexturePixels } from "./texture-pixel-upload";

export { type MaterialTexturePlan, planMaterialTextures } from "./material-texture-plan";

interface NormalResource {
  source: string;
  hash?: string;
  texture?: GPUTexture;
  bytes: number;
  state: "loading" | "ready" | "failed";
  abort: AbortController;
  diagnosticReported?: boolean;
}

interface EnvironmentResource {
  source: string;
  hash?: string;
  texture?: GPUTexture;
  bytes: number;
  state: "loading" | "ready" | "failed";
  abort: AbortController;
  diagnosticReported?: boolean;
}

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

/** Lazily owns mesh material maps so the default beauty path pays no texture or pipeline cost. */
export class MaterialTextureRenderer {
  readonly #device: GPUDevice;
  readonly #lightingLayout: GPUBindGroupLayout;
  readonly #format: GPUTextureFormat;
  readonly #invalidate: () => void;
  readonly #layout: GPUBindGroupLayout;
  readonly #normalSampler: GPUSampler;
  readonly #environmentSampler: GPUSampler;
  readonly #reportDiagnostic: (message?: string) => void;
  readonly #normals = new Map<string, NormalResource>();
  readonly #failures = new Map<string, string>();
  readonly #uniforms = new Map<string, GPUBuffer>();
  readonly #bindGroups = new Map<string, { key: string; bindGroup: GPUBindGroup }>();
  #environment?: EnvironmentResource;
  #pipelines?: Record<BlendMode, GPURenderPipeline>;
  #fallbackNormal?: GPUTexture;
  #fallbackEnvironment?: GPUTexture;
  readonly #textures = new MaterialTextureRegistry();

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    lightingLayout: GPUBindGroupLayout,
    invalidate: () => void,
    reportDiagnostic: (message?: string) => void,
  ) {
    this.#device = device;
    this.#format = format;
    this.#lightingLayout = lightingLayout;
    this.#invalidate = invalidate;
    this.#reportDiagnostic = reportDiagnostic;
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

  destroy(): void {
    for (const resource of this.#normals.values()) {
      this.#retire(resource);
    }
    this.#normals.clear();
    this.#retire(this.#environment);
    this.#environment = undefined;
    for (const uniform of this.#uniforms.values()) uniform.destroy();
    this.#uniforms.clear();
    this.#bindGroups.clear();
    this.#failures.clear();
    this.#fallbackNormal?.destroy();
    this.#fallbackNormal = undefined;
    this.#fallbackEnvironment?.destroy();
    this.#fallbackEnvironment = undefined;
  }

  /** True while a normal map or environment is still decoding into its fallback texel. */
  get hasPendingResources(): boolean {
    if (this.#environment?.state === "loading") return true;
    for (const resource of this.#normals.values()) if (resource.state === "loading") return true;
    return false;
  }

  get estimatedBytes(): number {
    let normalBytes = 0;
    for (const resource of this.#normals.values()) normalBytes += resource.bytes;
    return normalBytes + (this.#environment?.bytes ?? 0) + this.#uniforms.size * 16;
  }

  prepare(
    composition: Composition,
    batches: readonly {
      layer: Layer;
      resourceInstanceId: string;
      materialTexturePlan?: MaterialBindingPlan;
    }[],
  ): void {
    const environmentActive = Boolean(
      composition.environment?.enabled && batches.some((batch) => batch.layer.kind === "mesh"),
    );
    const activeNormalInstances = new Set<string>();
    const activeBindingInstances = new Set<string>();
    for (const batch of batches) {
      const source = batch.layer.mesh?.materialTextures?.normal?.dataUrl;
      if (batch.layer.kind !== "mesh") continue;
      if (source || environmentActive) activeBindingInstances.add(batch.resourceInstanceId);
      if (!source) continue;
      activeNormalInstances.add(batch.resourceInstanceId);
      this.#prepareNormal(batch.resourceInstanceId, source);
    }
    for (const [instanceId, resource] of this.#normals) {
      if (activeNormalInstances.has(instanceId)) continue;
      this.#retire(resource);
      this.#normals.delete(instanceId);
      this.#clearFailure(`normal:${instanceId}`);
      this.#uniforms.get(instanceId)?.destroy();
      this.#uniforms.delete(instanceId);
      this.#bindGroups.delete(instanceId);
    }
    for (const [instanceId, uniform] of this.#uniforms) {
      if (activeBindingInstances.has(instanceId)) continue;
      uniform.destroy();
      this.#uniforms.delete(instanceId);
      this.#bindGroups.delete(instanceId);
    }
    this.#prepareEnvironment(environmentActive ? composition.environment : undefined);
    for (const batch of batches) {
      batch.materialTexturePlan = undefined;
      if (batch.layer.kind !== "mesh") continue;
      const normal = this.#normals.get(batch.resourceInstanceId);
      batch.materialTexturePlan = {
        ...planMaterialTextures(
          batch.layer,
          composition.environment,
          normal?.state === "ready",
          this.#environment?.state === "ready",
        ),
        instanceId: batch.resourceInstanceId,
        normalHash: normal?.state === "ready" ? (normal.hash ?? null) : null,
        environmentHash:
          this.#environment?.state === "ready" ? (this.#environment.hash ?? null) : null,
      };
    }
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
      this.#device.queue.writeBuffer(
        uniform,
        0,
        new Float32Array([
          plan.normalScale,
          plan.environmentIntensity,
          Number(plan.normalEnabled),
          plan.environmentRotation,
        ]),
      );
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

  #retire(resource: NormalResource | EnvironmentResource | undefined): void {
    if (!resource) return;
    resource.abort.abort();
    this.#textures.retire(resource.hash, resource.texture);
    if (resource.texture) this.#bindGroups.clear();
    resource.texture?.destroy();
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

  #prepareNormal(instanceId: string, source: string): void {
    const existing = this.#normals.get(instanceId);
    if (existing?.source === source) return;
    this.#retire(existing);
    const abort = new AbortController();
    const resource: NormalResource = {
      source,
      bytes: 0,
      state: "loading",
      abort,
    };
    this.#normals.set(instanceId, resource);
    this.#clearFailure(`normal:${instanceId}`);
    this.#bindGroups.delete(instanceId);
    void fetch(source, { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Normal map request failed with HTTP ${response.status}`);
        return response.blob();
      })
      .then(prepareEncodedTexture)
      .then(async (prepared) => {
        if (this.#normals.get(instanceId) !== resource || abort.signal.aborted) return;
        const uploaded = await uploadEncodedTexture(
          this.#device,
          prepared.message,
          prepared.bytes,
          `Linear mesh normal map · ${instanceId}`,
        );
        if (this.#normals.get(instanceId) !== resource || abort.signal.aborted) {
          uploaded.texture.destroy();
          return;
        }
        resource.texture = uploaded.texture;
        resource.hash = prepared.message.hash;
        resource.bytes = uploaded.bytes;
        resource.state = "ready";
        this.#textures.register(resource.hash, "normal", uploaded.texture);
        this.#clearFailure(`normal:${instanceId}`);
        this.#bindGroups.delete(instanceId);
        this.#invalidate();
      })
      .catch((error) => {
        if (abort.signal.aborted || this.#normals.get(instanceId) !== resource) return;
        resource.state = "failed";
        this.#reportFailure(resource, `normal:${instanceId}`, `Normal map ${instanceId}`, error);
      });
  }

  #prepareEnvironment(environment: EnvironmentLighting | undefined): void {
    const source = environment?.enabled ? environment.source.dataUrl : undefined;
    if (!source) {
      if (!this.#environment) return;
      this.#retire(this.#environment);
      this.#environment = undefined;
      this.#clearFailure("environment");
      this.#bindGroups.clear();
      return;
    }
    if (this.#environment?.source === source) return;
    this.#retire(this.#environment);
    const abort = new AbortController();
    const resource: EnvironmentResource = {
      source,
      bytes: 0,
      state: "loading",
      abort,
    };
    const sourceName = environment?.source.name ?? "environment.hdr";
    this.#environment = resource;
    this.#clearFailure("environment");
    this.#bindGroups.clear();
    if (source.length > 64 * 1024 * 1024) {
      resource.state = "failed";
      this.#reportFailure(
        resource,
        "environment",
        `HDR environment ${sourceName}`,
        new Error("encoded source exceeds 64 MiB"),
      );
      return;
    }
    void fetch(source, { signal: abort.signal })
      .then((response) => {
        if (!response.ok)
          throw new Error(`HDR environment request failed with HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) =>
        runCpuTask(
          { kind: "decode-radiance-hdr", source: buffer },
          {
            priority: "interactive",
            requireWorker: true,
            signal: abort.signal,
            timeoutMs: 30_000,
            transfer: [buffer],
          },
        ),
      )
      .then(async (decoded) => {
        if (this.#environment !== resource || abort.signal.aborted) return;
        const prepared = prepareHdrTexture(decoded);
        this.#device.pushErrorScope("validation");
        let texture: GPUTexture | undefined;
        try {
          let validationError: GPUError | null;
          try {
            texture = uploadTexturePixels(
              this.#device,
              prepared.message,
              prepared.bytes,
              `Linear HDR environment · ${sourceName}`,
            );
          } finally {
            validationError = await this.#device.popErrorScope();
          }
          if (validationError)
            throw new Error(`HDR environment GPU upload failed: ${validationError.message}`);
        } catch (error) {
          texture?.destroy();
          throw error;
        }
        if (this.#environment !== resource) {
          texture.destroy();
          return;
        }
        resource.texture = texture;
        resource.hash = prepared.message.hash;
        this.#textures.register(resource.hash, "environment", texture);
        resource.bytes = decoded.width * decoded.height * 8;
        resource.state = "ready";
        this.#clearFailure("environment");
        this.#bindGroups.clear();
        this.#invalidate();
      })
      .catch((error) => {
        if (abort.signal.aborted || this.#environment !== resource) return;
        resource.state = "failed";
        this.#reportFailure(resource, "environment", `HDR environment ${sourceName}`, error);
      });
  }

  #reportFailure(
    resource: NormalResource | EnvironmentResource,
    key: string,
    label: string,
    error: unknown,
  ): void {
    if (resource.diagnosticReported) return;
    resource.diagnosticReported = true;
    const message = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
    this.#failures.set(key, message);
    logger.warn("webgpu", "material_texture_failed", { resource: key, message }, error);
    this.#updateDiagnostic();
    this.#invalidate();
  }

  #clearFailure(key: string): void {
    if (!this.#failures.delete(key)) return;
    this.#updateDiagnostic();
  }

  #updateDiagnostic(): void {
    this.#reportDiagnostic(this.#failures.values().next().value);
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
