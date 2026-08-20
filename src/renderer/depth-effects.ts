import type { DepthEffectVisualization } from "./render-buffers";

export interface DepthEffectSettings {
  cameraDepth: number;
  fogColor: readonly [number, number, number];
  fogDensity: number;
  fogStart: number;
  focusDistance: number;
  focusRange: number;
  maximumBlurRadius: number;
}

export const DEFAULT_DEPTH_EFFECT_SETTINGS: DepthEffectSettings = {
  cameraDepth: 0,
  fogColor: [0.08, 0.16, 0.3],
  fogDensity: 0.012,
  fogStart: 6,
  focusDistance: 0,
  focusRange: 28,
  maximumBlurRadius: 18,
};

const MODE_CODES: Readonly<Record<DepthEffectVisualization, number>> = {
  depthFog: 1,
  depthOfField: 2,
};

/** Packs three aligned vec4 uniforms for the depth-aware fullscreen pass. */
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
    finite(settings.cameraDepth, 0),
    bounded(settings.fogColor[0], 0, 16),
    bounded(settings.fogColor[1], 0, 16),
    bounded(settings.fogColor[2], 0, 16),
    bounded(settings.fogDensity, 0, 1),
    finite(settings.focusDistance, 0),
    bounded(settings.focusRange, 0.001, 100_000),
    bounded(settings.maximumBlurRadius, 0, 48),
    bounded(settings.fogStart, 0, 100_000),
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
      size: 48,
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

fn circle_sample(uv: vec2f, radius: f32, index: u32) -> vec3f {
  let unit_radius = sqrt((f32(index) + 0.5) / 16.0);
  let angle = f32(index) * 2.39996323;
  let offset = vec2f(cos(angle), sin(angle)) * unit_radius * radius / settings.viewport.xy;
  return textureSampleLevel(hdr_scene, linear_sampler, clamp(uv + offset, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let center = textureSampleLevel(hdr_scene, linear_sampler, input.uv, 0.0);
  let surface = surface_at(input.uv);
  var color = center.rgb;
  if (settings.viewport.z < 1.5) {
    let depth_distance = max(abs(surface.z - settings.viewport.w) - settings.lens.w, 0.0);
    let fog_amount = select(0.0, 1.0 - exp(-depth_distance * settings.fog.w), surface.a > 0.0);
    color = mix(color, settings.fog.rgb, clamp(fog_amount, 0.0, 0.96));
  } else {
    let focus_error = abs(surface.z - settings.viewport.w - settings.lens.x);
    let blur_radius = select(0.0, clamp(focus_error / settings.lens.y, 0.0, 1.0) * settings.lens.z, surface.a > 0.0);
    var blurred = center.rgb;
    for (var index = 0u; index < 16u; index += 1u) {
      blurred += circle_sample(input.uv, blur_radius, index);
    }
    blurred /= 17.0;
    color = mix(center.rgb, blurred, smoothstep(0.5, 2.0, blur_radius));
  }
  return vec4f(aces_tonemap(max(color, vec3f(0.0))) * center.a, center.a);
}
`;
