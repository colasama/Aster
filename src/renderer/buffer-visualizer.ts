import type { SceneBufferVisualization } from "./render-buffers";

const DEBUG_MODES: Readonly<Record<Exclude<SceneBufferVisualization, "beauty">, number>> = {
  linearColor: 0,
  luminance: 1,
  alpha: 2,
};

/** Full-screen view of the real linear HDR scene target, before effects and display transforms. */
export class SceneBufferVisualizer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #uniform: GPUBuffer;
  #bindGroup?: GPUBindGroup;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    this.#uniform = device.createBuffer({
      label: "Scene buffer visualization mode",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const module = device.createShaderModule({ label: "Scene buffer visualizer", code: shader });
    this.#pipeline = device.createRenderPipeline({
      label: "Scene buffer visualization pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: outputFormat }] },
      primitive: { topology: "triangle-list" },
    });
  }

  setSource(source: GPUTexture): void {
    this.#bindGroup = this.#device.createBindGroup({
      label: "Scene buffer visualization resources",
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: { buffer: this.#uniform } },
      ],
    });
  }

  encode(pass: GPURenderPassEncoder, mode: Exclude<SceneBufferVisualization, "beauty">): void {
    if (!this.#bindGroup) throw new Error("Scene buffer visualizer has no source texture");
    this.#device.queue.writeBuffer(this.#uniform, 0, new Uint32Array([DEBUG_MODES[mode]]));
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
  }
}

const shader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
struct DebugMode { value: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<uniform> mode: DebugMode;

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  return VertexOutput(vec4f(positions[index], 0.0, 1.0), uvs[index]);
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let dimensions = vec2f(textureDimensions(scene));
  let pixel = textureLoad(scene, vec2u(clamp(input.uv * dimensions, vec2f(0.0), dimensions - 1.0)), 0);
  if (mode.value == 1u) {
    let luminance = dot(pixel.rgb, vec3f(0.2126, 0.7152, 0.0722));
    return vec4f(vec3f(luminance / (1.0 + luminance)), 1.0);
  }
  if (mode.value == 2u) { return vec4f(vec3f(pixel.a), 1.0); }
  return vec4f(pixel.rgb / (vec3f(1.0) + pixel.rgb), 1.0);
}`;
