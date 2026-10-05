import {
  type BufferVisualization,
  isDepthEffectVisualization,
  isSurfaceEffectVisualization,
  postRenderRoute,
} from "../gpu/render-buffers";
import { requirePlan } from "./canonical";
import type { FinalOutputRoute } from "./final-output-layout";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

/** Resolve display routing once from observed frame availability before output encoding. */
export function buildFinalOutputPlan(
  header: FrameHeaderSlice,
  input: {
    visualization: BufferVisualization;
    auxiliaryValid: boolean;
    beautyDepthOfField: boolean;
    motionBlurValid: boolean;
    motionBlurBindingAvailable: boolean;
  },
): FramePlanSliceData {
  const mode = input.visualization;
  const beauty: FinalOutputRoute = {
    kind: "beauty",
    source: input.motionBlurValid && input.motionBlurBindingAvailable ? "motion_blur" : "scene",
  };
  let route: FinalOutputRoute;
  if (input.beautyDepthOfField && input.auxiliaryValid)
    route = { kind: "depth", mode: "depthOfField" };
  else if (postRenderRoute(mode, input.auxiliaryValid) === "beauty") route = beauty;
  else if (isDepthEffectVisualization(mode)) route = { kind: "depth", mode };
  else if (isSurfaceEffectVisualization(mode)) route = { kind: "surface", mode };
  else if (mode === "beauty") route = beauty;
  else route = { kind: "visualizer", mode };
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "final_output_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [],
      blobs: [{ byte_offset: 0, byte_length: 16, element_type: "f32_le", element_count: 4 }],
      slices: [{ kind: "final_output", blob_index: 0, route }],
    },
    defaultFramePlanLimits(),
  );
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setFloat32(12, 1, true);
  return { metadata, blobs: [bytes] };
}
export function readFinalOutputPlan(input: FramePlanSliceData) {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "final_output_slice_v1" && input.blobs.length === 1,
    "invalid_header",
    "Expected final output plan",
  );
  const slice = metadata.slices[0];
  requirePlan(slice.kind === "final_output", "invalid_header", "Missing final output route");
  validatePlanBlob(input.blobs[0], metadata, 0);
  const bytes = input.blobs[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    header: structuredClone(metadata.header),
    route: structuredClone(slice.route),
    clear: {
      r: view.getFloat32(0, true),
      g: view.getFloat32(4, true),
      b: view.getFloat32(8, true),
      a: view.getFloat32(12, true),
    },
  };
}
