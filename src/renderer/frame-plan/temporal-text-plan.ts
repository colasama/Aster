import type { TextMotionBlurPlan } from "../text/text-motion-blur-plan";
import { requirePlan } from "./canonical";
import { compositionIdentityFromString, compositionIdentityToString } from "./composition-identity";
import { buildFrameHeader, type RootPostUniformPlanInput } from "./root-post-plan";
import { temporalTextByteLength } from "./temporal-text-layout";
import { defaultFramePlanLimits, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function buildTemporalTextPlan(
  header: RootPostUniformPlanInput,
  resourceInstanceId: string,
  plan: TextMotionBlurPlan,
  exposureOnly: boolean,
): FramePlanSliceData {
  const length = temporalTextByteLength(plan.samples.length);
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "temporal_text_samples_slice_v1",
      renderer_plan_complete: false,
      header: buildFrameHeader(header),
      resources: [],
      blobs: [{ byte_offset: 0, byte_length: length, element_type: "u8", element_count: length }],
      slices: [
        {
          kind: "temporal_text_samples",
          blob_index: 0,
          resource_instance_id: compositionIdentityFromString(resourceInstanceId),
          sample_count: plan.sampleCount,
          unique_sample_count: plan.samples.length,
          exposure_only: exposureOnly,
          sample_format: "rgba8unorm-srgb",
          accumulation_format: "rgba16float",
          resolve_format: "rgba8unorm-srgb",
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, plan.frameTime, true);
  view.setFloat64(8, plan.transparentWeight, true);
  plan.samples.forEach((sample, index) => {
    view.setFloat64(16 + index * 24, sample.localTime, true);
    view.setFloat64(24 + index * 24, sample.weight, true);
    view.setFloat64(32 + index * 24, sample.timeBucket, true);
  });
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}

/** Supplied values drive raster preparation; no authoring or motion evaluation is available here. */
export function readTemporalTextPlan(plan: FramePlanSliceData) {
  const metadata = validateMetadata(plan.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "temporal_text_samples_slice_v1" &&
      metadata.slices.length === 1 &&
      plan.blobs.length === 1 &&
      metadata.resources.length === 0,
    "invalid_temporal_text",
    "Expected one temporal text sample slice",
  );
  const slice = metadata.slices[0];
  requirePlan(slice.kind === "temporal_text_samples", "invalid_temporal_text", "Missing samples");
  const bytes = plan.blobs[slice.blob_index];
  validatePlanBlob(bytes, metadata, slice.blob_index);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Array.from({ length: slice.unique_sample_count }, (_, index) => ({
    localTime: view.getFloat64(16 + index * 24, true),
    weight: view.getFloat64(24 + index * 24, true),
    timeBucket: view.getFloat64(32 + index * 24, true),
  }));
  const evaluated: TextMotionBlurPlan = {
    frameTime: view.getFloat64(0, true),
    transparentWeight: view.getFloat64(8, true),
    sampleCount: slice.sample_count,
    samples,
  };
  return {
    resourceInstanceId: compositionIdentityToString(slice.resource_instance_id),
    exposureOnly: slice.exposure_only,
    plan: evaluated,
  };
}
