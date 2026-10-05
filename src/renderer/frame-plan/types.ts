import type { BlendMode } from "../../core/types";
import type { AuxiliarySlice } from "./auxiliary-layout";
import type { FinalOutputSlice } from "./final-output-layout";
import type { FrameBundleSlice } from "./frame-bundle-layout";
import type { SceneGeneratorSlice } from "./generator-types";
import type { MediaFrameDescriptor, MediaSourceDescriptor } from "./media-descriptors";
import type { MotionReconstructionSlice } from "./motion-reconstruction-layout";
import type { PostEffectSlice } from "./post-effect-layout";
import type { PrecompositionBundleSlice } from "./precomposition-bundle-layout";
import type { PrecompositionGraphSlice } from "./precomposition-graph-layout";
import type { RasterPixelsDescriptor } from "./raster-pixels";
import type { RootSceneCommandsSlice } from "./root-scene-types";
import type { TexturePixelsDescriptor } from "./texture-pixels";

export interface FramePlanLimits {
  max_container_bytes: number;
  max_metadata_bytes: number;
  max_blobs: number;
  max_slices: number;
  max_resource_references: number;
  max_dimension: number;
  max_pixels: number;
}

export function defaultFramePlanLimits(): FramePlanLimits {
  return {
    max_container_bytes: 67_108_864,
    max_metadata_bytes: 1_048_576,
    max_blobs: 4096,
    max_slices: 4096,
    max_resource_references: 65_536,
    max_dimension: 16_384,
    max_pixels: 268_435_456,
  };
}

export type BlobElementType = "u8" | "u32_le" | "f32_le";

export interface BufferResourceDescriptor {
  element_type: BlobElementType;
  element_count: number;
  byte_length: number;
}

export interface BlobDescriptor extends BufferResourceDescriptor {
  byte_offset: number;
}

export interface RationalTime {
  kind: "rational";
  value: number;
  scale: number;
}

export interface BinaryRationalTime {
  kind: "binary_rational";
  negative: boolean;
  significand: number;
  exponent: number;
}

export type FrameTime = RationalTime | BinaryRationalTime;

export interface Extent2d {
  width: number;
  height: number;
}

export type CompositionIdentity = string | { utf16_units: number[] };

export interface RationalFrameRate {
  numerator: number;
  denominator: number;
}

export type FrameRate =
  | ({ kind: "rational" } & RationalFrameRate)
  | {
      kind: "binary_ratio";
      numerator: BinaryRationalTime;
      denominator: BinaryRationalTime;
    };

export interface FrameHeaderSlice {
  snapshot_scope: string;
  project_revision: number;
  composition_id: CompositionIdentity;
  time: FrameTime;
  frame_rate: FrameRate;
  target: Extent2d;
  render_target: Extent2d;
  aa: "off" | "fxaa" | "ssaa2x" | "ssaa4x";
  color_pipeline: "linear-hdr-to-srgb-display";
}

/** This closed transport slice cannot represent a complete executable frame. */
export interface FramePlanSliceV1 {
  kind: "frame_plan_slice";
  plan_version: 1;
  contract_level:
    | "post_uniforms_slice_v1"
    | "scene_buffers_slice_v1"
    | "camera_parameters_slice_v1"
    | "temporal_text_samples_slice_v1"
    | "temporal_text_passes_slice_v1"
    | "material_bindings_slice_v1"
    | "layer_effects_slice_v1"
    | "effect_execution_slice_v1"
    | "root_scene_commands_slice_v1"
    | "scene_generator_slice_v1"
    | "precomposition_graph_slice_v1"
    | "precomposition_bundle_slice_v1"
    | "final_output_slice_v1"
    | "motion_reconstruction_slice_v1"
    | "post_effect_slice_v1"
    | "auxiliary_slice_v1"
    | "frame_bundle_slice_v1";
  renderer_plan_complete: false;
  header: FrameHeaderSlice;
  blobs: BlobDescriptor[];
  slices: PlanSlice[];
  resources: string[];
}

export interface SceneDrawRecord {
  instance_id: CompositionIdentity;
  resource_instance_id: CompositionIdentity;
  selection_id: CompositionIdentity;
  first_vertex: number;
  vertex_count: number;
  casts_shadow: boolean;
}

