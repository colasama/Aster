import type { AntiAliasingMode } from "../../core/rendering/anti-aliasing";
import {
  type RenderSnapshotIdentity,
  validateRenderSnapshotIdentity,
} from "../../core/rendering/render-snapshot";
import { buildPostProcessUniforms } from "../effects/post-process";
import { compositionIdentityFromString } from "./composition-identity";
import { frameRateFromNumbers } from "./frame-rate";
import { frameTimeFromNumber } from "./time";
import {
  defaultFramePlanLimits,
  type Extent2d,
  type FramePlanSliceData,
  type RationalFrameRate,
} from "./types";
import { validateMetadata } from "./validation";

export interface RootPostUniformPlanInput {
  snapshot: RenderSnapshotIdentity;
  compositionId: string;
  time: number;
  frameRate: RationalFrameRate;
  target: Extent2d;
  renderTarget: Extent2d;
  antiAliasing: AntiAliasingMode;
}

/** Produces owned, GPU-free header and uniform data for the root post-process upload. */
export function buildRootPostUniformPlan(input: RootPostUniformPlanInput): FramePlanSliceData {
  validateRenderSnapshotIdentity(input.snapshot);
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "post_uniforms_slice_v1",
      renderer_plan_complete: false,
      header: {
        snapshot_scope: input.snapshot.snapshotScope,
        project_revision: input.snapshot.projectRevision,
        composition_id: compositionIdentityFromString(input.compositionId),
        time: frameTimeFromNumber(input.time),
        frame_rate: frameRateFromNumbers(input.frameRate),
        target: { width: input.target.width, height: input.target.height },
        render_target: { width: input.renderTarget.width, height: input.renderTarget.height },
        aa: input.antiAliasing,
        color_pipeline: "linear-hdr-to-srgb-display",
      },
      blobs: [{ byte_offset: 0, byte_length: 96, element_type: "f32_le", element_count: 24 }],
      slices: [{ kind: "post_process_uniforms", blob_index: 0 }],
      resources: [],
    },
    defaultFramePlanLimits(),
  );
  const bytes = postUniformBytes(input.renderTarget.width, input.renderTarget.height, input.time);
  return { metadata, blobs: [bytes] };
}

/** Writes the existing production producer's values in the wire's explicit byte order. */
export function postUniformBytes(width: number, height: number, time: number): Uint8Array {
  const uniforms = buildPostProcessUniforms(width, height, time);
  const bytes = new Uint8Array(uniforms.byteLength);
  const view = new DataView(bytes.buffer);
  uniforms.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}
