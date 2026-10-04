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
  value: number;
  scale: number;
}

export interface RationalFrameRate {
  numerator: number;
  denominator: number;
}

export interface FrameHeaderSlice {
  project_revision: number;
  composition_id: string;
  time: RationalTime;
  frame_rate: RationalFrameRate;
  target: { width: number; height: number };
  render_target: { width: number; height: number };
  aa: "off" | "fxaa" | "ssaa2x" | "ssaa4x";
  color_pipeline: "linear-hdr-to-srgb-display";
}

/** This closed transport slice cannot represent a complete executable frame. */
export interface FramePlanSliceV1 {
  kind: "frame_plan_slice";
  plan_version: 1;
  contract_level: "post_uniforms_slice_v1";
  renderer_plan_complete: false;
  header: FrameHeaderSlice;
  blobs: BlobDescriptor[];
  slices: { kind: "post_process_uniforms"; blob_index: number }[];
  resources: string[];
}

export type ResourceMessage =
  | {
      type: "put_resource";
      hash: string;
      kind: "buffer";
      descriptor: BufferResourceDescriptor;
    }
  | { type: "evict_resource"; hash: string };

export class FramePlanError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FramePlanError";
  }
}
