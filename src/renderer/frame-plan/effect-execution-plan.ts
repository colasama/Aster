import type { BlendMode } from "../../core/types";
import { integer, requirePlan } from "./canonical";
import { compositionIdentityFromString, compositionIdentityToString } from "./composition-identity";
import type { FrameHeaderSlice, FramePlanSliceData } from "./types";
import { defaultFramePlanLimits } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export interface EffectExecution {
  instanceId: string;
  layerId: string;
  route: "direct" | "layer" | "adjustment" | "skip";
  blendMode: BlendMode;
  composite: "none" | "fixed" | "backdrop" | "replace";
  fusion: {
    fusedEffectCount: number;
    fusedGroupCount: number;
    barrierCount: number;
    operationCount: number;
  };
}

export function buildEffectExecutionSlice(
  header: FrameHeaderSlice,
  input: EffectExecution,
): FramePlanSliceData {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  [
    input.fusion.fusedEffectCount,
    input.fusion.fusedGroupCount,
    input.fusion.barrierCount,
    input.fusion.operationCount,
  ].forEach((value, i) => {
    view.setUint32(i * 4, integer(value, 0, 0xffff_ffff), true);
  });
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "effect_execution_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [],
      blobs: [{ byte_offset: 0, byte_length: 16, element_type: "u32_le", element_count: 4 }],
      slices: [
        {
          kind: "effect_execution",
          blob_index: 0,
          instance_id: compositionIdentityFromString(input.instanceId),
          layer_id: compositionIdentityFromString(input.layerId),
          route: input.route,
          blend_mode: input.blendMode,
          composite: input.composite,
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}

export function readEffectExecutionSlice(input: FramePlanSliceData): EffectExecution {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "effect_execution_slice_v1" &&
      metadata.slices.length === 1 &&
      input.blobs.length === 1,
    "invalid_effect_execution",
    "Expected one execution slice",
  );
  const slice = metadata.slices[0];
  requirePlan(
    slice.kind === "effect_execution",
    "invalid_effect_execution",
    "Missing execution slice",
  );
  const bytes = input.blobs[slice.blob_index];
  validatePlanBlob(bytes, metadata, slice.blob_index);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    instanceId: compositionIdentityToString(slice.instance_id),
    layerId: compositionIdentityToString(slice.layer_id),
    route: slice.route,
    blendMode: slice.blend_mode,
    composite: slice.composite,
    fusion: {
      fusedEffectCount: view.getUint32(0, true),
      fusedGroupCount: view.getUint32(4, true),
      barrierCount: view.getUint32(8, true),
      operationCount: view.getUint32(12, true),
    },
  };
}
