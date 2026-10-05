import type { BlendMode } from "../../core/types";
import type { EffectProgram } from "../effects/effect-program";
import { requirePlan } from "./canonical";
import { compositionIdentityFromString, compositionIdentityToString } from "./composition-identity";
import { LAYER_EFFECT_BYTES } from "./layer-effect-layout";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function buildLayerEffectSlice(
  header: FrameHeaderSlice,
  input: {
    instanceId: string;
    blendMode: BlendMode;
    route: "layer" | "adjustment";
    lutHash: string;
    program: EffectProgram;
    uniforms: Float32Array;
  },
): FramePlanSliceData {
  requirePlan(
    input.uniforms.length === 24 && input.program.data.length === 1024,
    "invalid_layer_effect",
    "Effect producer ABI differs",
  );
  const bytes = new Uint8Array(LAYER_EFFECT_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const values of [input.uniforms, input.program.data]) {
    const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
    for (const value of bits) {
      view.setUint32(offset, value, true);
      offset += 4;
    }
  }
  view.setFloat64(4192, input.program.glowThreshold, true);
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "layer_effects_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [input.lutHash],
      blobs: [
        {
          byte_offset: 0,
          byte_length: LAYER_EFFECT_BYTES,
          element_type: "u8",
          element_count: LAYER_EFFECT_BYTES,
        },
      ],
      slices: [
        {
          kind: "layer_effect",
          blob_index: 0,
          instance_id: compositionIdentityFromString(input.instanceId),
          blend_mode: input.blendMode,
          route: input.route,
          operation_count: input.program.count,
          uses_blur: input.program.usesBlur,
          uses_glow: input.program.usesGlow,
          lut_hash: input.lutHash,
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}

export function readLayerEffectSlice(supplied: FramePlanSliceData) {
  const metadata = validateMetadata(supplied.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "layer_effects_slice_v1" &&
      metadata.slices.length === 1 &&
      supplied.blobs.length === 1,
    "invalid_layer_effect",
    "Expected one effect slice",
  );
  const slice = metadata.slices[0];
  requirePlan(slice.kind === "layer_effect", "invalid_layer_effect", "Missing effect slice");
  const bytes = supplied.blobs[slice.blob_index];
  validatePlanBlob(bytes, metadata, slice.blob_index);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(1048);
  const bits = new Uint32Array(values.buffer);
  for (let i = 0; i < bits.length; i++) bits[i] = view.getUint32(i * 4, true);
  return {
    metadata,
    slice,
    instanceId: compositionIdentityToString(slice.instance_id),
    uniforms: values.subarray(0, 24),
    program: {
      data: values.subarray(24),
      count: slice.operation_count,
      usesBlur: slice.uses_blur,
      usesGlow: slice.uses_glow,
      glowThreshold: view.getFloat64(4192, true),
    },
  };
}
