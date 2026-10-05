import type { AuxiliarySlice, AuxiliaryTexture } from "./auxiliary-layout";
import { canonicalJson, requirePlan } from "./canonical";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function auxiliaryTextureKey(texture: AuxiliaryTexture): string {
  return canonicalJson(texture);
}
export function buildAuxiliaryPlan(
  header: FrameHeaderSlice,
  input: Omit<AuxiliarySlice, "kind" | "blob_index" | "motion">,
  ids: Uint32Array,
  motion?: Float32Array,
): FramePlanSliceData {
  requirePlan(
    ids.length === input.draws.length * 2,
    "invalid_header",
    "Auxiliary ID count differs from draws",
  );
  requirePlan(
    !motion || motion.length === input.vertex_count * 2,
    "invalid_header",
    "Auxiliary motion vectors differ from geometry",
  );
  const bytes = new Uint8Array(Math.max(4, ids.byteLength + (motion?.byteLength ?? 0))),
    view = new DataView(bytes.buffer);
  ids.forEach((v, i) => {
    view.setUint32(i * 4, v, true);
  });
  motion?.forEach((v, i) => {
    view.setFloat32(ids.byteLength + i * 4, v, true);
  });
  const resources = [
    ...new Set(input.draws.flatMap((d) => (d.texture.kind === "media" ? [d.texture.hash] : []))),
  ].sort();
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "auxiliary_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources,
      blobs: [
        {
          byte_offset: 0,
          byte_length: bytes.length,
          element_type: "u8",
          element_count: bytes.length,
        },
      ],
      slices: [
        {
          ...structuredClone(input),
          kind: "auxiliary",
          blob_index: 0,
          motion: motion !== undefined,
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}
export function readAuxiliaryPlan(input: FramePlanSliceData) {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "auxiliary_slice_v1" && input.blobs.length === 1,
    "invalid_header",
    "Expected auxiliary plan",
  );
  const slice = metadata.slices[0];
  requirePlan(slice.kind === "auxiliary", "invalid_header", "Missing auxiliary slice");
  validatePlanBlob(input.blobs[0], metadata, 0);
  const bytes = input.blobs[0],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ids = new Uint32Array(slice.draws.length * 2);
  ids.forEach((_, i) => {
    ids[i] = view.getUint32(i * 4, true);
  });
  const motion = slice.motion ? new Float32Array(slice.vertex_count * 2) : undefined;
  motion?.forEach((_, i) => {
    motion[i] = view.getFloat32(ids.byteLength + i * 4, true);
  });
  return { header: structuredClone(metadata.header), slice: structuredClone(slice), ids, motion };
}
