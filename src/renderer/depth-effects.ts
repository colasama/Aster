import type { DepthEffectVisualization } from "./render-buffers";

export interface DepthEffectSettings {
  cameraPosition: readonly [number, number, number];
  cameraForward: readonly [number, number, number];
  fogColor: readonly [number, number, number];
  fogDensity: number;
  fogStart: number;
  focusDistance: number;
  focusAreaWidth: number;
  aperture: number;
  filmSize: number;
  zoom: number;
  blurLevel: number;
  nearBlurLevel: number;
  farBlurLevel: number;
  maximumBlurRadius: number;
  sampleCount: number;
}

export const DEFAULT_DEPTH_EFFECT_SETTINGS: DepthEffectSettings = {
  cameraPosition: [0, 0, 0],
  cameraForward: [0, 0, 1],
  fogColor: [0.08, 0.16, 0.3],
  fogDensity: 0.012,
  fogStart: 6,
  focusDistance: 2666.666_666_666_666_5,
  focusAreaWidth: 0,
  aperture: 17.857_142_857_142_858,
  filmSize: 36,
  zoom: 2666.666_666_666_666_5,
  blurLevel: 100,
  nearBlurLevel: 100,
  farBlurLevel: 100,
  maximumBlurRadius: 48,
  sampleCount: 32,
};

const MODE_CODES: Readonly<Record<DepthEffectVisualization, number>> = {
  depthFog: 1,
  depthOfField: 2,
};

/** Packs six aligned vec4 uniforms for the depth-aware fullscreen pass. */
export function buildDepthEffectUniforms(
  mode: DepthEffectVisualization,
  width: number,
  height: number,
  settings: DepthEffectSettings = DEFAULT_DEPTH_EFFECT_SETTINGS,
): Float32Array {
  return new Float32Array([
    bounded(width, 1, 16_384),
    bounded(height, 1, 16_384),
    MODE_CODES[mode],
    bounded(settings.sampleCount, 8, 64),
    bounded(settings.fogColor[0], 0, 16),
    bounded(settings.fogColor[1], 0, 16),
    bounded(settings.fogColor[2], 0, 16),
    bounded(settings.fogDensity, 0, 1),
    finite(settings.cameraPosition[0], 0),
    finite(settings.cameraPosition[1], 0),
    finite(settings.cameraPosition[2], 0),
    bounded(settings.fogStart, 0, 100_000),
    finite(settings.cameraForward[0], 0),
    finite(settings.cameraForward[1], 0),
    finite(settings.cameraForward[2], 1),
    bounded(settings.focusDistance, 0.001, 10_000_000),
    bounded(settings.focusAreaWidth, 0, 10_000_000),
    bounded(settings.aperture, 0, 10_000),
    bounded(settings.filmSize, 0.001, 1_000),
    bounded(settings.zoom, 0.001, 10_000_000),
    bounded(settings.blurLevel, 0, 1_000) / 100,
    bounded(settings.nearBlurLevel, 0, 1_000) / 100,
    bounded(settings.farBlurLevel, 0, 1_000) / 100,
    bounded(settings.maximumBlurRadius, 0, 256),
  ]);
}

