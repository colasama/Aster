import { hash, integer, object, requirePlan } from "./canonical";
import {
  type PrecompositionEffectRecord,
  type PrecompositionSceneRecord,
  validateBundlePrograms,
} from "./precomposition-bundle-layout";
import type { BlobDescriptor } from "./types";

export interface FrameBundleSlice {
  kind: "frame_bundle";
  blob_index: number;
  scene: string;
  root: string;
  post: string;
  motion: string;
  output: string;
  auxiliary: string | null;
  effect: string | null;
  precompositions: string | null;
  shadow_map_size: number;
  effects: PrecompositionEffectRecord[];
  generators: PrecompositionSceneRecord["generators"];
  media_pixels: { frame: string; pixels: string }[];
  temporal: string[];
}
export const FRAME_BUNDLE_FIELDS = [
  "kind",
  "blob_index",
  "scene",
  "root",
  "post",
  "motion",
  "output",
  "auxiliary",
  "effect",
  "precompositions",
  "shadow_map_size",
  "effects",
  "generators",
  "media_pixels",
  "temporal",
];
export function frameBundlePlanResources(bundle: FrameBundleSlice): string[] {
  return [
    ...new Set([
      bundle.scene,
      bundle.root,
      bundle.post,
      bundle.motion,
      bundle.output,
      ...[bundle.auxiliary, bundle.effect, bundle.precompositions].filter(
        (v): v is string => v !== null,
      ),
      ...bundle.effects.flatMap((e) =>
        e.status === "ready" ? [e.execution, e.plan] : [e.execution],
      ),
      ...bundle.generators.map((g) => g.plan),
      ...bundle.temporal,
    ]),
  ].sort();
}
export function validateFrameBundle(
  value: unknown,
  blob: BlobDescriptor,
  resources: readonly string[],
): void {
  const record = object(value, FRAME_BUNDLE_FIELDS);
  requirePlan(record.kind === "frame_bundle", "unknown_variant", "Unknown frame bundle");
  for (const key of [
    "scene",
    "root",
    "post",
    "motion",
    "output",
    "auxiliary",
    "effect",
    "precompositions",
  ]) {
    const value = record[key];
    if (["auxiliary", "effect", "precompositions"].includes(key) && value === null) continue;
    hash(value);
    requirePlan(resources.includes(value), "missing_resource", "Undeclared frame stage");
  }
  integer(record.shadow_map_size, 1, 16384);
  requirePlan(
    Array.isArray(record.temporal) && record.temporal.length <= 64,
    "invalid_temporal_text",
    "Invalid temporal pass count",
  );
  const temporal = new Set<string>();
  for (const value of record.temporal) {
    hash(value);
    requirePlan(!temporal.has(value), "invalid_temporal_text", "Duplicate temporal pass");
    requirePlan(resources.includes(value), "missing_resource", "Undeclared temporal pass");
    temporal.add(value);
  }
  requirePlan(
    Array.isArray(record.media_pixels) && record.media_pixels.length <= 65536,
    "invalid_resource",
    "Invalid frame media pixel count",
  );
  const frames = new Set<string>();
  for (const entry of record.media_pixels) {
    const pixel = object(entry, ["frame", "pixels"]);
    hash(pixel.frame);
    hash(pixel.pixels);
    requirePlan(!frames.has(pixel.frame), "invalid_resource", "Duplicate frame media pixels");
    frames.add(pixel.frame);
    requirePlan(
      resources.includes(pixel.frame) && resources.includes(pixel.pixels),
      "missing_resource",
      "Undeclared frame media pixels",
    );
  }
  validateBundlePrograms(record.effects, record.generators, resources);
  requirePlan(
    (record.generators as FrameBundleSlice["generators"]).every(
      (g) => g.execution.status === "ready",
    ),
    "invalid_generator",
    "Root generator must have an observed execution",
  );
  requirePlan(
    blob.element_type === "u32_le" && blob.element_count === 6 && blob.byte_length === 24,
    "invalid_header",
    "Invalid frame bundle counts",
  );
}
export function validateFrameBundleBlob(bytes: Uint8Array, bundle: FrameBundleSlice): void {
  requirePlan(bytes.length === 24, "invalid_header", "Invalid frame bundle payload");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  [
    bundle.shadow_map_size,
    bundle.effects.length,
    bundle.generators.length,
    Number(bundle.precompositions !== null),
    bundle.media_pixels.length,
    bundle.temporal.length,
  ].forEach((n, i) => {
    requirePlan(view.getUint32(i * 4, true) === n, "invalid_header", "Frame bundle count mismatch");
  });
}
