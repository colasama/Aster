import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  type AuxiliaryBufferKind,
  type BufferVisualization,
  type DepthEffectVisualization,
  type SceneBufferVisualization,
} from "./render-buffers";

const SCENE_MODES: Readonly<Record<Exclude<SceneBufferVisualization, "beauty">, number>> = {
  linearColor: 0,
  luminance: 1,
  alpha: 2,
};

/** Full-screen views of the real HDR scene and auxiliary GPU attachments. */
export class SceneBufferVisualizer {
  readonly #device: GPUDevice;
  readonly #scenePipeline: GPURenderPipeline;
  readonly #floatPipeline: GPURenderPipeline;
  readonly #uintPipeline: GPURenderPipeline;
  readonly #sceneUniform: GPUBuffer;
  readonly #auxiliaryUniform: GPUBuffer;
  #sceneBindGroup?: GPUBindGroup;
  readonly #auxiliaryBindGroups = new Map<AuxiliaryBufferKind, GPUBindGroup>();

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    this.#sceneUniform = createUniform(device, "Scene buffer visualization mode");
    this.#auxiliaryUniform = createUniform(device, "Auxiliary buffer visualization range");
    const sceneModule = device.createShaderModule({
      label: "Scene buffer visualizer",
      code: sceneShader,
    });
    this.#scenePipeline = createPipeline(
      device,
      sceneModule,
      outputFormat,
      "Scene buffer visualization",
    );
    const floatModule = device.createShaderModule({
      label: "Float auxiliary visualizer",
      code: floatShader,
    });
    this.#floatPipeline = createPipeline(
      device,
      floatModule,
      outputFormat,
      "Float auxiliary visualization",
    );
    const uintModule = device.createShaderModule({
      label: "Integer auxiliary visualizer",
      code: uintShader,
    });
    this.#uintPipeline = createPipeline(
      device,
      uintModule,
      outputFormat,
      "Integer auxiliary visualization",
    );
  }

  setSource(source: GPUTexture): void {
    this.#sceneBindGroup = this.#createBindGroup(
      this.#scenePipeline,
      source,
      this.#sceneUniform,
      "Scene buffer visualization resources",
    );
  }

  setAuxiliarySources(
    sources: ReadonlyMap<AuxiliaryBufferKind, GPUTexture>,
    worldRange: readonly [number, number],
  ): void {
    this.#auxiliaryBindGroups.clear();
    const span = Math.max(1e-6, worldRange[1] - worldRange[0]);
    this.#device.queue.writeBuffer(
      this.#auxiliaryUniform,
      0,
      new Float32Array([worldRange[0], 1 / span]),
    );
    for (const [kind, source] of sources) {
      const pipeline =
        AUXILIARY_BUFFER_DESCRIPTORS[kind].sampleType === "uint"
          ? this.#uintPipeline
          : this.#floatPipeline;
      this.#auxiliaryBindGroups.set(
        kind,
        this.#createBindGroup(
          pipeline,
          source,
          this.#auxiliaryUniform,
          `${kind} visualization resources`,
        ),
      );
    }
  }

  clearAuxiliarySources(): void {
    this.#auxiliaryBindGroups.clear();
  }

  encode(
    pass: GPURenderPassEncoder,
    mode: Exclude<BufferVisualization, "beauty" | DepthEffectVisualization>,
  ): void {
    if (mode === "linearColor" || mode === "luminance" || mode === "alpha") {
      if (!this.#sceneBindGroup) throw new Error("Scene buffer visualizer has no source texture");
      this.#device.queue.writeBuffer(this.#sceneUniform, 0, new Uint32Array([SCENE_MODES[mode]]));
      pass.setPipeline(this.#scenePipeline);
      pass.setBindGroup(0, this.#sceneBindGroup);
    } else {
      const bindGroup = this.#auxiliaryBindGroups.get(mode);
      if (!bindGroup) throw new Error(`Auxiliary ${mode} visualization is unavailable`);
      const pipeline =
        AUXILIARY_BUFFER_DESCRIPTORS[mode].sampleType === "uint"
          ? this.#uintPipeline
          : this.#floatPipeline;
      this.#device.queue.writeBuffer(
        this.#auxiliaryUniform,
        8,
        new Uint32Array([mode === "normal" ? 0 : mode === "motionVector" ? 2 : 1]),
      );
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
    }
    pass.draw(3);
  }

  #createBindGroup(
    pipeline: GPURenderPipeline,
    source: GPUTexture,
    uniform: GPUBuffer,
    label: string,
  ): GPUBindGroup {
    return this.#device.createBindGroup({
      label,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: { buffer: uniform } },
      ],
    });
  }
}

function createUniform(device: GPUDevice, label: string): GPUBuffer {
  return device.createBuffer({
    label,
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

function createPipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  format: GPUTextureFormat,
  label: string,
): GPURenderPipeline {
  return device.createRenderPipeline({
    label,
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

const fullscreenVertex = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOutput(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}`;

const sceneShader = /* wgsl */ `${fullscreenVertex}
struct Settings { value: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: Settings;
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  let pixel = textureLoad(source, vec2u(clamp(input.uv * size, vec2f(0.0), size - 1.0)), 0);
  if (settings.value == 1u) {
    let luminance = dot(pixel.rgb, vec3f(0.2126, 0.7152, 0.0722));
    return vec4f(vec3f(luminance / (1.0 + luminance)), 1.0);
  }
  if (settings.value == 2u) { return vec4f(vec3f(pixel.a), 1.0); }
  return vec4f(pixel.rgb / (vec3f(1.0) + pixel.rgb), 1.0);
}`;

const floatShader = /* wgsl */ `${fullscreenVertex}
struct Settings { range_min: f32, range_scale: f32, mode: u32, padding: u32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: Settings;
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  let pixel = textureLoad(source, vec2u(clamp(input.uv * size, vec2f(0.0), size - 1.0)), 0);
  if (pixel.a == 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (settings.mode == 0u) { return vec4f(pixel.xyz * 0.5 + 0.5, 1.0); }
  if (settings.mode == 2u) {
    let motion_pixels = pixel.xy * size;
    let direction = clamp(vec2f(0.5) + motion_pixels / 64.0, vec2f(0.0), vec2f(1.0));
    return vec4f(direction, clamp(length(motion_pixels) / 32.0, 0.0, 1.0), 1.0);
  }
  return vec4f(clamp((pixel.xyz - settings.range_min) * settings.range_scale, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

const uintShader = /* wgsl */ `${fullscreenVertex}
struct Settings { range_min: f32, range_scale: f32, mode: u32, padding: u32 }
@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var<uniform> settings: Settings;
fn hash_id(id: u32) -> vec3f {
  var value = id ^ (id >> 16u); value *= 0x7feb352du; value ^= value >> 15u;
  value *= 0x846ca68bu; value ^= value >> 16u;
  return vec3f(f32(value & 255u), f32((value >> 8u) & 255u), f32((value >> 16u) & 255u)) / 255.0;
}
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(source));
  let id = textureLoad(source, vec2u(clamp(input.uv * size, vec2f(0.0), size - 1.0)), 0).x;
  return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(hash_id(id), 1.0), id != 0u);
}`;
