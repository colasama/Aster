import { align16, gcd, hash, integer, object, requirePlan, validUnicode } from "./canonical";
import type { BufferResourceDescriptor, FramePlanLimits, FramePlanSliceV1 } from "./types";

export function validateLimits(limits: FramePlanLimits): void {
  integer(limits.max_container_bytes, 32, 0xffff_ffff);
  integer(limits.max_metadata_bytes, 1, limits.max_container_bytes);
  integer(limits.max_blobs, 1, 0xffff_ffff);
  integer(limits.max_slices, 1, 0xffff_ffff);
  integer(limits.max_resource_references, 0, 0xffff_ffff);
  integer(limits.max_dimension, 1, 16_777_216);
  integer(limits.max_pixels, 1);
}

export function validateBufferDescriptor(value: unknown): BufferResourceDescriptor {
  const descriptor = object(value, ["element_type", "element_count", "byte_length"]);
  requirePlan(
    ["u8", "u32_le", "f32_le"].includes(String(descriptor.element_type)),
    "blob_type_mismatch",
    "Unsupported buffer element type",
  );
  const count = integer(descriptor.element_count, 1, 0xffff_ffff);
  const length = integer(descriptor.byte_length, 1, 0xffff_ffff);
  requirePlan(
    count * (descriptor.element_type === "u8" ? 1 : 4) === length,
    "element_count_mismatch",
    "Buffer length does not match its element count",
  );
  return descriptor as unknown as BufferResourceDescriptor;
}

function extent(value: unknown, limits: FramePlanLimits): void {
  const size = object(value, ["width", "height"]);
  const width = integer(size.width, 1, Math.min(limits.max_dimension, 0xffff_ffff));
  const height = integer(size.height, 1, Math.min(limits.max_dimension, 0xffff_ffff));
  requirePlan(
    BigInt(width) * BigInt(height) <= BigInt(limits.max_pixels),
    "limit_exceeded",
    "Target exceeds the pixel limit",
  );
}

export function validateMetadata(value: unknown, limits: FramePlanLimits): FramePlanSliceV1 {
  validateLimits(limits);
  const metadata = object(value, [
    "kind",
    "plan_version",
    "contract_level",
    "renderer_plan_complete",
    "header",
    "blobs",
    "slices",
    "resources",
  ]);
  requirePlan(
    metadata.kind === "frame_plan_slice" &&
      metadata.plan_version === 1 &&
      metadata.contract_level === "post_uniforms_slice_v1" &&
      metadata.renderer_plan_complete === false,
    "unknown_variant",
    "Only the incomplete post-uniform transport slice is supported",
  );
  const header = object(metadata.header, [
    "project_revision",
    "composition_id",
    "time",
    "frame_rate",
    "target",
    "render_target",
    "aa",
    "color_pipeline",
  ]);
  integer(header.project_revision);
  requirePlan(
    typeof header.composition_id === "string" &&
      validUnicode(header.composition_id) &&
      !header.composition_id.includes("\0") &&
      header.composition_id.length > 0 &&
      new TextEncoder().encode(header.composition_id).length <= 256,
    "invalid_json",
    "Composition identity must contain 1..256 valid UTF-8 bytes without NUL",
  );
  const time = object(header.time, ["value", "scale"]);
  integer(time.value, -Number.MAX_SAFE_INTEGER);
  integer(time.scale, 1, 0xffff_ffff);
  requirePlan(
    gcd(BigInt(time.value as number), BigInt(time.scale as number)) === 1n,
    "invalid_rational",
    "Time must be a reduced rational",
  );
  const rate = object(header.frame_rate, ["numerator", "denominator"]);
  integer(rate.numerator, 1, 0xffff_ffff);
  integer(rate.denominator, 1, 0xffff_ffff);
  requirePlan(
    gcd(BigInt(rate.numerator as number), BigInt(rate.denominator as number)) === 1n,
    "invalid_rational",
    "Frame rate must be reduced",
  );
  extent(header.target, limits);
  extent(header.render_target, limits);
  requirePlan(
    ["off", "fxaa", "ssaa2x", "ssaa4x"].includes(String(header.aa)) &&
      header.color_pipeline === "linear-hdr-to-srgb-display",
    "unknown_variant",
    "Unsupported AA or color pipeline",
  );
  requirePlan(
    Array.isArray(metadata.blobs) && metadata.blobs.length <= limits.max_blobs,
    "limit_exceeded",
    "Invalid or excessive blob count",
  );
  let expectedOffset = 0;
  for (const value of metadata.blobs) {
    const blob = object(value, ["byte_offset", "byte_length", "element_type", "element_count"]);
    const descriptor = validateBufferDescriptor({
      byte_length: blob.byte_length,
      element_type: blob.element_type,
      element_count: blob.element_count,
    });
    requirePlan(
      integer(blob.byte_offset, 0, 0xffff_ffff) === expectedOffset,
      "blob_range_out_of_bounds",
      "Blob ranges must be contiguous in canonical aligned order",
    );
    expectedOffset = align16(expectedOffset + descriptor.byte_length);
    requirePlan(
      expectedOffset <= limits.max_container_bytes,
      "limit_exceeded",
      "Blobs exceed budget",
    );
  }
  requirePlan(
    Array.isArray(metadata.slices) &&
      metadata.slices.length > 0 &&
      metadata.slices.length <= limits.max_slices &&
      metadata.slices.length === metadata.blobs.length,
    "blob_count_mismatch",
    "Every blob must belong to one concrete slice",
  );
  const indices = new Set<number>();
  for (const value of metadata.slices) {
    const slice = object(value, ["kind", "blob_index"]);
    requirePlan(slice.kind === "post_process_uniforms", "unknown_variant", "Unknown plan slice");
    const index = integer(slice.blob_index, 0, metadata.blobs.length - 1);
    requirePlan(!indices.has(index), "blob_count_mismatch", "A blob is referenced more than once");
    indices.add(index);
    const blob = metadata.blobs[index];
    requirePlan(
      blob.element_type === "f32_le" && blob.element_count === 24 && blob.byte_length === 96,
      "invalid_post_uniforms",
      "Post uniforms require exactly 24 f32 values",
    );
  }
  requirePlan(
    Array.isArray(metadata.resources) &&
      metadata.resources.length <= limits.max_resource_references,
    "limit_exceeded",
    "Invalid resource reference count",
  );
  let previous = "";
  for (const value of metadata.resources) {
    hash(value);
    requirePlan(previous < value, "hash_mismatch", "Resource hashes must be unique and sorted");
    previous = value;
  }
  return metadata as unknown as FramePlanSliceV1;
}

export function validatePostUniforms(bytes: Uint8Array, metadata: FramePlanSliceV1): void {
  requirePlan(bytes.byteLength === 96, "invalid_post_uniforms", "Invalid post-uniform byte length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < 24; index += 1)
    requirePlan(
      Number.isFinite(view.getFloat32(index * 4, true)),
      "invalid_post_uniforms",
      "Nonfinite uniform",
    );
  const operationCount = view.getFloat32(64, true);
  requirePlan(
    view.getFloat32(0, true) === Math.fround(metadata.header.render_target.width) &&
      view.getFloat32(4, true) === Math.fround(metadata.header.render_target.height) &&
      Number.isInteger(operationCount) &&
      operationCount >= 0 &&
      operationCount <= 64 &&
      [0, 1].includes(view.getFloat32(68, true)) &&
      [0, 1].includes(view.getFloat32(76, true)) &&
      view.getUint32(92, true) === 0,
    "invalid_post_uniforms",
    "Post-uniform dimensions or control lanes violate the upload ABI",
  );
}
