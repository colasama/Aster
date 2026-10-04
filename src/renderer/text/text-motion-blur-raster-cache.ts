import type { Layer } from "../../core/types";
import { buildTemporalPassSlice, readTemporalPassSlice } from "../frame-plan/temporal-pass-plan";
import type { FrameHeaderSlice, FramePlanSliceData } from "../frame-plan/types";
import { sharedShaders } from "../gpu/shared-shader-catalog";
import { MediaBindingLease } from "../media/media-binding-lease";
import { preparedRasterIdentity } from "../media/media-frame-identity";
import {
  destroyMediaResource,
  type MediaResource,
  mediaResourcePinned,
  mediaResourceRetired,
} from "../media/media-resource";
import {
  buildTemporalTextPassPlan,
  executeTemporalTextPassPlan,
} from "./text-motion-blur-pass-plan";
import type { TextMotionBlurPlan } from "./text-motion-blur-plan";
import {
  acquireTemporalTextRasters,
  planTemporalTextRaster,
} from "./text-motion-blur-raster-acquisition";
import { uploadTemporalTextRasters } from "./text-motion-blur-raster-upload";
import type { TextRasterBounds } from "./text-raster-bounds";
import { rasterizeTextLayer } from "./text-rasterizer";

export const MAX_TEXT_MOTION_BLUR_TRANSIENT_BYTES = 384 * 1024 * 1024;
export const MAX_TEXT_MOTION_BLUR_RESIDENT_BYTES = 384 * 1024 * 1024;
export const MAX_TEXT_MOTION_BLUR_CACHE_ENTRIES = 64;

export interface PreparedTextMotionBlurRaster {
  resource: MediaResource;
  bounds: TextRasterBounds;
  bindGroup: GPUBindGroup;
  source: string;
  textureBytes: number;
  transientBytes: number;
  sampleCount: number;
  resolutionScale: number;
}

export interface TextMotionBlurRasterFrameStats {
  drawCount: number;
  passCount: number;
  transientTextureCount: number;
  resolutionScaleReductionCount: number;
  lowestResolutionScale?: number;
}

interface TextMotionBlurEntry extends PreparedTextMotionBlurRaster {
  boundsSource: string;
  instanceId: string;
  width: number;
  height: number;
  output: GPUTexture;
  accumulation?: GPUTexture;
  sampleTextures: GPUTexture[];
  sampleBindGroups: GPUBindGroup[];
  sampleResources: MediaResource[];
  sampleWeights: number[];
  passLease?: MediaBindingLease;
  resolveBindGroup?: GPUBindGroup;
  weights?: GPUBuffer;
  encoded: boolean;
  frame: number;
}

interface TextMotionBlurRasterCacheOptions {
  maxEntries?: number;
  maxResidentBytes?: number;
  maxTransientBytes?: number;
  rasterize?: typeof rasterizeTextLayer;
  /** Diagnostic observer; sample owners remain valid until submitted() or abortSubmission(). */
  capturePass?: (plan: FramePlanSliceData, samples: readonly MediaResource[]) => void;
}

/**
 * GPU temporal accumulator for glyph pixels. Sample/accumulation textures live only until the
 * frame submission; the resolved straight-alpha sRGB texture remains as the current generation.
 */
export class TextMotionBlurRasterCache {
  readonly #device: GPUDevice;
  readonly #mediaLayout: GPUBindGroupLayout;
  readonly #mediaSampler: GPUSampler;
  readonly #sampleLayout: GPUBindGroupLayout;
  readonly #resolveLayout: GPUBindGroupLayout;
  readonly #accumulatePipeline: GPURenderPipeline;
  readonly #resolvePipeline: GPURenderPipeline;
  readonly #entries = new Map<string, TextMotionBlurEntry>();
  readonly #outputs = new Set<MediaResource>();
  readonly #maxEntries: number;
  readonly #maxResidentBytes: number;
  readonly #maxTransientBytes: number;
  readonly #rasterize: typeof rasterizeTextLayer;
  readonly #capturePass?: TextMotionBlurRasterCacheOptions["capturePass"];
  #frame = 0;
  #transientBytes = 0;
  #frameStats: TextMotionBlurRasterFrameStats = emptyFrameStats();
  #destroyed = false;

