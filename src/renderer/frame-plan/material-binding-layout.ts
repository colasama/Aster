import { hash, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { MaterialBindingSlice, MaterialTextureReference } from "./types";

export const MATERIAL_BINDING_FIELDS = [
  "kind",
  "blob_index",
  "instance_id",
  "normal",
  "environment",
];

export function validateMaterialBinding(
  value: unknown,
  descriptor: unknown,
  references: unknown,
): void {
  const slice = object(value, MATERIAL_BINDING_FIELDS);
  compositionIdentityToString(slice.instance_id);
  const blob = object(descriptor, ["byte_offset", "byte_length", "element_type", "element_count"]);
  requirePlan(
    blob.element_type === "u8" && blob.byte_length === 24 && blob.element_count === 24,
    "invalid_material_binding",
    "Material binding requires three binary64 scalars",
  );
  requirePlan(Array.isArray(references), "invalid_material_binding", "Missing material resources");
  for (const value of [slice.normal, slice.environment]) {
    const reference = value as MaterialTextureReference;
    requirePlan(
      reference && typeof reference === "object",
      "invalid_material_binding",
      "Missing material reference",
    );
    if (reference.kind === "fallback") object(reference, ["kind"]);
    else {
      object(reference, ["kind", "hash"]);
      requirePlan(
        reference.kind === "texture",
        "invalid_material_binding",
        "Unknown material reference",
      );
      hash(reference.hash);
      requirePlan(
        references.includes(reference.hash),
        "invalid_material_binding",
        "Material hash is undeclared",
      );
    }
  }
  const normal = slice.normal as MaterialTextureReference;
  const environment = slice.environment as MaterialTextureReference;
  requirePlan(
    normal.kind !== "texture" || environment.kind !== "texture" || normal.hash !== environment.hash,
    "invalid_material_binding",
    "Normal and environment roles require distinct resources",
  );
}

export function validateMaterialBindingBlob(bytes: Uint8Array, slice: MaterialBindingSlice): void {
  requirePlan(
    bytes.byteLength === 24,
    "invalid_material_binding",
    "Material scalar payload length differs",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const normal = view.getFloat64(0, true);
  const intensity = view.getFloat64(8, true);
  const rotation = view.getFloat64(16, true);
  requirePlan(
    Number.isFinite(normal) &&
      normal >= -8 &&
      normal <= 8 &&
      Number.isFinite(intensity) &&
      intensity >= 0 &&
      intensity <= 32 &&
      Number.isFinite(rotation) &&
      rotation >= 0 &&
      rotation < 1,
    "invalid_material_binding",
    "Material scalar is nonfinite or out of range",
  );
  requirePlan(
    intensity === 0 || slice.environment.kind === "texture",
    "invalid_material_binding",
    "Lit environment has no texture reference",
  );
}