export interface SceneBuffersSlice {
  kind: "scene_buffers";
  blob_index: number;
  vertex_count: number;
  motion_vectors: boolean;
  shadows_enabled: boolean;
  draws: SceneDrawRecord[];
  media_bindings: SceneMediaBinding[];
}

export interface SceneMediaBinding {
  draw_index: number;
  binding: { kind: "pending" } | { kind: "frame"; hash: string };
}

export type PlanSlice =
  | FrameBundleSlice
  | FinalOutputSlice
  | AuxiliarySlice
  | MotionReconstructionSlice
  | PostEffectSlice
  | PrecompositionBundleSlice
  | PrecompositionGraphSlice
  | SceneGeneratorSlice
  | RootSceneCommandsSlice
  | { kind: "post_process_uniforms"; blob_index: number }
  | SceneBuffersSlice
  | CameraParametersSlice
  | MaterialBindingSlice
  | EffectExecutionSlice
  | LayerEffectSlice
  | TemporalTextSamplesSlice
  | TemporalTextPassesSlice;

export type MaterialTextureReference = { kind: "fallback" } | { kind: "texture"; hash: string };

export interface MaterialBindingSlice {
  kind: "material_binding";
  blob_index: number;
  instance_id: CompositionIdentity;
  normal: MaterialTextureReference;
  environment: MaterialTextureReference;
}

export interface TemporalTextPassesSlice {
  kind: "temporal_text_passes";
  blob_index: number;
  width: number;
  height: number;
  output: string;
  samples: string[];
  sample_format: "rgba8unorm-srgb";
  accumulation_format: "rgba16float";
  output_format: "rgba8unorm-srgb";
}

export interface TemporalTextSamplesSlice {
  kind: "temporal_text_samples";
  blob_index: number;
  resource_instance_id: CompositionIdentity;
  sample_count: number;
  unique_sample_count: number;
  exposure_only: boolean;
  sample_format: "rgba8unorm-srgb";
  accumulation_format: "rgba16float";
  resolve_format: "rgba8unorm-srgb";
}

export interface CameraParametersSlice {
  kind: "camera_parameters";
  blob_index: number;
  pose_mode: "oneNode" | "twoNode";
  projection_kind: "perspective" | "orthographic";
  optics_projection: "perspective" | "orthographic";
  depth_of_field: boolean;
  lock_focus_to_zoom: boolean;
  iris_shape:
    | "fastRectangle"
    | "square"
    | "triangle"
    | "pentagon"
    | "hexagon"
    | "heptagon"
    | "octagon"
    | "nonagon"
    | "decagon"
    | "circle";
}

export interface FramePlanSliceData {
  metadata: FramePlanSliceV1;
  /** Decoders may return borrowed views; owners must not mutate them during execution. */
  blobs: readonly Uint8Array[];
}

export type ResourceContent =
  | { kind: "encoded_texture"; descriptor: EncodedTextureDescriptor }
  | { kind: "buffer"; descriptor: BufferResourceDescriptor }
  | { kind: "media_source"; descriptor: MediaSourceDescriptor }
  | { kind: "raster_pixels"; descriptor: RasterPixelsDescriptor }
  | { kind: "texture_pixels"; descriptor: TexturePixelsDescriptor }
  | { kind: "media_frame"; descriptor: MediaFrameDescriptor };

export type PutResource = ResourceContent & { type: "put_resource"; hash: string };

export type ResourceMessage = PutResource | { type: "evict_resource"; hash: string };

export class FramePlanError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FramePlanError";
  }
}

import type { EncodedTextureDescriptor } from "./encoded-texture";

export interface LayerEffectSlice {
  kind: "layer_effect";
  blob_index: number;
  instance_id: CompositionIdentity;
  blend_mode: BlendMode;
  route: "layer" | "adjustment";
  operation_count: number;
  uses_blur: boolean;
  uses_glow: boolean;
  lut_hash: string;
}

export interface EffectExecutionSlice {
  kind: "effect_execution";
  blob_index: number;
  instance_id: CompositionIdentity;
  layer_id: CompositionIdentity;
  route: "direct" | "layer" | "adjustment" | "skip";
  blend_mode: BlendMode;
  composite: "none" | "fixed" | "backdrop" | "replace";
}