  constructor(
    device: GPUDevice,
    mediaLayout: GPUBindGroupLayout,
    mediaSampler: GPUSampler,
    options: TextMotionBlurRasterCacheOptions = {},
  ) {
    this.#device = device;
    this.#mediaLayout = mediaLayout;
    this.#mediaSampler = mediaSampler;
    this.#maxEntries = boundedInteger(
      options.maxEntries,
      1,
      MAX_TEXT_MOTION_BLUR_CACHE_ENTRIES,
      MAX_TEXT_MOTION_BLUR_CACHE_ENTRIES,
    );
    this.#maxResidentBytes = boundedInteger(
      options.maxResidentBytes,
      1,
      MAX_TEXT_MOTION_BLUR_RESIDENT_BYTES,
      MAX_TEXT_MOTION_BLUR_RESIDENT_BYTES,
    );
    this.#maxTransientBytes = boundedInteger(
      options.maxTransientBytes,
      1,
      MAX_TEXT_MOTION_BLUR_TRANSIENT_BYTES,
      MAX_TEXT_MOTION_BLUR_TRANSIENT_BYTES,
    );
    this.#rasterize = options.rasterize ?? rasterizeTextLayer;
    this.#capturePass = options.capturePass;
    this.#sampleLayout = device.createBindGroupLayout({
      label: "Temporal text sample layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.#resolveLayout = device.createBindGroupLayout({
      label: "Temporal text resolve layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
    });
    const module = device.createShaderModule({
      label: "Temporal text premultiplied accumulation shader",
      code: textMotionBlurRasterShader,
    });
    this.#accumulatePipeline = device.createRenderPipeline({
      label: "Temporal text linear HDR accumulation",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#sampleLayout] }),
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "accumulate_fragment",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#resolvePipeline = device.createRenderPipeline({
      label: "Temporal text straight-alpha sRGB resolve",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#resolveLayout] }),
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "resolve_fragment",
        targets: [{ format: "rgba8unorm-srgb" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  get estimatedBytes(): number {
    // Resolved outputs are already represented by MediaResource.textureBytes.
    return this.#transientBytes;
  }

  get frameStats(): TextMotionBlurRasterFrameStats {
    return { ...this.#frameStats };
  }

  beginFrame(): void {
    if (!this.#destroyed) {
      this.#frame += 1;
      this.#frameStats = emptyFrameStats();
    }
  }

  prepare(
    layer: Layer,
    instanceId: string,
    plan: TextMotionBlurPlan,
    resolutionScale: number,
  ): PreparedTextMotionBlurRaster {
    if (this.#destroyed) throw new Error("Text motion-blur raster cache is destroyed");
    const maximumDimension = Math.min(8_192, this.#device.limits.maxTextureDimension2D);
    const existing = this.#entries.get(instanceId);
    const availableTransient = Math.max(
      0,
      this.#maxTransientBytes - this.#transientBytes + (existing?.transientBytes ?? 0),
    );
    const availableResident = Math.max(0, this.#maxResidentBytes - this.#residentBytes());
    let prepared = planTemporalTextRaster(
      layer,
      plan,
      resolutionScale,
      maximumDimension,
      availableTransient,
      availableResident +
        (existing && !mediaResourceRetired(existing.resource) ? existing.textureBytes : 0),
      existing,
    );
    // An unchanged pinned generation needs no allocation; a replacement must budget both outputs.
    if (existing && mediaResourcePinned(existing.resource) && existing.source !== prepared.source)
      prepared = planTemporalTextRaster(
        layer,
        plan,
        resolutionScale,
        maximumDimension,
        availableTransient,
        availableResident,
        prepared,
      );
    const { bounds, boundsSource, source, samples, scale: scalePlan } = prepared;
    const { width, height, pixelBytes, resolutionScale: rasterScale } = scalePlan;
    if (scalePlan.reduced) {
      this.#frameStats.resolutionScaleReductionCount += 1;
      this.#frameStats.lowestResolutionScale = Math.min(
        this.#frameStats.lowestResolutionScale ?? rasterScale,
        rasterScale,
      );
    }
    if (existing?.source === source && !mediaResourceRetired(existing.resource)) {
      existing.frame = this.#frame;
      this.#entries.delete(instanceId);
      this.#entries.set(instanceId, existing);
      return existing;
    }
    const reuseOutput =
      existing?.width === width &&
      existing.height === height &&
      !mediaResourcePinned(existing.resource) &&
      !mediaResourceRetired(existing.resource);
    if (
      existing &&
      (existing.encoded || (existing.transientBytes > 0 && mediaResourcePinned(existing.resource)))
    )
      throw new Error("Temporal text generation must be submitted or aborted before replacement");
    const acquired = acquireTemporalTextRasters(layer, prepared, maximumDimension, this.#rasterize);
    if (existing) {
      if (reuseOutput) this.#destroyTransients(existing);
      else this.#delete(instanceId, existing);
    }
    if (!reuseOutput && !this.#reserveEntry(pixelBytes))
      throw new Error("Temporal text outputs exceed the bounded GPU resident budget");

    const uploaded = uploadTemporalTextRasters(acquired, {
      device: this.#device,
      sampleLayout: this.#sampleLayout,
      resolveLayout: this.#resolveLayout,
      mediaLayout: this.#mediaLayout,
      mediaSampler: this.#mediaSampler,
      reuse: reuseOutput ? existing : undefined,
    });
    const { transientBytes } = uploaded;
    const mediaIdentity = preparedRasterIdentity(prepared.sourceId, "text", source, bounds);
    const resource: MediaResource = reuseOutput ? existing.resource : { kind: "text", source };
    Object.assign(resource, {
      source,
      mediaIdentity,
      bindingGeneration: JSON.stringify([mediaIdentity, width, height]),
      texture: uploaded.output,
      bindGroup: uploaded.bindGroup,
      textureWidth: width,
      textureHeight: height,
      textureBytes: pixelBytes,
      textBounds: { ...bounds },
    });
    this.#outputs.add(resource);
    const entry: TextMotionBlurEntry = {
      resource,
      bounds,
      boundsSource,
      instanceId,
      width,
      height,
      source,
      ...uploaded,
      textureBytes: pixelBytes,
      transientBytes,
      sampleCount: samples.length,
      resolutionScale: rasterScale,
      encoded: false,
      frame: this.#frame,
    };
    this.#entries.delete(instanceId);
    this.#entries.set(instanceId, entry);
    this.#transientBytes += transientBytes;
    return entry;
  }

  encode(encoder: GPUCommandEncoder, scope = "local-preview", header?: FrameHeaderSlice): void {
    if (this.#destroyed) return;
    this.#frameStats = {
      ...emptyFrameStats(),
      resolutionScaleReductionCount: this.#frameStats.resolutionScaleReductionCount,
      lowestResolutionScale: this.#frameStats.lowestResolutionScale,
    };
    for (const entry of this.#entries.values()) {
      if (entry.encoded || !entry.accumulation || !entry.resolveBindGroup) continue;
      const lease = new MediaBindingLease(
        [
          { instanceId: "output", resource: entry.resource, binding: entry.bindGroup },
          ...entry.sampleResources.map((resource, index) => ({
            instanceId: `sample:${index}`,
            resource,
            binding: resource.bindGroup,
          })),
        ],
        scope,
      );
      try {
        const plan = buildTemporalTextPassPlan(
          entry.width,
          entry.height,
          entry.sampleWeights,
          lease,
        );
        const slice = header ? buildTemporalPassSlice(header, plan) : undefined;
        const supplied = slice ? readTemporalPassSlice(slice) : plan;
        executeTemporalTextPassPlan(supplied, lease, encoder, {
          queue: this.#device.queue,
          width: entry.width,
          height: entry.height,
          output: entry.output,
          outputBinding: entry.bindGroup,
          accumulation: entry.accumulation,
          weights: entry.weights,
          resolveBinding: entry.resolveBindGroup,
          accumulatePipeline: this.#accumulatePipeline,
          resolvePipeline: this.#resolvePipeline,
        });
        if (slice && this.#capturePass)
          this.#capturePass(structuredClone(slice), [...entry.sampleResources]);
        entry.passLease = lease;
      } catch (error) {
        lease.release();
        throw error;
      }
      this.#frameStats.drawCount += entry.sampleBindGroups.length + 1;
      this.#frameStats.passCount += 2;
      this.#frameStats.transientTextureCount += entry.sampleTextures.length + 1;
      entry.encoded = true;
    }
  }

  /** Releases command-buffer inputs after submit; the resolved output generation stays cached. */
  submitted(): void {
    if (this.#destroyed) return;
    for (const entry of this.#entries.values()) {
      if (!entry.encoded || entry.transientBytes === 0) continue;
      this.#destroyTransients(entry);
      entry.encoded = false;
    }
  }

  /** Drops generations whose command buffer was encoded but never submitted. */
  abortSubmission(): void {
    if (this.#destroyed) return;
    for (const [instanceId, entry] of [...this.#entries]) {
      if (entry.transientBytes === 0) continue;
      this.#delete(instanceId, entry);
    }
    this.#frameStats = emptyFrameStats();
  }

  sweep(activeInstanceIds: ReadonlySet<string>): void {
    for (const [instanceId, entry] of this.#entries) {
      if (activeInstanceIds.has(instanceId)) continue;
      this.#delete(instanceId, entry);
    }
  }

  delete(instanceId: string): void {
    const entry = this.#entries.get(instanceId);
    if (entry) this.#delete(instanceId, entry);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const entry of this.#entries.values()) this.#destroyEntry(entry);
    this.#entries.clear();
    this.#outputs.clear();
    this.#transientBytes = 0;
    this.#frameStats = emptyFrameStats();
  }

  #reserveEntry(requiredBytes: number): boolean {
    while (
      this.#entries.size >= this.#maxEntries ||
      this.#residentBytes() + requiredBytes > this.#maxResidentBytes
    ) {
      let oldest: [string, TextMotionBlurEntry] | undefined;
      for (const candidate of this.#entries) {
        if (candidate[1].frame >= this.#frame) continue;
        oldest = candidate;
        break;
      }
      if (!oldest) return false;
      this.#delete(oldest[0], oldest[1]);
    }
    return true;
  }

  #delete(instanceId: string, entry: TextMotionBlurEntry): void {
    if (this.#entries.get(instanceId) !== entry) return;
    this.#entries.delete(instanceId);
    this.#destroyEntry(entry);
  }

  #destroyEntry(entry: TextMotionBlurEntry): void {
    this.#destroyTransients(entry);
    destroyMediaResource(entry.resource);
    if (!mediaResourcePinned(entry.resource)) this.#outputs.delete(entry.resource);
  }

  #residentBytes(): number {
    let bytes = 0;
    for (const owner of this.#outputs) {
      if (mediaResourceRetired(owner) && !mediaResourcePinned(owner)) this.#outputs.delete(owner);
      else bytes += owner.textureBytes ?? 0;
    }
    return bytes;
  }

  #destroyTransients(entry: TextMotionBlurEntry): void {
    for (const resource of entry.sampleResources) destroyMediaResource(resource);
    entry.passLease?.release();
    entry.passLease = undefined;
    entry.sampleResources = [];
    entry.sampleWeights = [];
    entry.sampleTextures = [];
    entry.sampleBindGroups = [];
    entry.accumulation?.destroy();
    entry.accumulation = undefined;
    entry.resolveBindGroup = undefined;
    entry.weights?.destroy();
    entry.weights = undefined;
    this.#transientBytes = Math.max(0, this.#transientBytes - entry.transientBytes);
    entry.transientBytes = 0;
  }
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, finite)));
}

function emptyFrameStats(): TextMotionBlurRasterFrameStats {
  return {
    drawCount: 0,
    passCount: 0,
    transientTextureCount: 0,
    resolutionScaleReductionCount: 0,
  };
}

export const textMotionBlurRasterShader = sharedShaders.source("text-motion-blur-raster");
