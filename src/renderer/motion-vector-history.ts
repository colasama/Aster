import { FLOATS_PER_VERTEX, type GeometryBatch } from "./geometry";

const EXTRACTED_POSITION_BYTES = 16;
const PARAMETER_BYTES = 16;
export const MAX_REUSABLE_MOTION_FRAMES = 2;
export const MOTION_SHUTTER_FRACTION = 0.5;
const MAX_SHUTTER_SCALE = 4;

export interface MotionFrameIdentity {
  timelineTime: number;
  layoutSignature: string;
}

export interface PreparedMotionFrame {
  buffer: GPUBuffer;
  identity: MotionFrameIdentity;
  reusedHistory: boolean;
  shutterScale: number;
}

export interface MotionHistorySchedule {
  extractBeforeRender: boolean;
  extractAfterRender: boolean;
  reusePreviousSample: boolean;
  shutterScale: number;
}

/**
 * Motion compares against a strictly earlier sample no more than two composition frames away.
 * Same-time renders, reverse playback, topology changes, and larger seeks start a new history
 * epoch so edits, dropped frames, and timeline navigation cannot create false velocity.
 */
export function canReuseMotionHistory(
  previous: MotionFrameIdentity | undefined,
  current: MotionFrameIdentity,
  frameRate = 60,
): boolean {
  const timelineDelta = previous ? current.timelineTime - previous.timelineTime : 0;
  const maximumDelta = MAX_REUSABLE_MOTION_FRAMES / boundedFrameRate(frameRate);
  return (
    previous !== undefined &&
    Number.isFinite(current.timelineTime) &&
    timelineDelta > 0 &&
    timelineDelta <= maximumDelta + Number.EPSILON * 16 &&
    current.layoutSignature === previous.layoutSignature
  );
}

/** Normalizes observed displacement to a 180-degree shutter interval at the composition rate. */
export function normalizedMotionShutterScale(
  previous: MotionFrameIdentity | undefined,
  current: MotionFrameIdentity,
  frameRate = 60,
): number {
  if (!canReuseMotionHistory(previous, current, frameRate) || !previous) return 0;
  const timelineDelta = current.timelineTime - previous.timelineTime;
  const shutterDuration = MOTION_SHUTTER_FRACTION / boundedFrameRate(frameRate);
  return Math.min(MAX_SHUTTER_SCALE, shutterDuration / timelineDelta);
}

export function planMotionHistory(
  previous: MotionFrameIdentity | undefined,
  current: MotionFrameIdentity,
  storageReallocated = false,
  frameRate = 60,
): MotionHistorySchedule {
  const reusePreviousSample =
    !storageReallocated && canReuseMotionHistory(previous, current, frameRate);
  return {
    extractBeforeRender: !reusePreviousSample,
    extractAfterRender: reusePreviousSample,
    reusePreviousSample,
    shutterScale: reusePreviousSample
      ? normalizedMotionShutterScale(previous, current, frameRate)
      : 0,
  };
}

/** Stable instance identity plus vertex ranges guarantees vertex-to-vertex history correspondence. */
export function buildMotionLayoutSignature(
  batches: readonly Pick<
    GeometryBatch,
    "firstVertex" | "instanceId" | "resourceInstanceId" | "vertexCount"
  >[],
): string {
  return JSON.stringify(
    batches.map(({ firstVertex, instanceId, resourceInstanceId, vertexCount }) => [
      instanceId,
      resourceInstanceId,
      firstVertex,
      vertexCount,
    ]),
  );
}

/** Actual power-of-two GPU allocation used for tightly packed previous clip positions. */
export function motionHistoryBufferBytes(vertexCount: number): number {
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0)
    throw new Error("Motion history vertex count must be a non-negative safe integer");
  const required = Math.max(EXTRACTED_POSITION_BYTES, vertexCount * EXTRACTED_POSITION_BYTES);
  return 2 ** Math.ceil(Math.log2(required));
}

