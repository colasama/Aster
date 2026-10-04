import { object, requirePlan } from "./canonical";
import type { BlobDescriptor } from "./types";

/** Camera wire order: four pose vec3s, four projection scalars, then these optics scalars. */
export const CAMERA_OPTICS_SCALARS = [
  "zoom",
  "filmSize",
  "focalLength",
  "orthographicSize",
  "focusDistance",
  "aperture",
  "fStop",
  "blurLevel",
  "focusAreaWidth",
  "nearBlurLevel",
  "farBlurLevel",
  "irisShapeCode",
  "irisBlades",
  "irisRotation",
  "irisRoundness",
  "irisAspectRatio",
  "irisDiffractionFringe",
  "highlightGain",
  "highlightThreshold",
  "highlightSaturation",
  "renderQuality",
] as const;
export const CAMERA_WIRE_BYTES = 296;
export const CAMERA_SLICE_FIELDS = [
  "kind",
  "blob_index",
  "pose_mode",
  "projection_kind",
  "optics_projection",
  "depth_of_field",
  "lock_focus_to_zoom",
  "iris_shape",
];

export function validateCameraParameters(value: unknown, blob: BlobDescriptor): void {
  const slice = object(value, CAMERA_SLICE_FIELDS);
  requirePlan(
    ["oneNode", "twoNode"].includes(String(slice.pose_mode)) &&
      ["perspective", "orthographic"].includes(String(slice.projection_kind)) &&
      ["perspective", "orthographic"].includes(String(slice.optics_projection)) &&
      [
        "fastRectangle",
        "square",
        "triangle",
        "pentagon",
        "hexagon",
        "heptagon",
        "octagon",
        "nonagon",
        "decagon",
        "circle",
      ].includes(String(slice.iris_shape)),
    "invalid_camera_parameters",
    "Unsupported evaluated camera variant",
  );
  requirePlan(
    typeof slice.depth_of_field === "boolean" && typeof slice.lock_focus_to_zoom === "boolean",
    "invalid_camera_parameters",
    "Invalid evaluated camera flags",
  );
  requirePlan(
    blob.element_type === "u8" && blob.byte_length === CAMERA_WIRE_BYTES,
    "invalid_camera_parameters",
    "Camera parameters require 37 little-endian f64 scalars",
  );
}
