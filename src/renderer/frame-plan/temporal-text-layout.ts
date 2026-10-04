import { integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import { frameTimeToNumber } from "./time";
import type { BlobDescriptor, FrameHeaderSlice, TemporalTextSamplesSlice } from "./types";

export const TEMPORAL_TEXT_FIELDS = [
  "kind",
  "blob_index",
  "resource_instance_id",
  "sample_count",
  "unique_sample_count",
  "exposure_only",
  "sample_format",
  "accumulation_format",
  "resolve_format",
];

/** Frame time and transparent weight, then (local time, weight, time bucket) f64 triples. */
export function temporalTextByteLength(samples: number): number {
  return 16 + integer(samples, 0, 4096) * 24;
}

export function validateTemporalText(value: unknown, blob: BlobDescriptor): void {
  const slice = object(value, TEMPORAL_TEXT_FIELDS);
  compositionIdentityToString(slice.resource_instance_id);
  const count = integer(slice.sample_count, 1, 4096);
  integer(slice.unique_sample_count, 0, count);
  requirePlan(
    typeof slice.exposure_only === "boolean" &&
      slice.sample_format === "rgba8unorm-srgb" &&
      slice.accumulation_format === "rgba16float" &&
      slice.resolve_format === "rgba8unorm-srgb" &&
      blob.element_type === "u8" &&
      blob.byte_length === temporalTextByteLength(slice.unique_sample_count as number),
    "invalid_temporal_text",
    "Invalid temporal text layout or formats",
  );
}

export function validateTemporalTextBlob(
  bytes: Uint8Array,
  slice: TemporalTextSamplesSlice,
  header: FrameHeaderSlice,
): void {
  requirePlan(
    bytes.byteLength === temporalTextByteLength(slice.unique_sample_count),
    "invalid_temporal_text",
    "Invalid temporal text payload length",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const transparent = view.getFloat64(8, true);
  requirePlan(
    Object.is(view.getFloat64(0, true), frameTimeToNumber(header.time)) &&
      Number.isFinite(transparent) &&
      transparent >= 0 &&
      transparent <= 1,
    "invalid_temporal_text",
    "Invalid temporal frame time or transparent weight",
  );
  let total = transparent;
  for (let offset = 16; offset < bytes.length; offset += 24) {
    const time = view.getFloat64(offset, true);
    const weight = view.getFloat64(offset + 8, true);
    const bucket = view.getFloat64(offset + 16, true);
    requirePlan(
      Number.isFinite(time) &&
        Number.isFinite(weight) &&
        weight >= 0 &&
        weight <= 1 &&
        Number.isSafeInteger(bucket),
      "invalid_temporal_text",
      "Invalid temporal sample",
    );
    total += weight;
  }
  requirePlan(
    Math.abs(total - 1) <= Number.EPSILON * (slice.unique_sample_count + 1) * 4,
    "invalid_temporal_text",
    "Temporal weights do not cover the shutter exposure",
  );
}