/** Extracts positions on-GPU and keeps only 16 bytes per vertex instead of duplicating geometry. */
export class GpuMotionVectorHistory {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #parameters: GPUBuffer;
  #positions?: GPUBuffer;
  #capacityBytes = 0;
  #bindGroup?: GPUBindGroup;
  #source?: GPUBuffer;
  #frame?: MotionFrameIdentity;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({
      label: "Motion-vector position history extractor",
      code: extractPositionsShader,
    });
    this.#pipeline = device.createComputePipeline({
      label: "GPU compact motion-vector history",
      layout: "auto",
      compute: { module, entryPoint: "extract_positions" },
    });
    this.#parameters = device.createBuffer({
      label: "Motion-vector history parameters",
      size: PARAMETER_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get estimatedBytes(): number {
    return PARAMETER_BYTES + this.#capacityBytes;
  }

  plannedBytes(vertexCount: number): number {
    return PARAMETER_BYTES + Math.max(this.#capacityBytes, motionHistoryBufferBytes(vertexCount));
  }

  prepare(
    encoder: GPUCommandEncoder,
    source: GPUBuffer,
    vertexCount: number,
    batches: readonly GeometryBatch[],
    timelineTime: number,
    frameRate: number,
  ): PreparedMotionFrame {
    const reallocated = this.#ensureCapacity(vertexCount);
    const identity = {
      timelineTime,
      layoutSignature: buildMotionLayoutSignature(batches),
    } satisfies MotionFrameIdentity;
    const schedule = planMotionHistory(this.#frame, identity, reallocated, frameRate);
    if (schedule.extractBeforeRender) this.#encodeExtraction(encoder, source, vertexCount);
    const buffer = this.#positions;
    if (!buffer) throw new Error("Motion-vector history buffer is unavailable");
    return {
      buffer,
      identity,
      reusedHistory: schedule.reusePreviousSample,
      shutterScale: schedule.shutterScale,
    };
  }

  commit(
    encoder: GPUCommandEncoder,
    source: GPUBuffer,
    vertexCount: number,
    prepared: PreparedMotionFrame,
  ): void {
    if (prepared.reusedHistory) this.#encodeExtraction(encoder, source, vertexCount);
    this.#frame = prepared.identity;
  }

  reset(): void {
    this.#frame = undefined;
  }

  release(): void {
    this.#positions?.destroy();
    this.#positions = undefined;
    this.#capacityBytes = 0;
    this.#bindGroup = undefined;
    this.#source = undefined;
    this.reset();
  }

  destroy(): void {
    this.release();
    this.#parameters.destroy();
  }

  #ensureCapacity(vertexCount: number): boolean {
    const requiredBytes = motionHistoryBufferBytes(vertexCount);
    if (this.#positions && requiredBytes <= this.#capacityBytes) return false;
    this.#positions?.destroy();
    this.#positions = this.#device.createBuffer({
      label: "Compact previous clip positions",
      size: requiredBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.#capacityBytes = requiredBytes;
    this.#bindGroup = undefined;
    this.#source = undefined;
    this.reset();
    return true;
  }

  #encodeExtraction(encoder: GPUCommandEncoder, source: GPUBuffer, vertexCount: number): void {
    const positions = this.#positions;
    if (!positions || vertexCount === 0) return;
    if (!this.#bindGroup || this.#source !== source) {
      this.#source = source;
      this.#bindGroup = this.#device.createBindGroup({
        label: "Motion-vector history extraction resources",
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: source } },
          { binding: 1, resource: { buffer: positions } },
          { binding: 2, resource: { buffer: this.#parameters } },
        ],
      });
    }
    this.#device.queue.writeBuffer(this.#parameters, 0, new Uint32Array([vertexCount, 0, 0, 0]));
    const pass = encoder.beginComputePass({ label: "Extract current clip positions" });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.dispatchWorkgroups(Math.ceil(vertexCount / 256));
    pass.end();
  }
}

function boundedFrameRate(value: number): number {
  return Number.isFinite(value) ? Math.min(1000, Math.max(1, value)) : 60;
}

export const extractPositionsShader = /* wgsl */ `
struct Parameters { vertex_count: u32, padding_0: u32, padding_1: u32, padding_2: u32 }
@group(0) @binding(0) var<storage, read> scene_vertices: array<f32>;
@group(0) @binding(1) var<storage, read_write> compact_positions: array<vec4f>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@compute @workgroup_size(256)
fn extract_positions(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= parameters.vertex_count) { return; }
  let source = id.x * ${FLOATS_PER_VERTEX}u;
  compact_positions[id.x] = vec4f(
    scene_vertices[source],
    scene_vertices[source + 1u],
    scene_vertices[source + 2u],
    1.0,
  );
}
`;
