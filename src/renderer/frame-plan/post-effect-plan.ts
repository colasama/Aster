import { requirePlan } from "./canonical";
import type { PostEffect } from "./post-effect-layout";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function buildPostEffectPlan(
  header: FrameHeaderSlice,
  effect: PostEffect,
  ready: boolean,
  uniforms: Uint8Array,
): FramePlanSliceData {
  const bytes = new Uint8Array(uniforms);
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "post_effect_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [],
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
          kind: "post_effect",
          blob_index: 0,
          status: ready ? "ready" : "skipped",
          effect: structuredClone(effect),
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}
export function readPostEffectPlan(input: FramePlanSliceData) {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "post_effect_slice_v1" && input.blobs.length === 1,
    "invalid_header",
    "Expected post effect plan",
  );
  const slice = metadata.slices[0];
  requirePlan(slice.kind === "post_effect", "invalid_header", "Missing post effect slice");
  validatePlanBlob(input.blobs[0], metadata, 0);
  return {
    header: structuredClone(metadata.header),
    slice: structuredClone(slice),
    uniforms: new Uint8Array(input.blobs[0]),
  };
}
