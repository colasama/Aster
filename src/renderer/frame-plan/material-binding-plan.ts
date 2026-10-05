import type { MaterialBindingPlan } from "../media/material-texture-plan";
import { requirePlan } from "./canonical";
import { compositionIdentityFromString, compositionIdentityToString } from "./composition-identity";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

/** Preserve binary64 evaluation values; GPU float32 conversion happens only at upload. */
export function buildMaterialBindingSlice(
  header: FrameHeaderSlice,
  input: MaterialBindingPlan,
): FramePlanSliceData {
  requirePlan(
    input.normalEnabled === (input.normalHash !== null) &&
      input.active === (input.normalEnabled || input.environmentIntensity > 0),
    "invalid_material_binding",
    "Material activity differs from supplied inputs",
  );
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  [input.normalScale, input.environmentIntensity, input.environmentRotation].forEach(
    (value, index) => {
      view.setFloat64(index * 8, value, true);
    },
  );
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "material_bindings_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [input.normalHash, input.environmentHash]
        .filter((hash): hash is string => hash !== null)
        .sort(),
      blobs: [{ byte_offset: 0, byte_length: 24, element_type: "u8", element_count: 24 }],
      slices: [
        {
          kind: "material_binding",
          blob_index: 0,
          instance_id: compositionIdentityFromString(input.instanceId),
          normal:
            input.normalHash === null
              ? { kind: "fallback" }
              : { kind: "texture", hash: input.normalHash },
          environment:
            input.environmentHash === null
              ? { kind: "fallback" }
              : { kind: "texture", hash: input.environmentHash },
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}

export function readMaterialBindingSlice(supplied: FramePlanSliceData): MaterialBindingPlan {
  const metadata = validateMetadata(supplied.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "material_bindings_slice_v1" &&
      metadata.slices.length === 1 &&
      supplied.blobs.length === 1,
    "invalid_material_binding",
    "Expected one material binding slice",
  );
  const slice = metadata.slices[0];
  requirePlan(
    slice.kind === "material_binding",
    "invalid_material_binding",
    "Missing material binding",
  );
  const bytes = supplied.blobs[slice.blob_index];
  validatePlanBlob(bytes, metadata, slice.blob_index);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const normalEnabled = slice.normal.kind === "texture";
  const environmentIntensity = view.getFloat64(8, true);
  return {
    instanceId: compositionIdentityToString(slice.instance_id),
    normalHash: slice.normal.kind === "texture" ? slice.normal.hash : null,
    environmentHash: slice.environment.kind === "texture" ? slice.environment.hash : null,
    active: normalEnabled || environmentIntensity > 0,
    normalEnabled,
    normalScale: view.getFloat64(0, true),
    environmentIntensity,
    environmentRotation: view.getFloat64(16, true),
  };
}
