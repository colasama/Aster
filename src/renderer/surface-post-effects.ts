import type { GeometryBatch } from "./geometry";
import { encodeRenderId, type SurfaceEffectVisualization } from "./render-buffers";

export const SURFACE_POST_UNIFORM_BYTES = 32;

const MODE_CODES: Readonly<Record<SurfaceEffectVisualization, number>> = {
  selectionIsolation: 1,
  vectorMotionBlur: 2,
};

/** The object MRT stores root selection IDs, so every clone shares this one stable hash. */
export function selectedRenderId(
  batches: readonly Pick<GeometryBatch, "selectionId">[],
  selectedLayerId: string | undefined,
  particleSelectionId?: string,
): number {
  if (!selectedLayerId) return 0;
  const visible =
    particleSelectionId === selectedLayerId ||
    batches.some((batch) => batch.selectionId === selectedLayerId);
  return visible ? encodeRenderId(selectedLayerId) : 0;
}

/** Packs viewport, mode, selected root ID, and normalized shutter scale into two vec4 slots. */
export function buildSurfacePostUniforms(
  mode: SurfaceEffectVisualization,
  width: number,
  height: number,
  renderId: number,
  motionShutterScale: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(SURFACE_POST_UNIFORM_BYTES);
  new Float32Array(buffer, 0, 2).set([boundedDimension(width), boundedDimension(height)]);
  new Uint32Array(buffer, 8, 2).set([
    MODE_CODES[mode],
    Number.isInteger(renderId) && renderId > 0 ? renderId : 0,
  ]);
  new Float32Array(buffer, 16, 4).set([bounded(motionShutterScale, 0, 4), 0, 0, 0]);
  return buffer;
}

/** Real HDR post effects driven by the object-ID and motion-vector MRT attachments. */
export class SurfacePostEffectsRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #uniform: GPUBuffer;
  #bindGroup?: GPUBindGroup;
  #width = 1;
  #height = 1;
  #selectedRenderId = 0;
  #motionShutterScale = 0;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    const module = device.createShaderModule({
      label: "Object-ID isolation and vector motion-blur shader",
      code: surfacePostEffectsShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: "Object-ID isolation and vector motion-blur pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: outputFormat }] },
      primitive: { topology: "triangle-list" },
    });
    this.#sampler = device.createSampler({
      label: "Surface post-effect HDR sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.#uniform = device.createBuffer({
      label: "Surface post-effect uniforms",
      size: SURFACE_POST_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get estimatedBytes(): number {
    return SURFACE_POST_UNIFORM_BYTES;
  }

  setSources(
    width: number,
    height: number,
    scene: GPUTexture | undefined,
    objectIds: GPUTexture | undefined,
    motionVectors: GPUTexture | undefined,
  ): void {
    this.#width = boundedDimension(width);
    this.#height = boundedDimension(height);
    this.#bindGroup =
      scene && objectIds && motionVectors
        ? this.#device.createBindGroup({
            label: "HDR + Object ID + Motion Vector post resources",
            layout: this.#pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: scene.createView() },
              { binding: 1, resource: this.#sampler },
              { binding: 2, resource: objectIds.createView() },
              { binding: 3, resource: motionVectors.createView() },
              { binding: 4, resource: { buffer: this.#uniform } },
            ],
          })
        : undefined;
  }

  setSelection(renderId: number): void {
    this.#selectedRenderId = renderId;
  }

  setMotionShutterScale(scale: number): void {
    this.#motionShutterScale = scale;
  }

  encode(pass: GPURenderPassEncoder, mode: SurfaceEffectVisualization): boolean {
    if (!this.#bindGroup) return false;
    this.#device.queue.writeBuffer(
      this.#uniform,
      0,
      buildSurfacePostUniforms(
        mode,
        this.#width,
        this.#height,
        this.#selectedRenderId,
        this.#motionShutterScale,
      ),
    );
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
    return true;
  }

  destroy(): void {
    this.#bindGroup = undefined;
    this.#uniform.destroy();
  }
}

function boundedDimension(value: number): number {
  return Math.min(16_384, Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)));
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

