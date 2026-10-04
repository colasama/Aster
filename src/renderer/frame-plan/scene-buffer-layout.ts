import { integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { BlobDescriptor, SceneBuffersSlice } from "./types";

/** Wire ABI: 148 lighting f32 lanes, 40 f32 lanes per vertex, optional vec2 motion. */
export const SCENE_LIGHTING_WIRE_BYTES = 592;
export const SCENE_VERTEX_WIRE_BYTES = 160;

export function sceneBufferByteLength(vertexCount: number, motionVectors: boolean): number {
  return (
    SCENE_LIGHTING_WIRE_BYTES + vertexCount * (SCENE_VERTEX_WIRE_BYTES + (motionVectors ? 8 : 0))
  );
}

export function validateSceneBuffers(value: unknown, blob: BlobDescriptor): SceneBuffersSlice {
  const slice = object(value, [
    "kind",
    "blob_index",
    "vertex_count",
    "motion_vectors",
    "shadows_enabled",
    "draws",
  ]);
  const count = integer(slice.vertex_count, 0, 0xffff_ffff);
  requirePlan(
    typeof slice.motion_vectors === "boolean" && typeof slice.shadows_enabled === "boolean",
    "invalid_scene_buffers",
    "Scene flags must be booleans",
  );
  requirePlan(
    blob.element_type === "f32_le" &&
      blob.byte_length === sceneBufferByteLength(count, slice.motion_vectors as boolean),
    "invalid_scene_buffers",
    "Scene bytes do not match lighting, vertex and motion layouts",
  );
  requirePlan(Array.isArray(slice.draws), "invalid_scene_buffers", "Missing draw records");
  let end = 0;
  for (const entry of slice.draws) {
    const draw = object(entry, [
      "instance_id",
      "resource_instance_id",
      "selection_id",
      "first_vertex",
      "vertex_count",
      "casts_shadow",
    ]);
    compositionIdentityToString(draw.instance_id);
    compositionIdentityToString(draw.resource_instance_id);
    compositionIdentityToString(draw.selection_id);
    requirePlan(
      typeof draw.casts_shadow === "boolean",
      "invalid_scene_buffers",
      "Invalid shadow draw flag",
    );
    const first = integer(draw.first_vertex, 0, count);
    const length = integer(draw.vertex_count, 0, count);
    requirePlan(
      first === end && first + length <= count,
      "invalid_scene_buffers",
      "Draw ranges must partition the vertex stream in order",
    );
    end = first + length;
  }
  requirePlan(end === count, "invalid_scene_buffers", "Draw ranges do not cover all vertices");
  return slice as unknown as SceneBuffersSlice;
}
