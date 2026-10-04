import {
  type TemporalTextPassPlan,
  validateTemporalTextPassPlan,
} from "../text/text-motion-blur-pass-plan";
import { requirePlan } from "./canonical";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function buildTemporalPassSlice(
  header: FrameHeaderSlice,
  input: TemporalTextPassPlan,
): FramePlanSliceData {
  const plan = validateTemporalTextPassPlan(input);
  const bytes = new Uint8Array(8 * (plan.samples.length + 1));
  const view = new DataView(bytes.buffer);
  const total = plan.samples.reduce((sum, sample) => sum + sample.weight, 0);
  view.setFloat64(0, Math.max(0, 1 - total), true);
  plan.samples.forEach((sample, index) => {
    view.setFloat64(8 * (index + 1), sample.weight, true);
  });
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "temporal_text_passes_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [plan.output, ...plan.samples.map((sample) => sample.hash)].sort(),
      blobs: [
        {
          byte_offset: 0,
          byte_length: bytes.length,
          element_type: "u8",
          element_count: bytes.length,
        },
      ],
      slices: [{ ...plan, blob_index: 0, samples: plan.samples.map((sample) => sample.hash) }],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}

export function readTemporalPassSlice(supplied: FramePlanSliceData): TemporalTextPassPlan {
  const metadata = validateMetadata(supplied.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "temporal_text_passes_slice_v1" &&
      metadata.slices.length === 1 &&
      supplied.blobs.length === 1,
    "invalid_temporal_text",
    "Expected one temporal pass slice",
  );
  const slice = metadata.slices[0];
  requirePlan(
    slice.kind === "temporal_text_passes",
    "invalid_temporal_text",
    "Missing temporal passes",
  );
  const bytes = supplied.blobs[slice.blob_index];
  validatePlanBlob(bytes, metadata, slice.blob_index);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { blob_index: _index, ...plan } = slice;
  return validateTemporalTextPassPlan({
    ...plan,
    samples: slice.samples.map((hash, index) => ({
      hash,
      weight: view.getFloat64(8 * (index + 1), true),
    })),
  });
}