export const surfacePostEffectsShader = /* wgsl */ `
struct Settings {
  viewport: vec2f,
  mode: u32,
  selected_id: u32,
  motion: vec4f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@group(0) @binding(0) var hdr_scene: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var object_ids: texture_2d<u32>;
@group(0) @binding(3) var motion_vectors: texture_2d<f32>;
@group(0) @binding(4) var<uniform> settings: Settings;

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = positions[index] * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}

fn aces_tonemap(value: vec3f) -> vec3f {
  let numerator = value * (2.51 * value + vec3f(0.03));
  let denominator = value * (2.43 * value + vec3f(0.59)) + vec3f(0.14);
  return pow(clamp(numerator / denominator, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}

fn pixel_at(uv: vec2f) -> vec2i {
  let size = vec2i(settings.viewport);
  return clamp(vec2i(uv * settings.viewport), vec2i(0), size - vec2i(1));
}

fn is_selected(id: u32) -> bool {
  return settings.selected_id != 0u && id == settings.selected_id;
}

fn selection_glow(pixel: vec2i) -> f32 {
  let size = vec2i(settings.viewport);
  let offsets = array<vec2i, 12>(
    vec2i(-2, 0), vec2i(2, 0), vec2i(0, -2), vec2i(0, 2),
    vec2i(-4, -4), vec2i(4, -4), vec2i(-4, 4), vec2i(4, 4),
    vec2i(-7, 0), vec2i(7, 0), vec2i(0, -7), vec2i(0, 7),
  );
  var glow = 0.0;
  for (var index = 0u; index < 12u; index += 1u) {
    let sample_pixel = clamp(pixel + offsets[index], vec2i(0), size - vec2i(1));
    let weight = select(0.28, select(0.52, 0.86, index < 4u), index < 8u);
    glow = max(glow, select(0.0, weight, is_selected(textureLoad(object_ids, sample_pixel, 0).x)));
  }
  return glow;
}

fn vector_blur(uv: vec2f, pixel: vec2i) -> vec4f {
  let center = textureSampleLevel(hdr_scene, linear_sampler, uv, 0.0);
  let raw_motion = textureLoad(motion_vectors, pixel, 0).xy * settings.motion.x;
  let pixel_length = length(raw_motion * settings.viewport);
  let motion = raw_motion * min(1.0, 64.0 / max(pixel_length, 0.0001));
  if (pixel_length < 0.25) { return center; }
  var accumulated = vec4f(0.0);
  var weight_sum = 0.0;
  for (var index = 0u; index < 9u; index += 1u) {
    let position = f32(index) / 8.0 - 0.5;
    let weight = 1.0 - abs(position) * 1.25;
    let sample_uv = clamp(uv + motion * position, vec2f(0.0), vec2f(1.0));
    accumulated += textureSampleLevel(hdr_scene, linear_sampler, sample_uv, 0.0) * weight;
    weight_sum += weight;
  }
  return accumulated / weight_sum;
}

fn straight_rgb(premultiplied: vec4f) -> vec3f {
  let straight = premultiplied.rgb / max(premultiplied.a, 0.00001);
  return select(vec3f(0.0), straight, premultiplied.a > 0.00001);
}

fn display_premultiplied(premultiplied: vec4f) -> vec4f {
  let straight = straight_rgb(premultiplied);
  return vec4f(aces_tonemap(max(straight, vec3f(0.0))) * premultiplied.a, premultiplied.a);
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let pixel = pixel_at(input.uv);
  let center = textureSampleLevel(hdr_scene, linear_sampler, input.uv, 0.0);
  if (settings.mode == 1u && settings.selected_id != 0u) {
    let selected = is_selected(textureLoad(object_ids, pixel, 0).x);
    let straight = straight_rgb(center);
    let luminance = dot(straight, vec3f(0.2126, 0.7152, 0.0722));
    let isolated = mix(vec3f(luminance), straight, select(0.18, 1.0, selected));
    let glow = select(selection_glow(pixel), 0.22, selected);
    let effected = vec4f((isolated + vec3f(0.05, 0.42, 0.72) * glow) * center.a, center.a);
    return display_premultiplied(effected);
  }
  if (settings.mode == 2u) { return display_premultiplied(vector_blur(input.uv, pixel)); }
  return display_premultiplied(center);
}
`;
