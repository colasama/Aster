import { hash, integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { BlobDescriptor, CompositionIdentity } from "./types";

export type PrecompositionEffectRecord = {
  instance_id: CompositionIdentity;
  execution: string;
} & (
  | { status: "direct" | "skipped" }
  | { status: "failed"; error_utf16: number[] }
  | { status: "ready"; plan: string; lut: string; label_utf16: number[] }
);
export interface PrecompositionSceneRecord {
  target_id: CompositionIdentity;
  label_utf16: number[];
  scene: string;
  commands: string;
  draw_count: number;
  effects: PrecompositionEffectRecord[];
  generators: { instance_id: CompositionIdentity; plan: string }[];
}
export interface PrecompositionBundleSlice {
  kind: "precomposition_bundle";
  blob_index: number;
  graph: string;
  scenes: PrecompositionSceneRecord[];
}
export const PRECOMPOSITION_BUNDLE_FIELDS = ["kind", "blob_index", "graph", "scenes"];

export function utf16Text(value: string): number[] {
  return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
}
export function readUtf16Text(value: unknown): string {
  requirePlan(
    Array.isArray(value) && value.length <= 65536,
    "invalid_precomposition",
    "Invalid bundle text",
  );
  return value.map((unit) => String.fromCharCode(integer(unit, 0, 65535))).join("");
}

export function validatePrecompositionBundle(
  value: unknown,
  blob: BlobDescriptor,
  resources: readonly string[],
): void {
  const bundle = object(value, PRECOMPOSITION_BUNDLE_FIELDS);
  requirePlan(bundle.kind === "precomposition_bundle", "unknown_variant", "Unknown surface bundle");
  const reference = (value: unknown) => {
    hash(value);
    requirePlan(
      resources.includes(value),
      "missing_resource",
      "Undeclared surface bundle resource",
    );
  };
  reference(bundle.graph);
  requirePlan(
    Array.isArray(bundle.scenes) && bundle.scenes.length <= 10,
    "invalid_precomposition",
    "Surface bundle scene count",
  );
  const ids = new Set<string>();
  let draws = 0;
  for (const value of bundle.scenes) {
    const scene = object(value, [
      "target_id",
      "label_utf16",
      "scene",
      "commands",
      "draw_count",
      "effects",
      "generators",
    ]);
    const id = compositionIdentityToString(scene.target_id);
    requirePlan(!ids.has(id), "invalid_precomposition", "Duplicate bundled scene");
    ids.add(id);
    readUtf16Text(scene.label_utf16);
    reference(scene.scene);
    reference(scene.commands);
    draws += integer(scene.draw_count, 0, 65536);
    requirePlan(
      Array.isArray(scene.effects) &&
        scene.effects.length <= 65536 &&
        Array.isArray(scene.generators) &&
        scene.generators.length <= 65536,
      "invalid_precomposition",
      "Surface bundle dependency count",
    );
    const effects = new Set<string>(),
      generators = new Set<string>();
    for (const value of scene.effects) {
      const status = (value as Record<string, unknown>)?.status;
      requirePlan(
        ["direct", "skipped", "failed", "ready"].includes(String(status)),
        "invalid_precomposition",
        "Unknown effect state",
      );
      const effect = object(value, [
        "instance_id",
        "execution",
        "status",
        ...(status === "failed"
          ? ["error_utf16"]
          : status === "ready"
            ? ["plan", "lut", "label_utf16"]
            : []),
      ]);
      const id = compositionIdentityToString(effect.instance_id);
      requirePlan(!effects.has(id), "invalid_precomposition", "Duplicate bundled effect");
      effects.add(id);
      reference(effect.execution);
      if (status === "failed") readUtf16Text(effect.error_utf16);
      if (status === "ready") {
        reference(effect.plan);
        reference(effect.lut);
        readUtf16Text(effect.label_utf16);
      }
    }
    for (const value of scene.generators) {
      const generator = object(value, ["instance_id", "plan"]),
        id = compositionIdentityToString(generator.instance_id);
      requirePlan(!generators.has(id), "invalid_precomposition", "Duplicate bundled generator");
      generators.add(id);
      reference(generator.plan);
    }
  }
  requirePlan(
    draws <= 65536 &&
      blob.element_type === "u32_le" &&
      blob.element_count === draws + 4 &&
      blob.byte_length === (draws + 4) * 4,
    "invalid_precomposition",
    "Surface bundle draw mapping layout",
  );
}
export function validatePrecompositionBundleBlob(
  bytes: Uint8Array,
  bundle: PrecompositionBundleSlice,
): void {
  const counts = [
    bundle.scenes.length,
    bundle.scenes.reduce((n, s) => n + s.draw_count, 0),
    bundle.scenes.reduce((n, s) => n + s.effects.length, 0),
    bundle.scenes.reduce((n, s) => n + s.generators.length, 0),
  ];
  requirePlan(
    bytes.length === (counts[1] + 4) * 4,
    "invalid_precomposition",
    "Surface bundle draw mapping length",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  counts.forEach((count, index) => {
    requirePlan(
      view.getUint32(index * 4, true) === count,
      "invalid_precomposition",
      "Surface bundle count mismatch",
    );
  });
}
