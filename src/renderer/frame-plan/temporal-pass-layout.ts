import { hash, integer, object, requirePlan } from "./canonical";
import type { BlobDescriptor, TemporalTextPassesSlice } from "./types";

export const TEMPORAL_PASS_FIELDS = [
  "kind",
  "blob_index",
  "width",
  "height",
  "output",
  "samples",
  "sample_format",
  "accumulation_format",
  "output_format",
];

export function validateTemporalPass(
  value: unknown,
  blob: BlobDescriptor,
  resources: unknown,
): void {
  const slice = object(value, TEMPORAL_PASS_FIELDS);
  integer(slice.width, 1, 8192);
  integer(slice.height, 1, 8192);
  hash(slice.output);
  requirePlan(
    Array.isArray(slice.samples) && slice.samples.length <= 4096,
    "invalid_temporal_text",
    "Invalid temporal pass sample count",
  );
  const hashes = [slice.output, ...slice.samples];
  for (const value of hashes) hash(value);
  requirePlan(
    new Set(hashes).size === hashes.length &&
      Array.isArray(resources) &&
      hashes.every((value) => resources.includes(value)),
    "invalid_temporal_text",
    "Missing or duplicate temporal pass resources",
  );
  requirePlan(
    slice.sample_format === "rgba8unorm-srgb" &&
      slice.accumulation_format === "rgba16float" &&
      slice.output_format === "rgba8unorm-srgb" &&
      blob.element_type === "u8" &&
      blob.byte_length === 8 * (slice.samples.length + 1),
    "invalid_temporal_text",
    "Invalid temporal pass layout",
  );
}

/** First lane is transparent exposure; subsequent f64 lanes preserve exact sample weights. */
export function validateTemporalPassBlob(bytes: Uint8Array, slice: TemporalTextPassesSlice): void {
  requirePlan(
    bytes.length === 8 * (slice.samples.length + 1),
    "invalid_temporal_text",
    "Invalid temporal pass payload",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  let samples = 0;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const weight = view.getFloat64(offset, true);
    requirePlan(
      Number.isFinite(weight) && weight >= 0 && weight <= 1,
      "invalid_temporal_text",
      "Invalid temporal pass exposure",
    );
    total += weight;
    if (offset > 0) samples += weight;
  }
  requirePlan(
    Math.abs(total - 1) <= Number.EPSILON * (slice.samples.length + 2) * 4 &&
      samples <= 1 + Number.EPSILON * (slice.samples.length + 1) * 4,
    "invalid_temporal_text",
    "Incomplete temporal pass exposure",
  );
}
