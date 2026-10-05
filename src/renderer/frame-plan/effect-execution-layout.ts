import { BLEND_MODES, type BlendMode } from "../../core/types";
import { object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";

export const EFFECT_EXECUTION_FIELDS = [
  "kind",
  "blob_index",
  "instance_id",
  "layer_id",
  "route",
  "blend_mode",
  "composite",
];

export function validateEffectExecution(value: unknown, descriptor: unknown) {
  const slice = object(value, EFFECT_EXECUTION_FIELDS);
  compositionIdentityToString(slice.instance_id);
  compositionIdentityToString(slice.layer_id);
  requirePlan(
    BLEND_MODES.includes(slice.blend_mode as BlendMode),
    "invalid_effect_execution",
    "Unknown blend mode",
  );
  const expected =
    slice.route === "layer"
      ? ["normal", "add", "screen"].includes(String(slice.blend_mode))
        ? "fixed"
        : "backdrop"
      : slice.route === "adjustment"
        ? "replace"
        : "none";
  requirePlan(
    ["direct", "layer", "adjustment", "skip"].includes(String(slice.route)) &&
      slice.composite === expected,
    "invalid_effect_execution",
    "Inconsistent effect route/composite",
  );
  requirePlan(
    slice.route !== "direct" || ["normal", "add", "screen"].includes(String(slice.blend_mode)),
    "invalid_effect_execution",
    "Backdrop blending needs isolation",
  );
  const blob = object(descriptor, ["byte_offset", "byte_length", "element_type", "element_count"]);
  requirePlan(
    blob.element_type === "u32_le" && blob.element_count === 4 && blob.byte_length === 16,
    "invalid_effect_execution",
    "Invalid fusion payload",
  );
}

export function validateEffectExecutionBlob(bytes: Uint8Array) {
  requirePlan(bytes.byteLength === 16, "invalid_effect_execution", "Invalid fusion bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fused = view.getUint32(0, true),
    groups = view.getUint32(4, true),
    operations = view.getUint32(12, true);
  requirePlan(
    groups <= fused && fused <= operations && operations <= 64,
    "invalid_effect_execution",
    "Invalid fusion counts",
  );
}