/** GPU-only depth fog and bounded depth-of-field preview pass. */
export class DepthEffectsRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #uniform: GPUBuffer;
  #bindGroup?: GPUBindGroup;
  #width = 1;
  #height = 1;
  #settings: DepthEffectSettings = DEFAULT_DEPTH_EFFECT_SETTINGS;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    const module = device.createShaderModule({
      label: "Depth fog and depth-of-field shader",
      code: depthEffectsShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: "Depth-aware fog and depth-of-field pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: outputFormat }] },
      primitive: { topology: "triangle-list" },
    });
    this.#sampler = device.createSampler({
      label: "Depth effects scene sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.#uniform = device.createBuffer({
      label: "Depth effects uniforms",
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  setSources(
    width: number,
    height: number,
    scene: GPUTexture | undefined,
    worldPosition: GPUTexture | undefined,
  ): void {
    this.#width = width;
    this.#height = height;
    this.#bindGroup =
      scene && worldPosition
        ? this.#device.createBindGroup({
            label: "Depth effects HDR + world-position resources",
            layout: this.#pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: scene.createView() },
              { binding: 1, resource: worldPosition.createView() },
              { binding: 2, resource: this.#sampler },
              { binding: 3, resource: { buffer: this.#uniform } },
            ],
          })
        : undefined;
  }

  setSettings(settings: Partial<DepthEffectSettings>): void {
    this.#settings = { ...this.#settings, ...settings };
  }

  encode(pass: GPURenderPassEncoder, mode: DepthEffectVisualization): boolean {
    if (!this.#bindGroup) return false;
    this.#device.queue.writeBuffer(
      this.#uniform,
      0,
      buildDepthEffectUniforms(mode, this.#width, this.#height, this.#settings),
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

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

export const depthEffectsShader = /* wgsl */ `
struct Settings {
  viewport: vec4f,
  fog: vec4f,
  lens: vec4f,
  camera: vec4f,
  optics: vec4f,
  blur: vec4f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@group(0) @binding(0) var hdr_scene: texture_2d<f32>;
@group(0) @binding(1) var world_position: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;
@group(0) @binding(3) var<uniform> settings: Settings;

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

fn surface_at(uv: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(world_position));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - vec2i(1));
  return textureLoad(world_position, pixel, 0);
}

fn view_depth(surface: vec4f) -> f32 {
  let forward = normalize(select(vec3f(0.0, 0.0, 1.0), settings.camera.xyz, length(settings.camera.xyz) > 0.00001));
  return max(dot(surface.xyz - settings.lens.xyz, forward), 0.0001);
}

fn circle_of_confusion(surface: vec4f) -> f32 {
  if (surface.a <= 0.0) { return 0.0; }
  let depth = view_depth(surface);
  let focus_error = depth - settings.camera.w;
  let defocused = max(abs(focus_error) - settings.optics.x * 0.5, 0.0);
  let pixels_per_mm = settings.viewport.x / max(settings.optics.z, 0.001);
  let aperture_pixels = settings.optics.y * pixels_per_mm;
  let focus_scale = settings.optics.w / max(settings.camera.w, 0.001);
  let depth_scale = defocused / depth;
  let side_level = select(settings.blur.z, settings.blur.y, focus_error < 0.0);
  let radius = min(
    aperture_pixels * 0.5 * focus_scale * depth_scale * settings.blur.x * side_level,
    settings.blur.w,
  );
  return select(radius, -radius, focus_error < 0.0);
}

fn circle_uv(uv: vec2f, radius: f32, index: u32, sample_count: f32) -> vec2f {
  let unit_radius = sqrt((f32(index) + 0.5) / sample_count);
  let angle = f32(index) * 2.39996323;
  let offset = vec2f(cos(angle), sin(angle)) * unit_radius * radius / settings.viewport.xy;
  return clamp(uv + offset, vec2f(0.0), vec2f(1.0));
}

fn straight_rgb(premultiplied: vec4f) -> vec3f {
  return select(vec3f(0.0), premultiplied.rgb / max(premultiplied.a, 0.00001), premultiplied.a > 0.00001);
}

fn display_premultiplied(premultiplied: vec4f) -> vec4f {
  return vec4f(aces_tonemap(max(straight_rgb(premultiplied), vec3f(0.0))) * premultiplied.a, premultiplied.a);
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let center = textureSampleLevel(hdr_scene, linear_sampler, input.uv, 0.0);
  let surface = surface_at(input.uv);
  if (settings.viewport.z < 1.5) {
    let depth_distance = max(view_depth(surface) - settings.lens.w, 0.0);
    let fog_amount = select(0.0, 1.0 - exp(-depth_distance * settings.fog.w), surface.a > 0.0);
    let straight = mix(straight_rgb(center), settings.fog.rgb, clamp(fog_amount, 0.0, 0.96));
    return vec4f(aces_tonemap(max(straight, vec3f(0.0))) * center.a, center.a);
  }
  let coc = circle_of_confusion(surface);
  let radius = abs(coc);
  if (radius < 0.25) { return display_premultiplied(center); }
  let center_depth = view_depth(surface);
  let sample_count = clamp(settings.viewport.w, 8.0, 64.0);
  var accumulated = center;
  var weight_sum = 1.0;
  for (var index = 0u; index < 64u; index += 1u) {
    if (f32(index) >= sample_count) { break; }
    let sample_uv = circle_uv(input.uv, radius, index, sample_count);
    let sample_surface = surface_at(sample_uv);
    let sample_depth = view_depth(sample_surface);
    let sample_coc = circle_of_confusion(sample_surface);
    var weight = 1.0 - (f32(index) / sample_count) * 0.35;
    if (coc > 0.0 && sample_depth < center_depth && abs(sample_coc) < radius) {
      weight *= 0.08;
    }
    accumulated += textureSampleLevel(hdr_scene, linear_sampler, sample_uv, 0.0) * weight;
    weight_sum += weight;
  }
  let blurred = accumulated / weight_sum;
  return display_premultiplied(mix(center, blurred, smoothstep(0.25, 1.5, radius)));
}
`;
