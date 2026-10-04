import { requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import { SCENE_LIGHTING_WIRE_BYTES, SCENE_VERTEX_WIRE_BYTES } from "./scene-buffer-layout";
import { defaultFramePlanLimits, type FramePlanSliceData, type SceneBuffersSlice } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export interface SceneBufferDestination {
  queue: Pick<GPUQueue, "writeBuffer">;
  lightingBuffer: GPUBuffer;
  shapeBuffer: GPUBuffer;
  ensureShapeBuffer(bytes: number): void;
}

export interface PreparedSceneBuffers {
  slice: SceneBuffersSlice;
  lighting: Uint8Array;
  vertices: Uint8Array;
  motionVectors?: Float32Array;
  draws: {
    instanceId: string;
    resourceInstanceId: string;
    selectionId: string;
    firstVertex: number;
    vertexCount: number;
    castsShadow: boolean;
  }[];
}

/** Validates transport before any GPU side effects, including borrowed unaligned views. */
export function prepareSceneBuffers(plan: FramePlanSliceData): PreparedSceneBuffers {
  const metadata = validateMetadata(plan.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "scene_buffers_slice_v1" &&
      metadata.slices.length === 1 &&
      metadata.resources.length === 0 &&
      plan.blobs.length === 1,
    "invalid_scene_buffers",
    "Scene upload requires one complete buffer slice",
  );
  const slice = metadata.slices[0];
  requirePlan(
    slice.kind === "scene_buffers",
    "invalid_scene_buffers",
    "Missing scene buffer slice",
  );
  const bytes = plan.blobs[slice.blob_index];
  validatePlanBlob(bytes, metadata, slice.blob_index);
  const vertexEnd = SCENE_LIGHTING_WIRE_BYTES + slice.vertex_count * SCENE_VERTEX_WIRE_BYTES;
  let motionVectors: Float32Array | undefined;
  if (slice.motion_vectors) {
    motionVectors = new Float32Array(slice.vertex_count * 2);
    const bits = new Uint32Array(motionVectors.buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < bits.length; index += 1)
      bits[index] = view.getUint32(vertexEnd + index * 4, true);
  }
  return {
    slice,
    lighting: bytes.subarray(0, SCENE_LIGHTING_WIRE_BYTES),
    vertices: bytes.subarray(SCENE_LIGHTING_WIRE_BYTES, vertexEnd),
    motionVectors,
    draws: slice.draws.map((draw) => ({
      instanceId: compositionIdentityToString(draw.instance_id),
      resourceInstanceId: compositionIdentityToString(draw.resource_instance_id),
      selectionId: compositionIdentityToString(draw.selection_id),
      firstVertex: draw.first_vertex,
      vertexCount: draw.vertex_count,
      castsShadow: draw.casts_shadow,
    })),
  };
}

export function uploadSceneBuffers(
  plan: PreparedSceneBuffers,
  destination: SceneBufferDestination,
): void {
  const lighting = plan.lighting;
  destination.queue.writeBuffer(
    destination.lightingBuffer,
    0,
    lighting.buffer,
    lighting.byteOffset,
    lighting.byteLength,
  );
  const vertices = plan.vertices;
  if (vertices.byteLength > 0) {
    destination.ensureShapeBuffer(vertices.byteLength);
    destination.queue.writeBuffer(
      destination.shapeBuffer,
      0,
      vertices.buffer,
      vertices.byteOffset,
      vertices.byteLength,
    );
  }
}

export function drawSceneShadows(
  plan: PreparedSceneBuffers,
  pass: Pick<GPURenderPassEncoder, "draw">,
): void {
  if (!plan.slice.shadows_enabled) return;
  for (const draw of plan.draws) {
    if (draw.castsShadow) pass.draw(draw.vertexCount, 1, draw.firstVertex);
  }
}
