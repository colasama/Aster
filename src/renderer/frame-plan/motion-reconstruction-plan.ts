import type { MotionBlurInterval } from "../../core/animation/motion-blur";
import type { MotionBlurSettings } from "../../core/types";
import { buildMotionBlurUniforms } from "../compositing/motion-blur-uniforms";
import { requirePlan } from "./canonical";
import { frameTimeFromNumber, frameTimeToNumber } from "./time";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function buildMotionReconstructionPlan(
  header: FrameHeaderSlice,
  input: {
    requested: boolean;
    resourcesAvailable: boolean;
    settings: MotionBlurSettings;
    shutter: Pick<MotionBlurInterval, "openTime" | "duration">;
    compositionWidth: number;
  },
): FramePlanSliceData {
  const { openTime, duration } = input.shutter;
  const bytes = new Uint8Array(
    buildMotionBlurUniforms(header.render_target.width, header.render_target.height, {
      ...input.settings,
      framePosition:
        duration > Number.EPSILON ? (frameTimeToNumber(header.time) - openTime) / duration : 0.5,
      maximumRadius: Math.max(
        1,
        Math.min(256, 256 * (header.render_target.width / Math.max(input.compositionWidth, 1))),
      ),
    }),
  );
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "motion_reconstruction_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [],
      blobs: [{ byte_offset: 0, byte_length: 32, element_type: "u8", element_count: 32 }],
      slices: [
        {
          kind: "motion_reconstruction",
          blob_index: 0,
          status: input.requested && input.resourcesAvailable ? "ready" : "skipped",
          inputs: ["scene", "motionVector", "objectId"],
          shutter_open: frameTimeFromNumber(openTime),
          shutter_duration: frameTimeFromNumber(duration),
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}
export function readMotionReconstructionPlan(input: FramePlanSliceData) {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "motion_reconstruction_slice_v1" && input.blobs.length === 1,
    "invalid_header",
    "Expected motion reconstruction plan",
  );
  const slice = metadata.slices[0];
  requirePlan(
    slice.kind === "motion_reconstruction",
    "invalid_header",
    "Missing motion reconstruction slice",
  );
  validatePlanBlob(input.blobs[0], metadata, 0);
  return {
    header: structuredClone(metadata.header),
    slice: structuredClone(slice),
    uniforms: new Uint8Array(input.blobs[0]),
  };
}
