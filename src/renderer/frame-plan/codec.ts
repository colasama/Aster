import { align16, canonicalJson, requirePlan } from "./canonical";
import {
  defaultFramePlanLimits,
  FramePlanError,
  type FramePlanLimits,
  type FramePlanSliceData,
  type FramePlanSliceV1,
} from "./types";
import { validateLimits, validateMetadata, validatePlanBlob } from "./validation";

export function encodeFramePlan(
  input: FramePlanSliceV1,
  blobs: readonly Uint8Array[],
  limits: FramePlanLimits = defaultFramePlanLimits(),
): Uint8Array {
  const metadata = validateMetadata(input, limits);
  requirePlan(blobs.length === metadata.blobs.length, "blob_count_mismatch", "Missing blob bytes");
  const json = new TextEncoder().encode(canonicalJson(metadata));
  requirePlan(
    json.length <= limits.max_metadata_bytes,
    "limit_exceeded",
    "Metadata exceeds budget",
  );
  const start = align16(32 + json.length);
  const last = metadata.blobs[metadata.blobs.length - 1];
  const length = start + align16(last.byte_offset + last.byte_length);
  requirePlan(length <= limits.max_container_bytes, "limit_exceeded", "Container exceeds budget");
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  output.set([0x46, 0x50, 0x4c, 0x4e]);
  view.setUint16(4, 1, true);
  view.setUint16(6, 32, true);
  view.setUint32(8, json.length, true);
  view.setUint32(12, blobs.length, true);
  view.setUint32(16, start, true);
  view.setUint32(20, length, true);
  output.set(json, 32);
  for (const [index, blob] of blobs.entries()) {
    validatePlanBlob(blob, metadata, index);
    output.set(blob, start + metadata.blobs[index].byte_offset);
  }
  return output;
}

export function decodeFramePlan(
  input: Uint8Array,
  limits: FramePlanLimits = defaultFramePlanLimits(),
): FramePlanSliceData {
  validateLimits(limits);
  requirePlan(input.byteLength >= 32, "truncated_header", "FPLN header is incomplete");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  requirePlan(view.getUint32(0, true) === 0x4e4c5046, "invalid_magic", "Not an FPLN container");
  requirePlan(
    view.getUint16(4, true) === 1,
    "unsupported_version",
    "Unsupported container version",
  );
  requirePlan(
    view.getUint16(6, true) === 32 &&
      view.getUint32(24, true) === 0 &&
      view.getUint32(28, true) === 0,
    "invalid_header",
    "Invalid header size, flags or reserved bits",
  );
  const jsonLength = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const start = view.getUint32(16, true);
  const length = view.getUint32(20, true);
  requirePlan(
    length === input.byteLength,
    "container_length_mismatch",
    "Container length mismatch",
  );
  requirePlan(
    length <= limits.max_container_bytes &&
      jsonLength <= limits.max_metadata_bytes &&
      count <= limits.max_blobs,
    "limit_exceeded",
    "FPLN exceeds caller limits",
  );
  requirePlan(
    start === align16(32 + jsonLength) && start <= length,
    "invalid_header",
    "Invalid metadata range",
  );
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      input.subarray(32, 32 + jsonLength),
    );
  } catch {
    throw new FramePlanError("invalid_utf8", "Metadata is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new FramePlanError("invalid_json", "Metadata is not valid JSON");
  }
  const metadata = validateMetadata(parsed, limits);
  requirePlan(
    canonicalJson(metadata) === json,
    "non_canonical_metadata",
    "Metadata is not canonical JSON",
  );
  requirePlan(count === metadata.blobs.length, "blob_count_mismatch", "Header blob count differs");
  let previousEnd = 32 + jsonLength;
  const blobs: Uint8Array[] = [];
  for (const descriptor of metadata.blobs) {
    const offset = start + descriptor.byte_offset;
    const end = offset + descriptor.byte_length;
    requirePlan(end <= length, "blob_range_out_of_bounds", "Blob range exceeds container");
    zeroPadding(input, previousEnd, offset);
    const blob = input.subarray(offset, end);
    validatePlanBlob(blob, metadata, blobs.length);
    blobs.push(blob);
    previousEnd = end;
  }
  requirePlan(
    align16(previousEnd) === length,
    "container_length_mismatch",
    "Unexpected trailing data",
  );
  zeroPadding(input, previousEnd, length);
  return { metadata, blobs };
}

function zeroPadding(input: Uint8Array, start: number, end: number): void {
  for (let index = start; index < end; index += 1)
    requirePlan(input[index] === 0, "invalid_padding", "FPLN padding must be zero");
}
