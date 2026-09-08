import type { MotionBlurSettings } from "../../core/types";

const TILE_SIZE = 16;
export const MOTION_BLUR_UNIFORM_BYTES = 32;

export interface MotionBlurFrameSettings extends MotionBlurSettings {
  /** Frame-time position within the shutter interval: 0=open, 1=close. */
  framePosition: number;
  maximumRadius: number;
}

export interface MotionBlurTexturePlan {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  estimatedBytes: number;
}

export function planMotionBlurTextures(width: number, height: number): MotionBlurTexturePlan {
  const safeWidth = boundedDimension(width);
  const safeHeight = boundedDimension(height);
  const tileWidth = Math.ceil(safeWidth / TILE_SIZE);
  const tileHeight = Math.ceil(safeHeight / TILE_SIZE);
  return {
    width: safeWidth,
    height: safeHeight,
    tileWidth,
    tileHeight,
    estimatedBytes: safeWidth * safeHeight * 8 + tileWidth * tileHeight * 8 * 2,
  };
}

/** Packs viewport, sample limits, radius, and shutter placement into two vec4 slots. */
export function buildMotionBlurUniforms(
  width: number,
  height: number,
  settings: MotionBlurFrameSettings,
): ArrayBuffer {
  const buffer = new ArrayBuffer(MOTION_BLUR_UNIFORM_BYTES);
  new Float32Array(buffer, 0, 2).set([boundedDimension(width), boundedDimension(height)]);
  const baseSamples = boundedInteger(settings.samplesPerFrame, 2, 64, 8);
  new Uint32Array(buffer, 8, 2).set([
    baseSamples,
    Math.max(baseSamples, boundedInteger(settings.adaptiveSampleLimit, 2, 128, 32)),
  ]);
  new Float32Array(buffer, 16, 4).set([
    bounded(settings.maximumRadius, 0, 256, 128),
    bounded(settings.framePosition, -4, 4, 0.5),
    0,
    0,
  ]);
  return buffer;
}

/**
 * GPU-only tile-max, neighbor-max, and ID-aware reconstruction in premultiplied linear HDR. The
 * output remains scene-linear so depth of field and the canonical display transform can follow it.
 */
export class MotionBlurRenderer {
  readonly #device: GPUDevice;
  readonly #tilePipeline: GPURenderPipeline;
  readonly #neighborPipeline: GPURenderPipeline;
  readonly #reconstructionPipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #uniform: GPUBuffer;
  #output?: GPUTexture;
  #tileMax?: GPUTexture;
  #neighborMax?: GPUTexture;
  #tileBindGroup?: GPUBindGroup;
  #neighborBindGroup?: GPUBindGroup;
  #reconstructionBindGroup?: GPUBindGroup;
  #plan = planMotionBlurTextures(1, 1);

