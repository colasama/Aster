import { type AntiAliasingMode, antiAliasingScale } from "../../core/rendering/anti-aliasing";

export function planAntiAliasing(
  mode: AntiAliasingMode,
  width: number,
  height: number,
  maxDimension: number,
  budgetMb = 512,
) {
  const scale = antiAliasingScale(mode);
  const renderWidth = width * scale;
  const renderHeight = height * scale;
  if (renderWidth > maxDimension || renderHeight > maxDimension)
    throw new Error(
      `Anti-aliasing ${mode} requires ${renderWidth}×${renderHeight}; GPU limit is ${maxDimension}. Choose a lower AA mode or resolution.`,
    );
  const textureBytes = mode === "off" ? 0 : renderWidth * renderHeight * 4;
  // Include scene HDR, depth, AA color, canvas and the three bounded readback slots.
  const minimumBytes = renderWidth * renderHeight * 12 + textureBytes + width * height * 16;
  if (mode !== "off" && minimumBytes > budgetMb * 1024 * 1024)
    throw new Error(
      `Anti-aliasing ${mode} needs at least ${Math.ceil(minimumBytes / 1024 / 1024)} MB; GPU budget is ${budgetMb} MB. Choose a lower AA mode or resolution.`,
    );
  return { renderWidth, renderHeight, textureBytes, scale };
}

/** One reusable display-space target; disabled AA owns no texture or render pass. */
export class AntiAliasingRenderer {
  #texture?: GPUTexture;
  #bindGroup?: GPUBindGroup;
  #pipeline?: GPURenderPipeline;
  #mode: AntiAliasingMode = "off";
  #width = 0;
  #height = 0;
  readonly #pipelines = new Map<AntiAliasingMode, GPURenderPipeline>();
  constructor(
    readonly device: GPUDevice,
    readonly format: GPUTextureFormat,
  ) {}

  get estimatedBytes(): number {
    return this.#width * this.#height * 4;
  }
  get view(): GPUTextureView | undefined {
    return this.#texture?.createView();
  }

  resize(mode: AntiAliasingMode, width: number, height: number): void {
    if (mode === this.#mode && width === this.#width && height === this.#height) return;
    this.destroy();
    this.#mode = mode;
    if (mode === "off") return;
    let pipeline = this.#pipelines.get(mode);
    if (!pipeline) {
      const module = this.device.createShaderModule({
        label: "Output anti-aliasing",
        code: antiAliasingShader,
      });
      pipeline = this.device.createRenderPipeline({
        label: `Output ${mode}`,
        layout: "auto",
        vertex: { module, entryPoint: "vertex_main" },
        fragment: {
          module,
          entryPoint: mode === "fxaa" ? "fxaa" : "supersample",
          ...(mode === "fxaa" ? {} : { constants: { scale: antiAliasingScale(mode) } }),
          targets: [{ format: this.format }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.#pipelines.set(mode, pipeline);
    }
    this.#pipeline = pipeline;
    this.#width = width;
    this.#height = height;
    this.#texture = this.device.createTexture({
      label: `Anti-aliasing input · ${mode}`,
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#texture.createView() },
        ...(mode === "fxaa"
          ? [
              {
                binding: 1,
                resource: this.device.createSampler({ minFilter: "linear", magFilter: "linear" }),
              },
            ]
          : []),
      ],
    });
  }

  encode(
    encoder: GPUCommandEncoder,
    output: GPUTextureView,
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void {
    if (!this.#bindGroup || !this.#pipeline) return;
    const pass = encoder.beginRenderPass({
      label: `Output ${this.#mode}`,
      timestampWrites,
      colorAttachments: [
        { view: output, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#texture = undefined;
    this.#bindGroup = undefined;
    this.#pipeline = undefined;
    this.#width = 0;
    this.#height = 0;
  }
}

// Directional FXAA uses display luminance; alpha is an independent edge signal for transparent output.
// All reconstruction filters operate on premultiplied RGBA with identical positive weights.
export const antiAliasingShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
override scale: u32 = 1u;

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
fn sample_color(uv: vec2f) -> vec4f {
  return textureSampleLevel(source, linear_sampler, uv, 0.0);
}
fn luma(color: vec4f) -> f32 { return dot(color.rgb, vec3f(0.299, 0.587, 0.114)); }

@fragment fn fxaa(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let step = 1.0 / vec2f(textureDimensions(source));
  let uv = position.xy * step;
  let center = sample_color(uv);
  let nw = sample_color(uv + vec2f(-1.0, -1.0) * step);
  let ne = sample_color(uv + vec2f(1.0, -1.0) * step);
  let sw = sample_color(uv + vec2f(-1.0, 1.0) * step);
  let se = sample_color(uv + vec2f(1.0, 1.0) * step);
  let lights = vec4f(luma(nw), luma(ne), luma(sw), luma(se));
  let alphas = vec4f(nw.a, ne.a, sw.a, se.a);
  let lmin = min(luma(center), min(min(lights.x, lights.y), min(lights.z, lights.w)));
  let lmax = max(luma(center), max(max(lights.x, lights.y), max(lights.z, lights.w)));
  let amin = min(center.a, min(min(alphas.x, alphas.y), min(alphas.z, alphas.w)));
  let amax = max(center.a, max(max(alphas.x, alphas.y), max(alphas.z, alphas.w)));
  let alpha_edge = amax - amin > lmax - lmin;
  let values = select(lights, alphas, alpha_edge);
  let low = select(lmin, amin, alpha_edge);
  let high = select(lmax, amax, alpha_edge);
  if (high - low < max(0.0312, high * 0.125)) { return center; }
  let direction = vec2f(-((values.x + values.y) - (values.z + values.w)),
                         (values.x + values.z) - (values.y + values.w));
  let reduction = max(dot(values, vec4f(0.03125)), 0.0078125);
  let span = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduction), vec2f(-8.0), vec2f(8.0)) * step;
  let narrow = (sample_color(uv - span / 6.0) + sample_color(uv + span / 6.0)) * 0.5;
  let wide = narrow * 0.5 + (sample_color(uv - span * 0.5) + sample_color(uv + span * 0.5)) * 0.25;
  let wide_signal = select(luma(wide), wide.a, alpha_edge);
  return select(wide, narrow, wide_signal < low || wide_signal > high);
}

@fragment fn supersample(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let origin = vec2u(position.xy) * scale;
  var color = vec4f(0.0);
  for (var y = 0u; y < scale; y++) {
    for (var x = 0u; x < scale; x++) {
      color += textureLoad(source, vec2i(origin + vec2u(x, y)), 0);
    }
  }
  return color / f32(scale * scale);
}
`;
