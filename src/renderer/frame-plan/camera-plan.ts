import type { EvaluatedCamera } from "../../core/scene/camera-settings";
import { CAMERA_OPTICS_SCALARS, CAMERA_WIRE_BYTES } from "./camera-layout";
import { requirePlan } from "./canonical";
import { buildFrameHeader, type RootPostUniformPlanInput } from "./root-post-plan";
import { defaultFramePlanLimits, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

/** Owns the evaluated camera only, without authoring settings, animations or Layer references. */
export function buildCameraPlan(
  header: RootPostUniformPlanInput,
  camera: EvaluatedCamera,
): FramePlanSliceData {
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "camera_parameters_slice_v1",
      renderer_plan_complete: false,
      header: buildFrameHeader(header),
      resources: [],
      blobs: [
        {
          byte_offset: 0,
          byte_length: CAMERA_WIRE_BYTES,
          element_type: "u8",
          element_count: CAMERA_WIRE_BYTES,
        },
      ],
      slices: [
        {
          kind: "camera_parameters",
          blob_index: 0,
          pose_mode: camera.pose.mode,
          projection_kind: camera.projection.kind,
          optics_projection: camera.optics.projection,
          depth_of_field: camera.optics.depthOfField,
          lock_focus_to_zoom: camera.optics.lockFocusToZoom,
          iris_shape: camera.optics.irisShape,
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  const scalars = [
    ...camera.pose.position,
    ...camera.pose.pointOfInterest,
    ...camera.pose.orientation,
    ...camera.pose.rotation,
    camera.projection.zoom,
    camera.projection.orthographicSize,
    camera.projection.near,
    camera.projection.far,
    ...CAMERA_OPTICS_SCALARS.map((key) => camera.optics[key]),
  ];
  requirePlan(
    scalars.length * 8 === CAMERA_WIRE_BYTES,
    "invalid_camera_parameters",
    "Camera producer ABI mismatch",
  );
  const bytes = new Uint8Array(CAMERA_WIRE_BYTES);
  const view = new DataView(bytes.buffer);
  scalars.forEach((value, index) => {
    view.setFloat64(index * 8, value, true);
  });
  return { metadata, blobs: [bytes] };
}

/** Reconstructs exact evaluation values from supplied bytes, including unaligned borrowed views. */
export function readCameraPlan(plan: FramePlanSliceData): EvaluatedCamera {
  const metadata = validateMetadata(plan.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "camera_parameters_slice_v1" &&
      metadata.slices.length === 1 &&
      metadata.resources.length === 0 &&
      plan.blobs.length === 1,
    "invalid_camera_parameters",
    "Camera execution requires one parameter slice",
  );
  const slice = metadata.slices[0];
  requirePlan(
    slice.kind === "camera_parameters",
    "invalid_camera_parameters",
    "Missing camera parameters",
  );
  const bytes = plan.blobs[slice.blob_index];
  validatePlanBlob(bytes, metadata, slice.blob_index);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scalar = (index: number) => view.getFloat64(index * 8, true);
  const vector = (index: number): [number, number, number] => [
    scalar(index),
    scalar(index + 1),
    scalar(index + 2),
  ];
  const optics = Object.fromEntries(
    CAMERA_OPTICS_SCALARS.map((key, index) => [key, scalar(16 + index)]),
  ) as Pick<EvaluatedCamera["optics"], (typeof CAMERA_OPTICS_SCALARS)[number]>;
  return {
    pose: {
      mode: slice.pose_mode,
      position: vector(0),
      pointOfInterest: vector(3),
      orientation: vector(6),
      rotation: vector(9),
    },
    projection: {
      kind: slice.projection_kind,
      zoom: scalar(12),
      orthographicSize: scalar(13),
      near: scalar(14),
      far: scalar(15),
    },
    optics: {
      ...optics,
      projection: slice.optics_projection,
      depthOfField: slice.depth_of_field,
      lockFocusToZoom: slice.lock_focus_to_zoom,
      irisShape: slice.iris_shape,
    },
  };
}
