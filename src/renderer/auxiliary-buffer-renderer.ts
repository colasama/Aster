import type { Layer } from "../core/types";
import type { SceneBufferVisualizer } from "./buffer-visualizer";
import type { GeometryBatch } from "./geometry";
import { GpuMotionVectorHistory } from "./motion-vector-history";
import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  AUXILIARY_BUFFER_KINDS,
  type AuxiliaryBufferKind,
  auxiliaryRenderPassBytes,
  type BufferVisualization,
  createAuxiliaryBufferTextures,
  destroyAuxiliaryBufferTextures,
  encodeRenderId,
  isAuxiliaryBuffer,
  planAuxiliaryBuffers,
  supportsAuxiliaryMrt,
  usesAuxiliarySurfaceData,
} from "./render-buffers";
import { SHAPE_VERTEX_BUFFERS } from "./scene-pipelines";

const ID_RECORD_BYTES = 8;

interface ParticleDraw {
  bindGroup: GPUBindGroup;
  indirectBuffer: GPUBuffer;
  selectionId: string;
}

export interface AuxiliaryEncodeRequest {
  encoder: GPUCommandEncoder;
  vertexBuffer: GPUBuffer;
  vertexCount: number;
  timelineTime: number;
  frameRate: number;
  batches: readonly GeometryBatch[];
  mediaBindGroup: (batch: GeometryBatch) => GPUBindGroup | undefined;
  particle?: ParticleDraw;
}

/** Owns the transient MRT surface-data pass used by the viewport debugger. */
export class AuxiliaryBufferRenderer {
  readonly #device: GPUDevice;
  readonly #shapePipeline: GPURenderPipeline;
  readonly #mediaPipeline: GPURenderPipeline;
  readonly #particlePipeline: GPURenderPipeline;
  readonly #particleUniform: GPUBuffer;
  readonly #particleUniformBindGroup: GPUBindGroup;
  readonly #motionHistory: GpuMotionVectorHistory;
  #textures = new Map<AuxiliaryBufferKind, GPUTexture>();
  #depth?: GPUTexture;
  #idBuffer?: GPUBuffer;
  #idBufferBytes = 0;
  #width = 1;
  #height = 1;
  #estimatedBytes = 0;
  #byteBudget = 0;
  #enabled = false;
  #motionShutterScale = 0;
  readonly supported: boolean;

