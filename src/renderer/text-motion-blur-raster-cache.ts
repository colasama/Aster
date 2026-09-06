import { projectFontRevision } from "../core/project-font-runtime";
import type { Layer } from "../core/types";
import type { TextMotionBlurPlan, TextMotionBlurSample } from "./text-motion-blur-plan";
import { rasterizeTextLayer, textRasterResolutionScale, textRasterSize } from "./text-rasterizer";
import { TextureUploadBatch } from "./texture-upload-batch";

export const MAX_TEXT_MOTION_BLUR_TRANSIENT_BYTES = 384 * 1024 * 1024;
export const MAX_TEXT_MOTION_BLUR_RESIDENT_BYTES = 384 * 1024 * 1024;
export const MAX_TEXT_MOTION_BLUR_CACHE_ENTRIES = 64;
const WEIGHT_UNIFORM_STRIDE = 256;

export interface PreparedTextMotionBlurRaster {
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

export interface TextMotionBlurRasterScalePlan {
  requestedScale: number;
  resolutionScale: number;
  width: number;
  height: number;
  pixelBytes: number;
  minimumSampleCount: number;
  requiredTransientBytes: number;
  reduced: boolean;
}

interface TextMotionBlurEntry extends PreparedTextMotionBlurRaster {
  instanceId: string;
  width: number;
  height: number;
  output: GPUTexture;
  accumulation?: GPUTexture;
  sampleTextures: GPUTexture[];
  sampleBindGroups: GPUBindGroup[];
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
  readonly #uploads: TextureUploadBatch;
  readonly #entries = new Map<string, TextMotionBlurEntry>();
  readonly #maxEntries: number;
  readonly #maxResidentBytes: number;
  readonly #maxTransientBytes: number;
  readonly #rasterize: typeof rasterizeTextLayer;
  #frame = 0;
  #residentBytes = 0;
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
    this.#uploads = new TextureUploadBatch(device);
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
    return this.#transientBytes + this.#uploads.capacityBytes;
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
    const requestedScale = textRasterResolutionScale(resolutionScale);
    const maximumDimension = Math.min(8_192, this.#device.limits.maxTextureDimension2D);
    const existing = this.#entries.get(instanceId);
    const availableBytes = Math.max(
      0,
      this.#maxTransientBytes - this.#transientBytes + (existing?.transientBytes ?? 0),
    );
    const scalePlan = planTextMotionBlurRasterScale(
      layer,
      maximumDimension,
      requestedScale,
      plan.samples.length,
      availableBytes,
      Math.max(0, this.#maxResidentBytes - this.#residentBytes + (existing?.textureBytes ?? 0)),
    );
    const { width, height, pixelBytes, resolutionScale: rasterScale } = scalePlan;
    if (scalePlan.reduced) {
      this.#frameStats.resolutionScaleReductionCount += 1;
      this.#frameStats.lowestResolutionScale = Math.min(
        this.#frameStats.lowestResolutionScale ?? rasterScale,
        rasterScale,
      );
    }
    const samples = boundTextMotionBlurSamples(plan.samples, pixelBytes, availableBytes);
    if (plan.samples.length > 1 && samples.length < 2)
      throw new Error("Temporal text motion blur requires at least two canonical samples");
    if (plan.samples.length === 1 && samples.length === 0)
      throw new Error("Temporal text samples exceed the bounded GPU transient budget");
    if (pixelBytes * 2 > availableBytes)
      throw new Error("Temporal text accumulation exceeds the bounded GPU transient budget");
    const source = textMotionBlurRasterSource(layer, plan, samples, rasterScale);
    if (existing?.source === source) {
      existing.frame = this.#frame;
      this.#entries.delete(instanceId);
      this.#entries.set(instanceId, existing);
      return existing;
    }
    const reuseOutput = existing?.width === width && existing.height === height;
    if (reuseOutput && existing.encoded)
      throw new Error("Temporal text generation must be submitted or aborted before replacement");
    // Rasterize and validate the complete generation before mutating cache ownership or enqueuing
    // any upload. A later sample failure therefore cannot leave a destroyed texture in #uploads.
    const rasters = samples.map((sample) => {
      const raster = this.#rasterize(layer, maximumDimension, sample.localTime, rasterScale);
      if (raster.width !== width || raster.height !== height)
        throw new Error("Temporal text raster dimensions changed inside one shutter interval");
      if (raster.pixels.byteLength < pixelBytes)
        throw new Error("Temporal text raster pixel buffer is truncated");
      return raster;
    });
    if (existing) {
      if (reuseOutput) this.#destroyTransients(existing);
      else this.#delete(instanceId, existing);
    }
    if (!reuseOutput && !this.#reserveEntry(pixelBytes))
      throw new Error("Temporal text outputs exceed the bounded GPU resident budget");

    let output = reuseOutput ? existing.output : undefined;
    let accumulation: GPUTexture | undefined;
    let weights: GPUBuffer | undefined;
    let resolveBindGroup: GPUBindGroup | undefined;
    let bindGroup: GPUBindGroup | undefined;
    const weightData = new Float32Array((samples.length * WEIGHT_UNIFORM_STRIDE) / 4);
    const sampleTextures: GPUTexture[] = [];
    const sampleBindGroups: GPUBindGroup[] = [];
    try {
      output ??= this.#device.createTexture({
        label: `Temporal text output · ${layer.name}`,
        size: [width, height],
        format: "rgba8unorm-srgb",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      accumulation = this.#device.createTexture({
        label: `Temporal text linear accumulation · ${layer.name}`,
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      weights =
        samples.length > 0
          ? this.#device.createBuffer({
              label: `Temporal text sample weights · ${layer.name}`,
              size: samples.length * WEIGHT_UNIFORM_STRIDE,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
          : undefined;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        const texture = this.#device.createTexture({
          label: `Temporal text sample ${index + 1}/${samples.length} · ${layer.name}`,
          size: [width, height],
          format: "rgba8unorm-srgb",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        sampleTextures.push(texture);
        weightData[(index * WEIGHT_UNIFORM_STRIDE) / 4] = sample.weight;
        sampleBindGroups.push(
          this.#device.createBindGroup({
            label: `Temporal text sample binding · ${layer.id} · ${sample.timeBucket}`,
            layout: this.#sampleLayout,
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: this.#mediaSampler },
              {
                binding: 2,
                resource: {
                  buffer: weights as GPUBuffer,
                  offset: index * WEIGHT_UNIFORM_STRIDE,
                  size: 16,
                },
              },
            ],
          }),
        );
      }
      resolveBindGroup = this.#device.createBindGroup({
        label: `Temporal text resolve binding · ${layer.id}`,
        layout: this.#resolveLayout,
        entries: [{ binding: 0, resource: accumulation.createView() }],
      });
      bindGroup =
        existing && reuseOutput
          ? existing.bindGroup
          : this.#device.createBindGroup({
              label: `Temporal text media binding · ${layer.id}`,
              layout: this.#mediaLayout,
              entries: [
                { binding: 0, resource: output.createView() },
                { binding: 1, resource: this.#mediaSampler },
              ],
            });
      if (weights) this.#device.queue.writeBuffer(weights, 0, weightData);
      for (let index = 0; index < sampleTextures.length; index += 1)
        this.#uploads.enqueue(sampleTextures[index], rasters[index].pixels, width, height);
    } catch (error) {
      for (const texture of sampleTextures) texture.destroy();
      accumulation?.destroy();
      if (!reuseOutput) output?.destroy();
      weights?.destroy();
      throw error;
    }
    if (!output || !accumulation || !resolveBindGroup || !bindGroup)
      throw new Error("Temporal text generation did not initialize its GPU resources");
    const transientBytes = pixelBytes * samples.length + pixelBytes * 2 + (weights?.size ?? 0);
    const entry: TextMotionBlurEntry = {
      instanceId,
      width,
      height,
      source,
      output,
      accumulation,
      sampleTextures,
      sampleBindGroups,
      resolveBindGroup,
      weights,
      bindGroup,
      textureBytes: pixelBytes,
      transientBytes,
      sampleCount: samples.length,
      resolutionScale: rasterScale,
      encoded: false,
      frame: this.#frame,
    };
    this.#entries.delete(instanceId);
    this.#entries.set(instanceId, entry);
    if (!reuseOutput) this.#residentBytes += pixelBytes;
    this.#transientBytes += transientBytes;
    return entry;
  }

  encode(encoder: GPUCommandEncoder): void {
    if (this.#destroyed) return;
    this.#frameStats = {
      ...emptyFrameStats(),
      resolutionScaleReductionCount: this.#frameStats.resolutionScaleReductionCount,
      lowestResolutionScale: this.#frameStats.lowestResolutionScale,
    };
    this.#uploads.flush(encoder);
    for (const entry of this.#entries.values()) {
      if (entry.encoded || !entry.accumulation || !entry.resolveBindGroup) continue;
      const accumulation = encoder.beginRenderPass({
        label: "Temporal text premultiplied linear accumulation",
        colorAttachments: [
          {
            view: entry.accumulation.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      accumulation.setPipeline(this.#accumulatePipeline);
      for (const bindGroup of entry.sampleBindGroups) {
        accumulation.setBindGroup(0, bindGroup);
        accumulation.draw(3);
      }
      accumulation.end();
      const resolve = encoder.beginRenderPass({
        label: "Temporal text straight-alpha sRGB resolve",
        colorAttachments: [
          {
            view: entry.output.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      resolve.setPipeline(this.#resolvePipeline);
      resolve.setBindGroup(0, entry.resolveBindGroup);
      resolve.draw(3);
      resolve.end();
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
    this.#uploads.destroy();
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
    this.#residentBytes = 0;
    this.#transientBytes = 0;
    this.#frameStats = emptyFrameStats();
    this.#uploads.destroy();
  }

  #reserveEntry(requiredBytes: number): boolean {
    while (
      this.#entries.size >= this.#maxEntries ||
      this.#residentBytes + requiredBytes > this.#maxResidentBytes
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
    entry.output.destroy();
    this.#residentBytes = Math.max(0, this.#residentBytes - entry.textureBytes);
  }

  #destroyTransients(entry: TextMotionBlurEntry): void {
    for (const texture of entry.sampleTextures) texture.destroy();
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

export function boundTextMotionBlurSamples(
  samples: readonly TextMotionBlurSample[],
  pixelBytes: number,
  byteBudget: number,
): TextMotionBlurSample[] {
  if (samples.length === 0) return [];
  const bytes = Math.max(4, Math.floor(pixelBytes));
  const budget = Math.max(0, Math.floor(byteBudget));
  // One linear RGBA16F accumulation, sample RGBA8 textures, and aligned uniform weights consume
  // transient space. The resolved RGBA8 output is governed by the separate resident budget.
  const fixedBytes = bytes * 2;
  const maximumSamples = Math.min(
    samples.length,
    Math.max(0, Math.floor((budget - fixedBytes) / (bytes + WEIGHT_UNIFORM_STRIDE))),
  );
  if (maximumSamples <= 0) return [];
  if (maximumSamples >= samples.length) return samples.map((sample) => ({ ...sample }));
  const selectedIndices = Array.from({ length: maximumSamples }, (_, index) =>
    maximumSamples === 1
      ? Math.floor((samples.length - 1) / 2)
      : Math.round((index * (samples.length - 1)) / (maximumSamples - 1)),
  );
  const selected = selectedIndices.map((index) => ({ ...samples[index], weight: 0 }));
  for (let index = 0; index < samples.length; index += 1) {
    let nearest = 0;
    for (let candidate = 1; candidate < selectedIndices.length; candidate += 1)
      if (Math.abs(selectedIndices[candidate] - index) < Math.abs(selectedIndices[nearest] - index))
        nearest = candidate;
    selected[nearest].weight += samples[index].weight;
  }
  return selected;
}

export function planTextMotionBlurRasterScale(
  layer: Pick<Layer, "size">,
  maximumDimension: number,
  requestedResolutionScale: number,
  canonicalSampleCount: number,
  transientBudget: number,
  residentBudget: number,
): TextMotionBlurRasterScalePlan {
  const requestedScale = textRasterResolutionScale(requestedResolutionScale);
  const minimumSampleCount = canonicalSampleCount > 1 ? 2 : Math.max(0, canonicalSampleCount);
  const scales = discreteTextRasterScales(requestedScale);
  for (let index = scales.length - 1; index >= 0; index -= 1) {
    const resolutionScale = scales[index];
    const { width, height } = textRasterSize(layer, maximumDimension, resolutionScale);
    const pixelBytes = width * height * 4;
    const requiredTransientBytes =
      pixelBytes * 2 + minimumSampleCount * (pixelBytes + WEIGHT_UNIFORM_STRIDE);
    if (pixelBytes > residentBudget || requiredTransientBytes > transientBudget) continue;
    return {
      requestedScale,
      resolutionScale,
      width,
      height,
      pixelBytes,
      minimumSampleCount,
      requiredTransientBytes,
      reduced: resolutionScale < requestedScale,
    };
  }
  const { width, height } = textRasterSize(layer, maximumDimension, 1);
  const pixelBytes = width * height * 4;
  const requiredTransientBytes =
    pixelBytes * 2 + minimumSampleCount * (pixelBytes + WEIGHT_UNIFORM_STRIDE);
  if (pixelBytes > residentBudget)
    throw new Error(
      `Temporal text motion blur ${width}×${height} requires ${pixelBytes} resident bytes; budget is ${Math.max(0, Math.floor(residentBudget))}`,
    );
  throw new Error(
    `Temporal text motion blur ${width}×${height} requires ${requiredTransientBytes} transient bytes for ${minimumSampleCount} samples at 1x; budget is ${Math.max(0, Math.floor(transientBudget))}`,
  );
}

export function textMotionBlurRasterSource(
  layer: Layer,
  plan: TextMotionBlurPlan,
  samples: readonly TextMotionBlurSample[],
  resolutionScale: number,
): string {
  return JSON.stringify([
    "text-motion-blur-v1",
    layer.text,
    layer.name,
    layer.color,
    layer.size,
    layer.textStyle,
    projectFontRevision(),
    layer.textAnimator,
    samples.map((sample) => [sample.timeBucket, sample.weight]),
    plan.transparentWeight,
    resolutionScale,
  ]);
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

function discreteTextRasterScales(maximum: number): number[] {
  const result = [1];
  while (result[result.length - 1] < maximum) {
    const next = Math.min(maximum, result[result.length - 1] * 1.25);
    if (next <= result[result.length - 1]) break;
    result.push(next);
  }
  return result;
}

export const textMotionBlurRasterShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
struct SampleWeight {
  value: vec4f,
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

@group(0) @binding(0) var sample_texture: texture_2d<f32>;
@group(0) @binding(1) var sample_sampler: sampler;
@group(0) @binding(2) var<uniform> sample_weight: SampleWeight;

@fragment fn accumulate_fragment(input: VertexOutput) -> @location(0) vec4f {
  let straight = textureSampleLevel(sample_texture, sample_sampler, input.uv, 0.0);
  let alpha = straight.a * sample_weight.value.x;
  return vec4f(straight.rgb * alpha, alpha);
}

@fragment fn resolve_fragment(input: VertexOutput) -> @location(0) vec4f {
  let pixel = clamp(
    vec2i(input.position.xy),
    vec2i(0),
    vec2i(textureDimensions(sample_texture)) - vec2i(1),
  );
  let premultiplied = textureLoad(sample_texture, pixel, 0);
  let straight = select(vec3f(0.0), premultiplied.rgb / max(premultiplied.a, 0.000001),
    premultiplied.a > 0.000001);
  return vec4f(straight, premultiplied.a);
}
`;
