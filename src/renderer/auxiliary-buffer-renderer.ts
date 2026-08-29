import { logger } from "../core/logger";
import type { Layer } from "../core/types";
import type { SceneBufferVisualizer } from "./buffer-visualizer";
import type { GeometryBatch } from "./geometry";
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
import { GpuTimeAddressedMotionVectors } from "./time-addressed-motion-vectors";

const ID_RECORD_BYTES = 8;

export interface GeneratorDraw {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  indirectBuffer: GPUBuffer;
}

export interface AuxiliaryEncodeRequest {
  encoder: GPUCommandEncoder;
  vertexBuffer: GPUBuffer;
  vertexCount: number;
  batches: readonly GeometryBatch[];
  motionVectors?: Float32Array;
  mediaBindGroup: (batch: GeometryBatch) => GPUBindGroup | undefined;
  generators?: readonly GeneratorDraw[];
}

/** Owns the transient MRT surface-data pass used by the viewport debugger. */
export class AuxiliaryBufferRenderer {
  readonly #device: GPUDevice;
  readonly #shapePipeline: GPURenderPipeline;
  readonly #mediaPipeline: GPURenderPipeline;
  readonly #motionVectors: GpuTimeAddressedMotionVectors;
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
  #allocationFailureReported = false;
  #budgetFailureReported = false;
  readonly supported: boolean;

  constructor(device: GPUDevice, imageBindGroupLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#motionVectors = new GpuTimeAddressedMotionVectors(device);
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
        arrayStride: 8,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 14, offset: 0, format: "float32x2" }],
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
  }

  get estimatedBytes(): number {
    return this.#estimatedBytes + this.#idBufferBytes + this.#motionVectors.estimatedBytes;
  }

  get textures(): ReadonlyMap<AuxiliaryBufferKind, GPUTexture> {
    return this.#textures;
  }

  get motionShutterScale(): number {
    return this.#motionShutterScale;
  }

  get enabled(): boolean {
    return this.#enabled;
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
      this.#allocationFailureReported = false;
      return true;
    } catch (error) {
      this.#destroyTargets();
      if (!this.#allocationFailureReported) {
        this.#allocationFailureReported = true;
        logger.warn(
          "webgpu",
          "auxiliary_buffer_allocation_failed",
          { width, height, requiredBytes },
          error,
        );
      }
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
    forceSurfaceData = false,
  ): BufferVisualization {
    if (!usesAuxiliarySurfaceData(mode) && !forceSurfaceData) {
      this.disable();
      visualizer.clearAuxiliarySources();
      return mode;
    }
    if (!this.enable(width, height, (budgetMb ?? 512) * 1024 * 1024 * 0.5)) {
      logger.warn("webgpu", "auxiliary_buffers_unavailable", {
        supported: this.supported,
        width,
        height,
        budgetMb,
      });
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
      this.#motionVectors.plannedBytes(request.vertexCount);
    if (plannedBytes > this.#byteBudget) {
      if (!this.#budgetFailureReported) {
        this.#budgetFailureReported = true;
        logger.warn("webgpu", "auxiliary_buffer_budget_exceeded", {
          plannedBytes,
          byteBudget: this.#byteBudget,
        });
      }
      this.#beginPass(request.encoder, "Auxiliary MRT budget fallback · cleared").end();
      this.#motionShutterScale = 0;
      return false;
    }
    this.#budgetFailureReported = false;
    this.#uploadBatchIds(request.batches);
    const idBuffer = this.#idBuffer;
    if (!idBuffer) return false;
    const vectors = request.motionVectors ?? new Float32Array(request.vertexCount * 2);
    if (vectors.length !== request.vertexCount * 2)
      throw new Error("Auxiliary motion vectors must match the current geometry vertex count");
    const motionBuffer = this.#motionVectors.upload(vectors);
    this.#motionShutterScale = request.motionVectors ? 1 : 0;
    const pass = this.#beginPass(
      request.encoder,
      "Normal + IDs + World Position + Motion Vector MRT",
    );
    pass.setVertexBuffer(0, request.vertexBuffer);
    pass.setVertexBuffer(1, idBuffer);
    pass.setVertexBuffer(2, motionBuffer);
    for (let index = 0; index < request.batches.length; index += 1) {
      const batch = request.batches[index];
      const media = request.mediaBindGroup(batch);
      pass.setPipeline(media ? this.#mediaPipeline : this.#shapePipeline);
      if (media) pass.setBindGroup(0, media);
      pass.draw(batch.vertexCount, 1, batch.firstVertex, index);
    }
    for (const generator of request.generators ?? []) {
      pass.setPipeline(generator.pipeline);
      pass.setBindGroup(0, generator.bindGroup);
      pass.drawIndirect(generator.indirectBuffer, 0);
    }
    pass.end();
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
    this.#motionVectors.destroy();
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
    this.#motionVectors.release();
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
  @location(14) motion_vector: vec2f,
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
  output.motion_vector = motion_vector;
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
`;
