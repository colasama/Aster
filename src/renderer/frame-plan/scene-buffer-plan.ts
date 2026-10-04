import type { GeometryResult } from "../geometry/geometry";
import { requirePlan } from "./canonical";
import { compositionIdentityFromString } from "./composition-identity";
import { buildFrameHeader, type RootPostUniformPlanInput } from "./root-post-plan";
import {
  SCENE_LIGHTING_WIRE_BYTES,
  SCENE_VERTEX_WIRE_BYTES,
  sceneBufferByteLength,
} from "./scene-buffer-layout";
import { defaultFramePlanLimits, type FramePlanSliceData } from "./types";
import { validateMetadata } from "./validation";

export interface SceneBufferPlanInput extends RootPostUniformPlanInput {
  geometry: GeometryResult;
  lighting: Float32Array;
  motionVectors?: Float32Array;
  shadowsEnabled: boolean;
}

/** Owns evaluated camera-space geometry and lighting bytes; no Layer escapes this producer. */
export function buildSceneBufferPlan(input: SceneBufferPlanInput): FramePlanSliceData {
  const vertexCount = input.geometry.data.byteLength / SCENE_VERTEX_WIRE_BYTES;
  requirePlan(
    input.lighting.byteLength === SCENE_LIGHTING_WIRE_BYTES && Number.isInteger(vertexCount),
    "invalid_scene_buffers",
    "Producer ABI differs from scene wire layout",
  );
  requirePlan(
    !input.motionVectors || input.motionVectors.length === vertexCount * 2,
    "invalid_scene_buffers",
    "Motion vectors must match evaluated vertices",
  );
  const byteLength = sceneBufferByteLength(vertexCount, input.motionVectors !== undefined);
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "scene_buffers_slice_v1",
      renderer_plan_complete: false,
      header: buildFrameHeader(input),
      resources: [],
      blobs: [
        {
          byte_offset: 0,
          byte_length: byteLength,
          element_type: "f32_le",
          element_count: byteLength / 4,
        },
      ],
      slices: [
        {
          kind: "scene_buffers",
          blob_index: 0,
          vertex_count: vertexCount,
          motion_vectors: input.motionVectors !== undefined,
          shadows_enabled: input.shadowsEnabled,
          media_bindings: [],
          draws: input.geometry.batches.map((batch) => ({
            instance_id: compositionIdentityFromString(batch.instanceId),
            resource_instance_id: compositionIdentityFromString(batch.resourceInstanceId),
            selection_id: compositionIdentityFromString(batch.selectionId),
            first_vertex: batch.firstVertex,
            vertex_count: batch.vertexCount,
            casts_shadow: Boolean(batch.layer.threeDimensional),
          })),
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const values of [
    input.lighting,
    input.geometry.data,
    ...(input.motionVectors ? [input.motionVectors] : []),
  ]) {
    // Preserve all f32 bit patterns, including signed zero and any producer NaN payload.
    const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
    for (const value of bits) {
      view.setUint32(offset, value, true);
      offset += 4;
    }
  }
  return { metadata, blobs: [bytes] };
}
