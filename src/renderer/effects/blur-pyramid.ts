export const BLUR_PYRAMID_MAX_LEVELS = 8;

export const blurDownsampleShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var source_tex: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

fn downsample_taps(uv: vec2f, half_texel: vec2f) -> array<vec4f, 5> {
  return array<vec4f, 5>(
    textureSample(source_tex, linear_sampler, uv),
    textureSample(source_tex, linear_sampler, uv + vec2f(-half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, uv + vec2f(half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, uv + vec2f(-half_texel.x, half_texel.y)),
    textureSample(source_tex, linear_sampler, uv + vec2f(half_texel.x, half_texel.y)),
  );
}

fn downsample_rgb(taps: array<vec4f, 5>) -> vec3f {
  return (taps[0] * 4.0 + taps[1] + taps[2] + taps[3] + taps[4]).rgb / 8.0;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let half_texel = vec2f(0.5) / vec2f(textureDimensions(source_tex));
  return vec4f(downsample_rgb(downsample_taps(input.uv, half_texel)), 1.0);
}
`;

/**
 * Bright-pass variant of the downsample shader used to seed a masked blur
 * chain. Level 0 weights each tap by `max(luminance - threshold, 0) /
 * luminance` before averaging, so the chain stores `blur(masked source)` —
 * glow compositors can read a physically placed halo straight from the mip
 * chain instead of reconstructing one from a blurred-image threshold.
 */
export const brightpassDownsampleShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

struct BrightpassParameters {
  threshold: f32,
  padding: vec3f,
}

@group(0) @binding(0) var source_tex: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var<uniform> params: BrightpassParameters;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let half_texel = vec2f(0.5) / vec2f(textureDimensions(source_tex));
  let taps = array<vec4f, 5>(
    textureSample(source_tex, linear_sampler, input.uv),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(-half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(half_texel.x, -half_texel.y)),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(-half_texel.x, half_texel.y)),
    textureSample(source_tex, linear_sampler, input.uv + vec2f(half_texel.x, half_texel.y)),
  );
  var sum = vec3f(0.0);
  for (var i = 0; i < 5; i += 1) {
    let level = dot(taps[i].rgb, vec3f(0.2126, 0.7152, 0.0722));
    let weight = max(level - params.threshold, 0.0) / max(level, 0.0001);
    sum += taps[i].rgb * weight * select(1.0, 4.0, i == 0);
  }
  return vec4f(sum / 8.0, 1.0);
}
`;

/**
 * Downsample-only blur chain for the fused effect shader. Level 0 is a
 * half-resolution Kawase-filtered copy of the layer input; each following
 * level is the same filter applied to the previous one, so mip LOD maps
 * monotonically onto blur radius and `sample_blur` can stay constant-cost.
 * The alpha channel is unused; glow-style effects bind a masked chain built
 * by {@link BrightpassPyramid} instead, which stores blur(bright-pass) so
 * halos are physically placed rather than reconstructed.
 */
export class BlurPyramid {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #sampler: GPUSampler;
  readonly #pipeline: GPURenderPipeline;
  #texture?: GPUTexture;
  #view?: GPUTextureView;
  #mipViews: GPUTextureView[] = [];
  #downsampleBindGroups: GPUBindGroup[] = [];
  #mipLevelCount = 1;
  #estimatedBytes = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, sampler: GPUSampler) {
    this.#device = device;
    this.#format = format;
    this.#sampler = sampler;
    const module = device.createShaderModule({
      label: "Blur pyramid downsample shader",
      code: blurDownsampleShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: "Blur pyramid downsample pass",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  get view(): GPUTextureView | undefined {
    return this.#view;
  }

  get mipLevelCount(): number {
    return this.#mipLevelCount;
  }

  get estimatedTextureBytes(): number {
    return this.#estimatedBytes;
  }

  resize(width: number, height: number, source: GPUTexture): void {
    this.#texture?.destroy();
    const baseWidth = Math.max(1, Math.ceil(width / 2));
    const baseHeight = Math.max(1, Math.ceil(height / 2));
    this.#mipLevelCount = Math.min(
      BLUR_PYRAMID_MAX_LEVELS,
      Math.floor(Math.log2(Math.max(baseWidth, baseHeight))) + 1,
    );
    this.#texture = this.#device.createTexture({
      label: "Blur pyramid",
      size: [baseWidth, baseHeight],
      format: this.#format,
      mipLevelCount: this.#mipLevelCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#view = this.#texture.createView();
    this.#mipViews = [];
    this.#estimatedBytes = 0;
    for (let level = 0; level < this.#mipLevelCount; level += 1) {
      this.#mipViews.push(this.#texture.createView({ baseMipLevel: level, mipLevelCount: 1 }));
      this.#estimatedBytes +=
        Math.max(1, baseWidth >> level) *
        Math.max(1, baseHeight >> level) *
        bytesPerPixel(this.#format);
    }
    const layout = this.#pipeline.getBindGroupLayout(0);
    this.#downsampleBindGroups = this.#mipViews.map((_, level) =>
      this.#device.createBindGroup({
        label: `Blur pyramid downsample · level ${level}`,
        layout,
        entries: [
          {
            binding: 0,
            resource: level === 0 ? source.createView() : this.#mipViews[level - 1],
          },
          { binding: 1, resource: this.#sampler },
        ],
      }),
    );
  }

  encode(encoder: GPUCommandEncoder): void {
    for (let level = 0; level < this.#mipLevelCount; level += 1) {
      const view = this.#mipViews[level];
      const bindGroup = this.#downsampleBindGroups[level];
      if (!view || !bindGroup) continue;
      const pass = encoder.beginRenderPass({
        label: `Blur pyramid downsample · level ${level}`,
        colorAttachments: [
          {
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#texture = undefined;
    this.#view = undefined;
    this.#mipViews = [];
    this.#downsampleBindGroups = [];
  }
}

/**
 * Masked blur chain for glow-style effects. Level 0 bright-passes the layer
 * input with a threshold uniform while downsampling; higher levels reuse the
 * plain Kawase filter, so every mip stores `blur(bright-pass source)` at
 * roughly `3 * 2^level` pixels of spread — the same radius mapping the fused
 * shader applies to `sample_blur`.
 */
export class BrightpassPyramid {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #sampler: GPUSampler;
  readonly #seedPipeline: GPURenderPipeline;
  readonly #downsamplePipeline: GPURenderPipeline;
  readonly #parameters: GPUBuffer;
  #texture?: GPUTexture;
  #view?: GPUTextureView;
  #mipViews: GPUTextureView[] = [];
  #seedBindGroup?: GPUBindGroup;
  #downsampleBindGroups: GPUBindGroup[] = [];
  #mipLevelCount = 1;
  #estimatedBytes = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, sampler: GPUSampler) {
    this.#device = device;
    this.#format = format;
    this.#sampler = sampler;
    const seedModule = device.createShaderModule({
      label: "Brightpass downsample shader",
      code: brightpassDownsampleShader,
    });
    this.#seedPipeline = device.createRenderPipeline({
      label: "Brightpass downsample pass",
      layout: "auto",
      vertex: { module: seedModule, entryPoint: "vertex_main" },
      fragment: { module: seedModule, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const downsampleModule = device.createShaderModule({
      label: "Blur pyramid downsample shader",
      code: blurDownsampleShader,
    });
    this.#downsamplePipeline = device.createRenderPipeline({
      label: "Brightpass propagate pass",
      layout: "auto",
      vertex: { module: downsampleModule, entryPoint: "vertex_main" },
      fragment: { module: downsampleModule, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.#parameters = device.createBuffer({
      label: "Brightpass parameters",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get view(): GPUTextureView | undefined {
    return this.#view;
  }

  get mipLevelCount(): number {
    return this.#mipLevelCount;
  }

  get estimatedTextureBytes(): number {
    return this.#estimatedBytes;
  }

  resize(width: number, height: number, source: GPUTexture): void {
    this.#texture?.destroy();
    const baseWidth = Math.max(1, Math.ceil(width / 2));
    const baseHeight = Math.max(1, Math.ceil(height / 2));
    this.#mipLevelCount = Math.min(
      BLUR_PYRAMID_MAX_LEVELS,
      Math.floor(Math.log2(Math.max(baseWidth, baseHeight))) + 1,
    );
    this.#texture = this.#device.createTexture({
      label: "Brightpass pyramid",
      size: [baseWidth, baseHeight],
      format: this.#format,
      mipLevelCount: this.#mipLevelCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#view = this.#texture.createView();
    this.#mipViews = [];
    this.#estimatedBytes = 0;
    for (let level = 0; level < this.#mipLevelCount; level += 1) {
      this.#mipViews.push(this.#texture.createView({ baseMipLevel: level, mipLevelCount: 1 }));
      this.#estimatedBytes +=
        Math.max(1, baseWidth >> level) *
        Math.max(1, baseHeight >> level) *
        bytesPerPixel(this.#format);
    }
    this.#seedBindGroup = this.#device.createBindGroup({
      label: "Brightpass downsample · level 0",
      layout: this.#seedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: this.#parameters } },
      ],
    });
    const layout = this.#downsamplePipeline.getBindGroupLayout(0);
    this.#downsampleBindGroups = this.#mipViews.slice(1).map((_, index) =>
      this.#device.createBindGroup({
        label: `Brightpass downsample · level ${index + 1}`,
        layout,
        entries: [
          { binding: 0, resource: this.#mipViews[index] },
          { binding: 1, resource: this.#sampler },
        ],
      }),
    );
  }

  encode(encoder: GPUCommandEncoder, threshold: number): void {
    this.#device.queue.writeBuffer(this.#parameters, 0, new Float32Array([threshold, 0, 0, 0]));
    for (let level = 0; level < this.#mipLevelCount; level += 1) {
      const view = this.#mipViews[level];
      const bindGroup = level === 0 ? this.#seedBindGroup : this.#downsampleBindGroups[level - 1];
      if (!view || !bindGroup) continue;
      const pass = encoder.beginRenderPass({
        label: `Brightpass downsample · level ${level}`,
        colorAttachments: [
          {
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(level === 0 ? this.#seedPipeline : this.#downsamplePipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#texture = undefined;
    this.#view = undefined;
    this.#mipViews = [];
    this.#seedBindGroup = undefined;
    this.#downsampleBindGroups = [];
  }
}

function bytesPerPixel(format: GPUTextureFormat): number {
  switch (format) {
    case "rgba16float":
    case "rg32float":
      return 8;
    case "rgba32float":
      return 16;
    default:
      return 4;
  }
}