  constructor(device: GPUDevice, format: GPUTextureFormat = "rgba16float") {
    this.#device = device;
    const module = device.createShaderModule({
      label: "Time-addressed vector motion-blur shader",
      code: motionBlurShader,
    });
    this.#tilePipeline = device.createRenderPipeline({
      label: "Motion blur tile-max pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "tile_max_fragment", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.#neighborPipeline = device.createRenderPipeline({
      label: "Motion blur neighbor-max pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "neighbor_max_fragment", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.#reconstructionPipeline = device.createRenderPipeline({
      label: "Motion blur ID-aware HDR reconstruction pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "reconstruct_fragment", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.#sampler = device.createSampler({
      label: "Motion blur HDR linear sampler",
      minFilter: "linear",
      magFilter: "linear",
    });
    this.#uniform = device.createBuffer({
      label: "Motion blur reconstruction uniforms",
      size: MOTION_BLUR_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get outputTexture(): GPUTexture | undefined {
    return this.#output;
  }

  get estimatedBytes(): number {
    return this.#output ? this.#plan.estimatedBytes + MOTION_BLUR_UNIFORM_BYTES : 0;
  }

  setSources(
    width: number,
    height: number,
    scene: GPUTexture | undefined,
    motionVectors: GPUTexture | undefined,
    objectIds: GPUTexture | undefined,
    byteBudget = Number.POSITIVE_INFINITY,
  ): void {
    const plan = planMotionBlurTextures(width, height);
    const resized = plan.width !== this.#plan.width || plan.height !== this.#plan.height;
    this.#plan = plan;
    if (!scene || !motionVectors || !objectIds || plan.estimatedBytes > Math.max(0, byteBudget)) {
      this.#destroyTargets();
      return;
    }
    if (resized || !this.#output || !this.#tileMax || !this.#neighborMax) this.#allocateTargets();
    const output = this.#output;
    const tileMax = this.#tileMax;
    const neighborMax = this.#neighborMax;
    if (!output || !tileMax || !neighborMax) {
      this.#clearBindings();
      return;
    }
    this.#tileBindGroup = this.#device.createBindGroup({
      label: "Motion blur tile-max resources",
      layout: this.#tilePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: motionVectors.createView() },
        { binding: 1, resource: { buffer: this.#uniform } },
      ],
    });
    this.#neighborBindGroup = this.#device.createBindGroup({
      label: "Motion blur neighbor-max resources",
      layout: this.#neighborPipeline.getBindGroupLayout(0),
      entries: [{ binding: 2, resource: tileMax.createView() }],
    });
    this.#reconstructionBindGroup = this.#device.createBindGroup({
      label: "Motion blur scene + vectors + object IDs",
      layout: this.#reconstructionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 3, resource: scene.createView() },
        { binding: 4, resource: motionVectors.createView() },
        { binding: 5, resource: objectIds.createView() },
        { binding: 6, resource: neighborMax.createView() },
        { binding: 7, resource: this.#sampler },
        { binding: 8, resource: { buffer: this.#uniform } },
      ],
    });
  }

  encode(encoder: GPUCommandEncoder, settings: MotionBlurFrameSettings): boolean {
    const output = this.#output;
    const tileMax = this.#tileMax;
    const neighborMax = this.#neighborMax;
    if (
      !output ||
      !tileMax ||
      !neighborMax ||
      !this.#tileBindGroup ||
      !this.#neighborBindGroup ||
      !this.#reconstructionBindGroup
    )
      return false;
    this.#device.queue.writeBuffer(
      this.#uniform,
      0,
      buildMotionBlurUniforms(this.#plan.width, this.#plan.height, settings),
    );
    const tilePass = encoder.beginRenderPass({
      label: "Motion blur tile-max",
      colorAttachments: [
        {
          view: tileMax.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    tilePass.setPipeline(this.#tilePipeline);
    tilePass.setBindGroup(0, this.#tileBindGroup);
    tilePass.draw(3);
    tilePass.end();
    const neighborPass = encoder.beginRenderPass({
      label: "Motion blur neighbor-max",
      colorAttachments: [
        {
          view: neighborMax.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    neighborPass.setPipeline(this.#neighborPipeline);
    neighborPass.setBindGroup(0, this.#neighborBindGroup);
    neighborPass.draw(3);
    neighborPass.end();
    const reconstructionPass = encoder.beginRenderPass({
      label: "Motion blur ID-aware linear HDR reconstruction",
      colorAttachments: [
        {
          view: output.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    reconstructionPass.setPipeline(this.#reconstructionPipeline);
    reconstructionPass.setBindGroup(0, this.#reconstructionBindGroup);
    reconstructionPass.draw(3);
    reconstructionPass.end();
    return true;
  }

  destroy(): void {
    this.#destroyTargets();
    this.#uniform.destroy();
  }

  #allocateTargets(): void {
    this.#destroyTargets();
    this.#output = this.#device.createTexture({
      label: "Motion-blurred linear HDR scene",
      size: [this.#plan.width, this.#plan.height],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#tileMax = this.#device.createTexture({
      label: `Motion blur tile max · ${TILE_SIZE}×${TILE_SIZE}`,
      size: [this.#plan.tileWidth, this.#plan.tileHeight],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#neighborMax = this.#device.createTexture({
      label: "Motion blur neighbor max",
      size: [this.#plan.tileWidth, this.#plan.tileHeight],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  #destroyTargets(): void {
    this.#output?.destroy();
    this.#tileMax?.destroy();
    this.#neighborMax?.destroy();
    this.#output = undefined;
    this.#tileMax = undefined;
    this.#neighborMax = undefined;
    this.#clearBindings();
  }

  #clearBindings(): void {
    this.#tileBindGroup = undefined;
    this.#neighborBindGroup = undefined;
    this.#reconstructionBindGroup = undefined;
  }
}

function boundedDimension(value: number): number {
  return Math.min(16_384, Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)));
}

function bounded(value: number, minimum: number, maximum: number, fallback: number): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, finite));
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.round(bounded(value, minimum, maximum, fallback));
}

export const motionBlurShader = /* wgsl */ `
struct Settings {
  viewport: vec2f,
  base_samples: u32,
  adaptive_limit: u32,
  maximum_radius: f32,
  frame_position: f32,
  padding: vec2f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

@group(0) @binding(0) var tile_motion_vectors: texture_2d<f32>;
@group(0) @binding(1) var<uniform> tile_settings: Settings;

@fragment fn tile_max_fragment(input: VertexOutput) -> @location(0) vec4f {
  let tile_pixel = vec2i(input.position.xy);
  let source_size = vec2i(textureDimensions(tile_motion_vectors));
  let origin = tile_pixel * ${TILE_SIZE};
  var maximum = vec2f(0.0);
  var maximum_length = 0.0;
  for (var y = 0; y < ${TILE_SIZE}; y += 1) {
    for (var x = 0; x < ${TILE_SIZE}; x += 1) {
      let pixel = origin + vec2i(x, y);
      if (all(pixel < source_size)) {
        let velocity = textureLoad(tile_motion_vectors, pixel, 0).xy;
        let pixel_length = length(velocity * tile_settings.viewport);
        if (pixel_length > maximum_length) {
          maximum = velocity;
          maximum_length = pixel_length;
        }
      }
    }
  }
  return vec4f(maximum, maximum_length, 1.0);
}

@group(0) @binding(2) var tile_maximum: texture_2d<f32>;

@fragment fn neighbor_max_fragment(input: VertexOutput) -> @location(0) vec4f {
  let center = vec2i(input.position.xy);
  let size = vec2i(textureDimensions(tile_maximum));
  var maximum = vec4f(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let sample_pixel = clamp(center + vec2i(x, y), vec2i(0), size - vec2i(1));
      let candidate = textureLoad(tile_maximum, sample_pixel, 0);
      if (candidate.z > maximum.z) { maximum = candidate; }
    }
  }
  return maximum;
}

@group(0) @binding(3) var hdr_scene: texture_2d<f32>;
@group(0) @binding(4) var motion_vectors: texture_2d<f32>;
@group(0) @binding(5) var object_ids: texture_2d<u32>;
@group(0) @binding(6) var neighbor_maximum: texture_2d<f32>;
@group(0) @binding(7) var linear_sampler: sampler;
@group(0) @binding(8) var<uniform> settings: Settings;

fn in_bounds(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}

fn motion_at(pixel: vec2i) -> vec2f {
  let raw = textureLoad(motion_vectors, pixel, 0).xy;
  let pixel_length = length(raw * settings.viewport);
  return raw * min(1.0, settings.maximum_radius / max(pixel_length, 0.0001));
}

fn covers_pixel(source_uv: vec2f, target_uv: vec2f, source_motion: vec2f) -> bool {
  let motion_pixels = source_motion * settings.viewport;
  let length_squared = dot(motion_pixels, motion_pixels);
  if (length_squared < 0.0625) { return false; }
  let target_offset = (target_uv - source_uv) * settings.viewport;
  let along = dot(target_offset, motion_pixels) / length_squared;
  let perpendicular = abs(target_offset.x * motion_pixels.y - target_offset.y * motion_pixels.x) /
    sqrt(length_squared);
  return along >= -settings.frame_position && along <= 1.0 - settings.frame_position &&
    perpendicular <= 1.25;
}

@fragment fn reconstruct_fragment(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(settings.viewport);
  let pixel = clamp(vec2i(input.uv * settings.viewport), vec2i(0), size - vec2i(1));
  let center = textureSampleLevel(hdr_scene, linear_sampler, input.uv, 0.0);
  let center_id = textureLoad(object_ids, pixel, 0).x;
  let center_motion = motion_at(pixel);
  let tile_size = vec2i(textureDimensions(neighbor_maximum));
  let tile_pixel = clamp(pixel / ${TILE_SIZE}, vec2i(0), tile_size - vec2i(1));
  let neighbor_motion = textureLoad(neighbor_maximum, tile_pixel, 0).xy;
  let dominant = select(neighbor_motion, center_motion,
    length(center_motion * settings.viewport) > length(neighbor_motion * settings.viewport) * 0.25);
  let pixel_travel = min(length(dominant * settings.viewport), settings.maximum_radius);
  if (pixel_travel < 0.25) { return center; }
  let sample_count = min(settings.adaptive_limit,
    max(settings.base_samples, u32(ceil(pixel_travel / 4.0)) + 1u));
  var accumulated = center;
  var weight_sum = 1.0;
  for (var index = 0u; index < 128u; index += 1u) {
    if (index >= sample_count) { break; }
    let exposure_position = (f32(index) + 0.5) / f32(sample_count) - settings.frame_position;
    let sample_uv = input.uv + dominant * exposure_position;
    if (!in_bounds(sample_uv)) { continue; }
    let sample_pixel = clamp(vec2i(sample_uv * settings.viewport), vec2i(0), size - vec2i(1));
    let sample_motion = motion_at(sample_pixel);
    let sample_id = textureLoad(object_ids, sample_pixel, 0).x;
    let same_surface = center_id != 0u && sample_id == center_id;
    let moving_foreground = sample_id != 0u && covers_pixel(sample_uv, input.uv, sample_motion);
    if (!same_surface && !moving_foreground) { continue; }
    let color = textureSampleLevel(hdr_scene, linear_sampler, sample_uv, 0.0);
    let exposure_weight = max(0.08, 1.0 - abs(exposure_position) * 0.35);
    let coverage_weight = select(0.7, 1.0, same_surface);
    let weight = exposure_weight * coverage_weight * max(color.a, 0.02);
    accumulated += color * weight;
    weight_sum += weight;
  }
  return accumulated / max(weight_sum, 0.0001);
}
`;
