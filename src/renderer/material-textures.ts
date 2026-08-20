import { runCpuTask } from "../core/cpu-scheduler";
import { logger } from "../core/logger";
import type { BlendMode, Composition, EnvironmentLighting, Layer } from "../core/types";
import { createMaterialShapePipelines } from "./scene-pipelines";

const MAX_NORMAL_DIMENSION = 4_096;
const MAX_NORMAL_BYTES = 64 * 1024 * 1024;

interface NormalResource {
  source: string;
  revision: number;
  texture?: GPUTexture;
  bytes: number;
  state: "loading" | "ready" | "failed";
  abort: AbortController;
  diagnosticReported?: boolean;
}

interface EnvironmentResource {
  source: string;
  revision: number;
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

export interface MaterialTexturePlan {
  active: boolean;
  normalEnabled: boolean;
  normalScale: number;
  environmentIntensity: number;
  environmentRotation: number;
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

export function planMaterialTextures(
  layer: Layer,
  environment: EnvironmentLighting | undefined,
  normalReady: boolean,
  environmentReady: boolean,
): MaterialTexturePlan {
  const normal = layer.kind === "mesh" ? layer.mesh?.materialTextures?.normal : undefined;
  const normalEnabled = Boolean(normal && normalReady);
  const environmentIntensity =
    environment?.enabled && environmentReady ? clampFinite(environment.intensity, 0, 32, 1) : 0;
  return {
    active: normalEnabled || environmentIntensity > 0,
    normalEnabled,
    normalScale: clampFinite(normal?.scale ?? 1, -8, 8, 1),
    environmentIntensity,
    environmentRotation: wrapDegrees(environment?.rotation ?? 0) / 360,
  };
}

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
  #revision = 0;

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

  get estimatedBytes(): number {
    const normalBytes = [...this.#normals.values()].reduce(
      (sum, resource) => sum + resource.bytes,
      0,
    );
    return normalBytes + (this.#environment?.bytes ?? 0) + this.#uniforms.size * 16;
  }

  prepare(
    composition: Composition,
    batches: readonly { layer: Layer; resourceInstanceId: string }[],
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
      resource.abort.abort();
      resource.texture?.destroy();
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
  }

  bindingFor(
    layer: Layer,
    instanceId: string,
    blendMode: BlendMode,
    environment: EnvironmentLighting | undefined,
  ): MaterialTextureBinding | undefined {
    if (layer.kind !== "mesh") return undefined;
    const normal = this.#normals.get(instanceId);
    const plan = planMaterialTextures(
      layer,
      environment,
      normal?.state === "ready",
      this.#environment?.state === "ready",
    );
    if (!plan.active) return undefined;
    const normalTexture = normal?.texture ?? this.#ensureFallbackNormal();
    const environmentTexture = this.#environment?.texture ?? this.#ensureFallbackEnvironment();
    const key = [
      normal?.revision ?? 0,
      normal?.state ?? "none",
      this.#environment?.revision ?? 0,
      this.#environment?.state ?? "none",
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
    existing?.abort.abort();
    existing?.texture?.destroy();
    const abort = new AbortController();
    const resource: NormalResource = {
      source,
      revision: ++this.#revision,
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
      .then((blob) => {
        if (blob.size === 0 || blob.size > MAX_NORMAL_BYTES)
          throw new Error("Encoded normal map exceeds the 64 MiB limit");
        return createImageBitmap(blob, { colorSpaceConversion: "none" });
      })
      .then((bitmap) => {
        if (this.#normals.get(instanceId) !== resource) {
          bitmap.close();
          return;
        }
        const bytes = bitmap.width * bitmap.height * 4;
        const maximum = Math.min(MAX_NORMAL_DIMENSION, this.#device.limits.maxTextureDimension2D);
        if (
          bitmap.width < 1 ||
          bitmap.height < 1 ||
          bitmap.width > maximum ||
          bitmap.height > maximum ||
          bytes > MAX_NORMAL_BYTES
        ) {
          bitmap.close();
          throw new Error("Normal map exceeds the 4096px or 64 MiB limit");
        }
        const texture = this.#device.createTexture({
          label: `Linear mesh normal map · ${instanceId}`,
          size: [bitmap.width, bitmap.height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.#device.queue.copyExternalImageToTexture(
          { source: bitmap, flipY: false },
          { texture },
          [bitmap.width, bitmap.height],
        );
        bitmap.close();
        resource.texture = texture;
        resource.bytes = bytes;
        resource.state = "ready";
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
      this.#environment.abort.abort();
      this.#environment?.texture?.destroy();
      this.#environment = undefined;
      this.#clearFailure("environment");
      this.#bindGroups.clear();
      return;
    }
    if (this.#environment?.source === source) return;
    this.#environment?.abort.abort();
    this.#environment?.texture?.destroy();
    const abort = new AbortController();
    const resource: EnvironmentResource = {
      source,
      revision: ++this.#revision,
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
      .then((decoded) => {
        if (this.#environment !== resource || abort.signal.aborted) return;
        if (!decoded.pixels) throw new Error("HDR worker returned no upload payload");
        const maximum = this.#device.limits.maxTextureDimension2D;
        if (decoded.width > maximum || decoded.height > maximum)
          throw new Error("HDR environment exceeds the GPU texture dimension limit");
        const texture = this.#device.createTexture({
          label: `Linear HDR environment · ${sourceName}`,
          size: [decoded.width, decoded.height],
          format: "rgba16float",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.#device.queue.writeTexture(
          { texture },
          decoded.pixels,
          { bytesPerRow: decoded.bytesPerRow, rowsPerImage: decoded.height },
          [decoded.width, decoded.height],
        );
        if (this.#environment !== resource) {
          texture.destroy();
          return;
        }
        resource.texture = texture;
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

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function wrapDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}