  constructor(
    device: GPUDevice,
    imageBindGroupLayout: GPUBindGroupLayout,
    particleBindGroupLayout: GPUBindGroupLayout,
  ) {
    this.#device = device;
    this.#motionHistory = new GpuMotionVectorHistory(device);
    this.supported = supportsAuxiliaryMrt(device.limits);
    const module = device.createShaderModule({
      label: "Auxiliary MRT surface shader",
      code: auxiliarySurfaceShader,
    });
    const targets = AUXILIARY_BUFFER_KINDS.map((kind) => ({
      format: AUXILIARY_BUFFER_DESCRIPTORS[kind].format,
    }));
    const vertexBuffers: GPUVertexBufferLayout[] = [
      ...SHAPE_VERTEX_BUFFERS,
      {
        arrayStride: ID_RECORD_BYTES,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 12, offset: 0, format: "uint32" },
          { shaderLocation: 13, offset: 4, format: "uint32" },
        ],
      },
      {
        arrayStride: 16,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 14, offset: 0, format: "float32x3" }],
      },
    ];
    const base: Omit<GPURenderPipelineDescriptor, "fragment" | "layout"> = {
      vertex: { module, entryPoint: "surface_vertex", buffers: vertexBuffers },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    };
    this.#shapePipeline = device.createRenderPipeline({
      ...base,
      label: "Auxiliary MRT geometry pipeline",
      layout: "auto",
      fragment: { module, entryPoint: "surface_fragment", targets },
    });
    this.#mediaPipeline = device.createRenderPipeline({
      ...base,
      label: "Auxiliary MRT alpha-tested media pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [imageBindGroupLayout] }),
      fragment: { module, entryPoint: "media_fragment", targets },
    });
    const particleUniformLayout = device.createBindGroupLayout({
      label: "Auxiliary particle identity layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.#particleUniform = device.createBuffer({
      label: "Auxiliary particle identity",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#particleUniformBindGroup = device.createBindGroup({
      label: "Auxiliary particle identity resources",
      layout: particleUniformLayout,
      entries: [{ binding: 0, resource: { buffer: this.#particleUniform } }],
    });
    this.#particlePipeline = device.createRenderPipeline({
      label: "Auxiliary MRT particle pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [particleBindGroupLayout, particleUniformLayout],
      }),
      vertex: { module, entryPoint: "particle_vertex" },
      fragment: { module, entryPoint: "particle_fragment", targets },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });
  }

  get estimatedBytes(): number {
    return this.#estimatedBytes + this.#idBufferBytes + 32 + this.#motionHistory.estimatedBytes;
  }

  get textures(): ReadonlyMap<AuxiliaryBufferKind, GPUTexture> {
    return this.#textures;
  }

  get motionShutterScale(): number {
    return this.#motionShutterScale;
  }

  enable(width: number, height: number, byteBudget: number): boolean {
    if (!this.supported) return false;
    this.#byteBudget = Math.max(0, byteBudget);
    const plan = planAuxiliaryBuffers(width, height);
    const requiredBytes = auxiliaryRenderPassBytes(plan);
    if (requiredBytes + this.#idBufferBytes + 48 > this.#byteBudget) return false;
    if (this.#enabled && plan.width === this.#width && plan.height === this.#height) {
      if (this.estimatedBytes <= this.#byteBudget) return true;
      this.#destroyTargets();
      return false;
    }
    this.#destroyTargets();
    try {
      this.#textures = new Map(createAuxiliaryBufferTextures(this.#device, plan));
      this.#depth = this.#device.createTexture({
        label: "Auxiliary MRT depth",
        size: [plan.width, plan.height],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.#width = plan.width;
      this.#height = plan.height;
      this.#estimatedBytes = requiredBytes;
      this.#enabled = true;
      return true;
    } catch (error) {
      this.#destroyTargets();
      console.warn("Auxiliary MRT allocation failed", error);
      return false;
    }
  }

  disable(): void {
    this.#destroyTargets();
  }

  configureVisualization(
    visualizer: SceneBufferVisualizer,
    mode: BufferVisualization,
    width: number,
    height: number,
    budgetMb?: number,
  ): BufferVisualization {
    if (!usesAuxiliarySurfaceData(mode)) {
      this.disable();
      visualizer.clearAuxiliarySources();
      return mode;
    }
    if (!this.enable(width, height, (budgetMb ?? 512) * 1024 * 1024 * 0.5)) {
      console.warn("Auxiliary MRT is unsupported or exceeds half of the GPU memory budget");
      visualizer.clearAuxiliarySources();
      return "beauty";
    }
    const range = Math.max(width, height);
    if (isAuxiliaryBuffer(mode)) visualizer.setAuxiliarySources(this.textures, [-range, range]);
    else visualizer.clearAuxiliarySources();
    return mode;
  }

  encode(request: AuxiliaryEncodeRequest): boolean {
    if (!this.#enabled || !this.#depth) return false;
    const nextIdBytes = idBufferCapacityBytes(request.batches.length);
    const plannedBytes =
      this.#estimatedBytes +
      Math.max(this.#idBufferBytes, nextIdBytes) +
      32 +
      this.#motionHistory.plannedBytes(request.vertexCount);
    if (plannedBytes > this.#byteBudget) {
      console.warn("Auxiliary MRT dynamic buffers exceed the configured GPU memory budget");
      this.#beginPass(request.encoder, "Auxiliary MRT budget fallback · cleared").end();
      this.#motionHistory.reset();
      this.#motionShutterScale = 0;
      return false;
    }
    this.#uploadBatchIds(request.batches);
    const idBuffer = this.#idBuffer;
    if (!idBuffer) return false;
    const motion = this.#motionHistory.prepare(
      request.encoder,
      request.vertexBuffer,
      request.vertexCount,
      request.batches,
      request.timelineTime,
      request.frameRate,
    );
    this.#motionShutterScale = motion.shutterScale;
    const pass = this.#beginPass(
      request.encoder,
      "Normal + IDs + World Position + Motion Vector MRT",
    );
    pass.setVertexBuffer(0, request.vertexBuffer);
    pass.setVertexBuffer(1, idBuffer);
    pass.setVertexBuffer(2, motion.buffer);
    for (let index = 0; index < request.batches.length; index += 1) {
      const batch = request.batches[index];
      const media = request.mediaBindGroup(batch);
      pass.setPipeline(media ? this.#mediaPipeline : this.#shapePipeline);
      if (media) pass.setBindGroup(0, media);
      pass.draw(batch.vertexCount, 1, batch.firstVertex, index);
    }
    if (request.particle) {
      this.#uploadParticle(request.particle.selectionId);
      pass.setPipeline(this.#particlePipeline);
      pass.setBindGroup(0, request.particle.bindGroup);
      pass.setBindGroup(1, this.#particleUniformBindGroup);
      pass.drawIndirect(request.particle.indirectBuffer, 0);
    }
    pass.end();
    this.#motionHistory.commit(request.encoder, request.vertexBuffer, request.vertexCount, motion);
    return true;
  }

  #beginPass(encoder: GPUCommandEncoder, label: string): GPURenderPassEncoder {
    if (!this.#depth) throw new Error("Auxiliary MRT depth target is unavailable");
    return encoder.beginRenderPass({
      label,
      colorAttachments: AUXILIARY_BUFFER_KINDS.map((kind) => ({
        view: this.#requiredTexture(kind).createView(),
        clearValue: AUXILIARY_BUFFER_DESCRIPTORS[kind].clearValue,
        loadOp: "clear" as const,
        storeOp: "store" as const,
      })),
      depthStencilAttachment: {
        view: this.#depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
  }

  destroy(): void {
    this.#destroyTargets();
    this.#idBuffer?.destroy();
    this.#idBuffer = undefined;
    this.#idBufferBytes = 0;
    this.#particleUniform.destroy();
    this.#motionHistory.destroy();
  }

  #uploadBatchIds(batches: readonly GeometryBatch[]): void {
    const records = buildAuxiliaryBatchIds(batches);
    const requiredBytes = idBufferCapacityBytes(batches.length);
    if (!this.#idBuffer || requiredBytes > this.#idBufferBytes) {
      this.#idBuffer?.destroy();
      this.#idBufferBytes = requiredBytes;
      this.#idBuffer = this.#device.createBuffer({
        label: "Auxiliary object/material ID instances",
        size: this.#idBufferBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (records.byteLength > 0) this.#device.queue.writeBuffer(this.#idBuffer, 0, records);
  }

  #uploadParticle(selectionId: string): void {
    this.#device.queue.writeBuffer(
      this.#particleUniform,
      0,
      buildAuxiliaryParticleIdentity(selectionId, this.#width, this.#height),
    );
  }

  #requiredTexture(kind: AuxiliaryBufferKind): GPUTexture {
    const texture = this.#textures.get(kind);
    if (!texture) throw new Error(`Auxiliary ${kind} target is unavailable`);
    return texture;
  }

  #destroyTargets(): void {
    destroyAuxiliaryBufferTextures(this.#textures);
    this.#textures.clear();
    this.#depth?.destroy();
    this.#depth = undefined;
    this.#estimatedBytes = 0;
    this.#enabled = false;
    this.#motionHistory.release();
    this.#motionShutterScale = 0;
  }
}

function idBufferCapacityBytes(instanceCount: number): number {
  const requiredBytes = Math.max(ID_RECORD_BYTES, instanceCount * ID_RECORD_BYTES);
  return 2 ** Math.ceil(Math.log2(requiredBytes));
}

export function buildAuxiliaryBatchIds(
  batches: readonly Pick<GeometryBatch, "selectionId" | "layer">[],
): Uint32Array {
  const records = new Uint32Array(batches.length * 2);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    records[index * 2] = encodeRenderId(batch.selectionId);
    records[index * 2 + 1] = encodeRenderId(materialKey(batch.layer));
  }
  return records;
}

export function buildAuxiliaryParticleIdentity(
  selectionId: string,
  width: number,
  height: number,
): ArrayBuffer {
  const data = new ArrayBuffer(32);
  const ids = new Uint32Array(data, 0, 4);
  ids[0] = encodeRenderId(selectionId);
  ids[1] = encodeRenderId("material:particle");
  new Float32Array(data, 16, 4).set([width, height, 0, 0]);
  return data;
}

function materialKey(layer: Layer): string {
  return `material:${JSON.stringify(layer.material ?? layer.mesh?.sourceMaterial ?? layer.kind)}`;
}

export const auxiliarySurfaceShader = /* wgsl */ `
struct SurfaceOutput {
  @location(0) normal: vec4f,
  @location(1) object_id: u32,
  @location(2) material_id: u32,
  @location(3) world_position: vec4f,
  @location(4) motion_vector: vec2f,
}
struct SurfaceVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) normal: vec3f,
  @location(3) world_position: vec3f,
  @location(4) shape_parameters: vec4f,
  @location(5) @interpolate(flat) object_id: u32,
  @location(6) @interpolate(flat) material_id: u32,
  @location(7) motion_vector: vec2f,
}

@vertex fn surface_vertex(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(4) normal: vec3f,
  @location(6) world_position: vec3f,
  @location(8) shape_parameters: vec4f,
  @location(12) object_id: u32,
  @location(13) material_id: u32,
  @location(14) previous_position: vec3f,
) -> SurfaceVertex {
  var output: SurfaceVertex;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.normal = normal;
  output.world_position = world_position;
  output.shape_parameters = shape_parameters;
  output.object_id = object_id;
  output.material_id = material_id;
  output.motion_vector = (position.xy - previous_position.xy) * vec2f(0.5, -0.5);
  return output;
}

fn write_surface(input: SurfaceVertex) -> SurfaceOutput {
  var output: SurfaceOutput;
  output.normal = vec4f(normalize(input.normal), 1.0);
  output.object_id = input.object_id;
  output.material_id = input.material_id;
  output.world_position = vec4f(input.world_position, 1.0);
  output.motion_vector = input.motion_vector;
  return output;
}

fn shape_coverage(input: SurfaceVertex) -> f32 {
  if (input.color.a <= 0.00001) { return 0.0; }
  let kind = input.shape_parameters.z;
  let centered = input.uv - vec2f(0.5);
  if (kind > 1.5 && kind < 2.5) {
    return select(0.0, 1.0, length(centered * 2.0) <= 1.0);
  }
  if (kind > 0.5 && kind < 1.5) {
    let radius = input.shape_parameters.y;
    let rounded = abs(centered) - vec2f(0.5 - radius);
    let distance = length(max(rounded, vec2f(0.0))) + min(max(rounded.x, rounded.y), 0.0) - radius;
    return select(0.0, 1.0, distance <= 0.0);
  }
  if (kind > 2.5 && kind < 3.5) {
    let line_radius = max(input.shape_parameters.x * 0.5, 0.003);
    return select(0.0, 1.0, abs(centered.y) <= line_radius && abs(centered.x) <= 0.5);
  }
  return 1.0;
}

@fragment fn surface_fragment(input: SurfaceVertex) -> SurfaceOutput {
  if (shape_coverage(input) <= 0.0) { discard; }
  return write_surface(input);
}

@group(0) @binding(0) var media_texture: texture_2d<f32>;
@group(0) @binding(1) var media_sampler: sampler;

@fragment fn media_fragment(input: SurfaceVertex) -> SurfaceOutput {
  if (textureSample(media_texture, media_sampler, input.uv).a * input.color.a <= 0.00001) { discard; }
  return write_surface(input);
}

struct Simulation {
  header: vec4f, motion: vec4f, appearance: vec4f, start_color: vec4f, end_color: vec4f,
}
struct ParticleIdentity { ids: vec4u, resolution: vec4f }
struct ParticleVertex {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) world_position: vec3f,
}
@group(0) @binding(0) var<storage, read> particles: array<vec4f>;
@group(0) @binding(1) var<uniform> simulation: Simulation;
@group(1) @binding(0) var<uniform> particle_identity: ParticleIdentity;

@vertex fn particle_vertex(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> ParticleVertex {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let particle = particles[instance];
  let packed = bitcast<u32>(particle.w);
  let rotation_cos = f32((packed >> 10u) & 2047u) / 1023.5 - 1.0;
  let rotation_sin = f32((packed >> 21u) & 2047u) / 1023.5 - 1.0;
  let unit = corners[vertex];
  let rotated = vec2f(
    unit.x * rotation_cos - unit.y * rotation_sin,
    unit.x * rotation_sin + unit.y * rotation_cos,
  );
  let clip = particle.xy + rotated * particle.z / 900.0;
  var output: ParticleVertex;
  output.position = vec4f(clip, 0.0, 1.0);
  output.local = unit;
  output.world_position = vec3f(
    (clip.x * 0.5 + 0.5) * particle_identity.resolution.x,
    (0.5 - clip.y * 0.5) * particle_identity.resolution.y,
    0.0,
  );
  return output;
}

@fragment fn particle_fragment(input: ParticleVertex) -> SurfaceOutput {
  if (length(input.local * vec2f(0.64, 1.0)) >= 1.0) { discard; }
  var output: SurfaceOutput;
  output.normal = vec4f(0.0, 0.0, 1.0, 1.0);
  output.object_id = particle_identity.ids.x;
  output.material_id = particle_identity.ids.y;
  output.world_position = vec4f(input.world_position, 1.0);
  output.motion_vector = vec2f(0.0);
  return output;
}
`;
