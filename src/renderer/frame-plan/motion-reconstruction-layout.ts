import { object, requirePlan } from "./canonical";
import { frameTimeToNumber, validateFrameTime } from "./time";
import type { BlobDescriptor, FrameHeaderSlice, FrameTime } from "./types";

export interface MotionReconstructionSlice {
  kind: "motion_reconstruction";
  blob_index: number;
  status: "ready" | "skipped";
  inputs: ["scene", "motionVector", "objectId"];
  shutter_open: FrameTime;
  shutter_duration: FrameTime;
}
export const MOTION_RECONSTRUCTION_FIELDS = [
  "kind",
  "blob_index",
  "status",
  "inputs",
  "shutter_open",
  "shutter_duration",
];
export function validateMotionReconstruction(value: unknown, blob: BlobDescriptor): void {
  const slice = object(value, MOTION_RECONSTRUCTION_FIELDS);
  requirePlan(
    slice.kind === "motion_reconstruction" &&
      (slice.status === "ready" || slice.status === "skipped"),
    "invalid_header",
    "Invalid motion reconstruction state",
  );
  requirePlan(
    Array.isArray(slice.inputs) &&
      slice.inputs.length === 3 &&
      slice.inputs.every((input, i) => input === ["scene", "motionVector", "objectId"][i]),
    "invalid_header",
    "Invalid motion reconstruction inputs",
  );
  validateFrameTime(slice.shutter_open);
  requirePlan(
    frameTimeToNumber(validateFrameTime(slice.shutter_duration)) >= 0,
    "invalid_header",
    "Negative motion exposure",
  );
  requirePlan(
    blob.element_type === "u8" && blob.element_count === 32 && blob.byte_length === 32,
    "invalid_header",
    "Invalid motion uniform layout",
  );
}
export function validateMotionReconstructionBlob(
  bytes: Uint8Array,
  header: FrameHeaderSlice,
): void {
  requirePlan(bytes.length === 32, "invalid_header", "Invalid motion uniform payload");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = view.getUint32(8, true),
    adaptive = view.getUint32(12, true);
  const radius = view.getFloat32(16, true),
    position = view.getFloat32(20, true);
  requirePlan(
    view.getFloat32(0, true) === header.render_target.width &&
      view.getFloat32(4, true) === header.render_target.height &&
      samples >= 2 &&
      samples <= 64 &&
      adaptive >= samples &&
      adaptive <= 128 &&
      Number.isFinite(radius) &&
      radius >= 0 &&
      radius <= 256 &&
      Number.isFinite(position) &&
      position >= -4 &&
      position <= 4 &&
      view.getUint32(24, true) === 0 &&
      view.getUint32(28, true) === 0,
    "invalid_header",
    "Invalid motion uniform values",
  );
}
